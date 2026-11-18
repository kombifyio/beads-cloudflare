// Package backend registers the Cloudflare store with Beads under the name
// "cloudflare".
//
// Registration is process-start wiring: an embedding binary blank-imports this
// package once, before any store access. A bd build with this backend is
// upstream bd plus that one import, so nothing here forks Beads: the store is
// opened by name through .beads/metadata.json.
package backend

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	beadsbackend "github.com/steveyegge/beads/backend"

	"github.com/kombifyio/beads-cloudflare/bd/cloudflare"
)

// Name is the backend name agents select.
const Name = "cloudflare"

// Environment variables that configure the store.
const (
	envBase    = "BEADS_CLOUDFLARE_BASE"
	envToken   = "BEADS_CLOUDFLARE_TOKEN"
	envActor   = "BEADS_CLOUDFLARE_ACTOR"
	envTracker = "BEADS_CLOUDFLARE_TRACKER"
)

// settings is the connection configuration this backend reads. It lives in
// .beads/cloudflare.json, a tracked file this backend owns, rather than in
// metadata.json: bd rewrites metadata.json from its own typed struct (for
// example on `bd upgrade ack` and in doctor fixes) and that drops every key it
// does not know. metadata.json is still read as a fallback so a workspace that
// predates the sibling file keeps working; it only needs "backend".
type settings struct {
	Backend          string `json:"backend"`
	Tracker          string `json:"tracker"`
	Base             string `json:"base"`
	TokenEnv         string `json:"token_env"`
	GithubRepository string `json:"github_repository"`
}

const settingsFile = "cloudflare.json"

func init() {
	beadsbackend.Register(Name, beadsbackend.Backend{
		Open:                openStore,
		OpenReadOnly:        openReadOnly,
		WorkspaceIsBeadsDir: true,
	})
}

func readSettings(path string) (settings, bool, error) {
	var out settings
	raw, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return out, false, nil
		}
		return out, false, err
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return out, false, fmt.Errorf("%s: %s is not valid JSON: %w", Name, filepath.Base(path), err)
	}
	return out, true, nil
}

// resolve reads the workspace's backend configuration. Precedence is deliberate:
// an explicit environment wins, then .beads/cloudflare.json, then metadata.json,
// so a CI job or a self-hoster can override a checked-in workspace without
// editing it.
func resolve(beadsDir string) (base, tracker, token, actor string, err error) {
	base = os.Getenv(envBase)
	tracker = os.Getenv(envTracker)
	token = os.Getenv(envToken)
	actor = os.Getenv(envActor)

	var tokenEnv, githubRepository string
	for _, name := range []string{settingsFile, "metadata.json"} {
		cfg, found, readErr := readSettings(filepath.Join(beadsDir, name))
		if readErr != nil {
			return "", "", "", "", readErr
		}
		if !found {
			continue
		}
		if cfg.Backend != "" && cfg.Backend != Name {
			return "", "", "", "", fmt.Errorf("%s: %s selects backend %q", Name, name, cfg.Backend)
		}
		if base == "" {
			base = cfg.Base
		}
		if tracker == "" {
			tracker = cfg.Tracker
		}
		if tokenEnv == "" {
			tokenEnv = cfg.TokenEnv
		}
		if githubRepository == "" {
			githubRepository = cfg.GithubRepository
		}
	}
	if tokenEnv != "" && !beadsTokenEnvPattern.MatchString(tokenEnv) {
		return "", "", "", "", fmt.Errorf("cloudflare: token_env must name a BEADS_CLOUDFLARE credential variable; host identity variables are never accepted")
	}
	if token == "" && tokenEnv != "" {
		token = os.Getenv(tokenEnv)
	}

	if tracker == "" {
		// The directory name is arbitrary in a git worktree, so deriving a tracker
		// from it would silently address the wrong tracker.
		return "", "", "", "", fmt.Errorf("%s: no tracker configured; set %s or put {\"tracker\": \"...\"} in %s",
			Name, envTracker, filepath.Join(beadsDir, settingsFile))
	}
	folded, foldErr := cloudflare.NormalizeTracker(tracker)
	if foldErr != nil {
		return "", "", "", "", foldErr
	}
	tracker = folded
	if actor == "" {
		actor = defaultActor()
	}
	if base == "" {
		return "", "", "", "", fmt.Errorf("%s: no base URL; set %s or \"base\" in %s", Name, envBase, filepath.Join(beadsDir, settingsFile))
	}
	if token != "" && !ambientBeadsOriginTrusted(base) {
		return "", "", "", "", fmt.Errorf("cloudflare: host Beads environment credential is not bound to this store origin; configure host trusted origins or pair BEADS_CLOUDFLARE_BASE")
	}
	if token == "" {
		token, err = credentialFromFile(base)
		if err != nil {
			return "", "", "", "", err
		}
	}
	if token == "" && githubRepository != "" {
		token, err = githubCredential(base, githubRepository, tracker)
		if err != nil {
			return "", "", "", "", err
		}
	}
	if token == "" {
		return "", "", "", "", fmt.Errorf("%s: no credential for %s; looked in (1) the environment variable %s or the token_env named in %s, "+
			"(2) %s, which bd loads into the environment, and (3) the per-user credential file %s",
			Name, base, envToken, settingsFile, filepath.Join(beadsDir, ".env"), credentialPath())
	}
	return base, tracker, token, actor, nil
}

// credentialPath is the per-user credential file: a JSON object keyed by base
// URL, {"<base url>": {"token": "..."}}.
func credentialPath() string {
	dir := githubHostEnvironment.configDir
	if dir == "" {
		return "<user config dir>/beads-cloudflare/credentials.json"
	}
	return filepath.Join(dir, "beads-cloudflare", "credentials.json")
}

// credentialFromFile reads the token stored for one base URL. A file other
// accounts can read is refused (file modes on Unix, the DACL on Windows): it
// holds a bearer token. The value is never logged or placed in an error.
func credentialFromFile(base string) (string, error) {
	path := credentialPath()
	info, err := os.Stat(path)
	if err != nil {
		return "", nil
	}
	if err := checkCredentialPermissions(path, info); err != nil {
		return "", err
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("%s: read %s: %w", Name, path, err)
	}
	var byBase map[string]struct {
		Token     string `json:"token"`
		ExpiresAt string `json:"expires_at"`
	}
	if err := json.Unmarshal(raw, &byBase); err != nil {
		return "", fmt.Errorf("%s: %s is not valid JSON: %w", Name, path, err)
	}
	want := strings.TrimRight(base, "/")
	for key, entry := range byBase {
		if strings.TrimRight(key, "/") == want {
			if entry.ExpiresAt != "" && !freshGithubCredential(entry.Token, entry.ExpiresAt) {
				return "", nil
			}
			return entry.Token, nil
		}
	}
	return "", nil
}

func defaultActor() string {
	for _, name := range []string{"USER", "USERNAME"} {
		if v := os.Getenv(name); v != "" {
			return v
		}
	}
	return "bd"
}

func openStore(_ context.Context, beadsDir string) (beadsbackend.DoltStorage, error) {
	return open(beadsDir, false)
}

func openReadOnly(_ context.Context, beadsDir string) (beadsbackend.DoltStorage, error) {
	return open(beadsDir, true)
}

func open(beadsDir string, readOnly bool) (beadsbackend.DoltStorage, error) {
	base, tracker, token, actor, err := resolve(beadsDir)
	if err != nil {
		return nil, err
	}
	store, err := cloudflare.New(base, tracker, token, actor, readOnly)
	if err != nil {
		return nil, err
	}
	store.SetWorkspace(beadsDir)
	return store, nil
}
