package backend

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestGithubExchangeTrustAndScopedCredential(t *testing.T) {
	t.Setenv("GH_TOKEN", "fixture-identity")
	t.Setenv("ACTIONS_ID_TOKEN_REQUEST_URL", "")
	t.Setenv("ACTIONS_ID_TOKEN_REQUEST_TOKEN", "")
	t.Setenv("APPDATA", t.TempDir())
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	previousHost := githubHostEnvironment
	t.Cleanup(func() { githubHostEnvironment = previousHost })
	contacted := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		contacted = true
		if r.URL.Path != "/auth/github" || r.Method != http.MethodPost || r.Header.Get("Authorization") != "Bearer fixture-identity" {
			t.Error("exchange identity or route differs")
		}
		var body map[string]string
		if json.NewDecoder(r.Body).Decode(&body) != nil || body["repository"] != "team/project" || body["tracker"] != "project" {
			t.Error("exchange lost repository scope")
		}
		_ = json.NewEncoder(w).Encode(map[string]string{"token": "scoped-fixture", "expires_at": time.Now().Add(time.Hour).Format(time.RFC3339)})
	}))
	defer server.Close()
	t.Setenv("BEADS_CLOUDFLARE_TRUSTED_ORIGINS", "")
	githubHostEnvironment = captureGithubHostEnv()
	if _, err := githubCredential(server.URL, "team/project", "project"); err == nil || contacted {
		t.Fatal("untrusted store received a host credential")
	}
	t.Setenv("BEADS_CLOUDFLARE_TRUSTED_ORIGINS", server.URL)
	githubHostEnvironment = captureGithubHostEnv()
	token, err := githubCredential(server.URL, "team/project", "project")
	if err != nil || token != "scoped-fixture" || !contacted {
		t.Fatalf("authorized exchange failed: %v", err)
	}
}

func TestGithubOidcRejectsUntrustedRunnerEndpoint(t *testing.T) {
	t.Setenv("ACTIONS_ID_TOKEN_REQUEST_URL", "https://attacker.example/identity")
	t.Setenv("ACTIONS_ID_TOKEN_REQUEST_TOKEN", "runner-fixture")
	previousHost := githubHostEnvironment
	githubHostEnvironment = captureGithubHostEnv()
	t.Cleanup(func() { githubHostEnvironment = previousHost })
	if _, err := githubOidcIdentity("https://beads.example.com"); err == nil {
		t.Fatal("untrusted runner endpoint was accepted")
	}
}

func TestCheckoutDotenvCannotGrantGithubHostTrust(t *testing.T) {
	t.Setenv("BEADS_CLOUDFLARE_TRUSTED_ORIGINS", "")
	t.Setenv("APPDATA", t.TempDir())
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	previousHost := githubHostEnvironment
	githubHostEnvironment = captureGithubHostEnv()
	t.Cleanup(func() { githubHostEnvironment = previousHost })
	protectedConfig := credentialPath()
	// Simulate upstream's later checkout dotenv changes before backend open.
	t.Setenv("BEADS_CLOUDFLARE_TRUSTED_ORIGINS", "https://attacker.example")
	t.Setenv("GH_TOKEN", "injected-fixture")
	t.Setenv("APPDATA", t.TempDir())
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	if credentialPath() != protectedConfig {
		t.Fatal("checkout dotenv redirected host credential custody")
	}
	if _, err := githubCredential("https://attacker.example", "team/project", "project"); err == nil {
		t.Fatal("checkout dotenv authorized a hostile exchange origin")
	}
}

func TestUntrustedRepositoryCannotRouteAmbientCredentials(t *testing.T) {
	t.Setenv("GH_TOKEN", "private-host-fixture")
	t.Setenv("BEADS_CLOUDFLARE_BASE", "")
	t.Setenv("BEADS_CLOUDFLARE_TRUSTED_ORIGINS", "")
	previousHost := githubHostEnvironment
	t.Cleanup(func() { githubHostEnvironment = previousHost })
	for _, tokenEnv := range []string{"GH_TOKEN", "BEADS_CLOUDFLARE_TOKEN"} {
		t.Setenv("BEADS_CLOUDFLARE_TOKEN", "")
		if tokenEnv == "BEADS_CLOUDFLARE_TOKEN" {
			t.Setenv(tokenEnv, "private-host-fixture")
		}
		githubHostEnvironment = captureGithubHostEnv()
		githubHostEnvironment.configDir = t.TempDir()
		dir := t.TempDir()
		raw, _ := json.Marshal(map[string]string{"base": "https://attacker.example", "tracker": "project", "token_env": tokenEnv})
		if err := os.WriteFile(filepath.Join(dir, "cloudflare.json"), raw, 0600); err != nil {
			t.Fatal(err)
		}
		_, _, token, _, err := resolve(dir)
		if err == nil || token != "" || strings.Contains(err.Error(), "private-host-fixture") {
			t.Fatal("untrusted repository resolved or exposed an ambient host credential")
		}
	}
}
