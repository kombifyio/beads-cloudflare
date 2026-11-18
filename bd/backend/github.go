package backend

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"time"
)

type githubKey struct {
	Token     string `json:"token"`
	ExpiresAt string `json:"expires_at"`
}
type githubHost struct {
	Trusted bool                 `json:"github_trusted"`
	Github  map[string]githubKey `json:"github"`
}

// Upstream bd loads checkout .beads/.env after package initialization. That
// untrusted file must not grant host trust or redirect the host's identity/cache.
type githubHostEnv struct {
	values            map[string]string
	childEnv          []string
	configDir, ghPath string
	transport         *http.Transport
}

func captureGithubHostEnv() githubHostEnv {
	host := githubHostEnv{values: map[string]string{}, childEnv: os.Environ()}
	for _, item := range host.childEnv {
		if name, value, ok := strings.Cut(item, "="); ok {
			host.values[name] = value
		}
	}
	host.configDir, _ = os.UserConfigDir()
	host.ghPath, _ = exec.LookPath("gh")
	// Freeze proxy configuration and system roots before checkout dotenv can
	// alter HTTPS_PROXY or SSL_CERT_FILE/SSL_CERT_DIR.
	_, _ = http.ProxyFromEnvironment(&http.Request{URL: &url.URL{Scheme: "https", Host: "github.com"}})
	host.transport = http.DefaultTransport.(*http.Transport).Clone()
	if roots, err := x509.SystemCertPool(); err == nil {
		host.transport.TLSClientConfig = &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12}
	}
	return host
}

var githubHostEnvironment = captureGithubHostEnv()

var githubRepositoryPattern = regexp.MustCompile(`^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`)
var tokenPattern = regexp.MustCompile(`^[!-~]+$`)
var beadsTokenEnvPattern = regexp.MustCompile(`^BEADS_CLOUDFLARE_(?:[A-Z0-9_]+_)?TOKEN$`)

func ambientBeadsOriginTrusted(base string) bool {
	origin, err := githubOrigin(base)
	if err != nil {
		return false
	}
	if paired, err := githubOrigin(githubHostEnvironment.values[envBase]); err == nil && paired == origin {
		return true
	}
	for _, value := range strings.Split(githubHostEnvironment.values["BEADS_CLOUDFLARE_TRUSTED_ORIGINS"], ",") {
		if candidate, err := githubOrigin(strings.TrimSpace(value)); err == nil && candidate == origin {
			return true
		}
	}
	if info, err := os.Stat(credentialPath()); err == nil && checkCredentialPermissions(credentialPath(), info) == nil {
		raw, err := os.ReadFile(credentialPath())
		var entries map[string]struct {
			Trusted bool   `json:"github_trusted"`
			Token   string `json:"token"`
		}
		if err == nil && json.Unmarshal(raw, &entries) == nil {
			return entries[origin].Trusted || tokenPattern.MatchString(entries[origin].Token)
		}
	}
	return false
}

func freshGithubCredential(token, expires string) bool {
	expiry, err := time.Parse(time.RFC3339Nano, expires)
	return tokenPattern.MatchString(token) && err == nil && expiry.After(time.Now().Add(time.Minute))
}

func githubOrigin(base string) (string, error) {
	u, err := url.Parse(base)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return "", fmt.Errorf("cloudflare: GitHub exchange needs a store origin without a path or credentials")
	}
	loopback := u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1" || u.Hostname() == "::1"
	if u.Scheme != "https" && !(u.Scheme == "http" && loopback) {
		return "", fmt.Errorf("cloudflare: GitHub exchange requires HTTPS (HTTP is allowed only on loopback)")
	}
	return u.Scheme + "://" + strings.ToLower(u.Host), nil
}

func githubCredential(base, repository, tracker string) (string, error) {
	if !githubRepositoryPattern.MatchString(repository) {
		return "", fmt.Errorf("cloudflare: github_repository must be owner/repository")
	}
	origin, err := githubOrigin(base)
	if err != nil {
		return "", err
	}
	hosts := map[string]githubHost{}
	if info, statErr := os.Stat(credentialPath()); statErr == nil {
		if err := checkCredentialPermissions(credentialPath(), info); err != nil {
			return "", err
		}
		raw, readErr := os.ReadFile(credentialPath())
		if readErr != nil || json.Unmarshal(raw, &hosts) != nil {
			return "", fmt.Errorf("cloudflare: GitHub credential file is unreadable or invalid")
		}
	}
	trusted := hosts[origin].Trusted
	for _, value := range strings.Split(githubHostEnvironment.values["BEADS_CLOUDFLARE_TRUSTED_ORIGINS"], ",") {
		if candidate, err := githubOrigin(strings.TrimSpace(value)); err == nil && candidate == origin {
			trusted = true
		}
	}
	if !trusted {
		return "", fmt.Errorf("cloudflare: GitHub exchange refused: store is not trusted by this host; set BEADS_CLOUDFLARE_TRUSTED_ORIGINS or run join with --trust-store")
	}
	cached := hosts[origin].Github[strings.ToLower(repository)+"#"+tracker]
	if freshGithubCredential(cached.Token, cached.ExpiresAt) {
		return cached.Token, nil
	}
	identity := githubHostEnvironment.values["GH_TOKEN"]
	if identity == "" {
		identity = githubHostEnvironment.values["GITHUB_TOKEN"]
	}
	if githubHostEnvironment.values["ACTIONS_ID_TOKEN_REQUEST_URL"] != "" || githubHostEnvironment.values["ACTIONS_ID_TOKEN_REQUEST_TOKEN"] != "" {
		identity, err = githubOidcIdentity(origin)
		if err != nil {
			return "", err
		}
	}
	if identity == "" && githubHostEnvironment.ghPath != "" {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		command := exec.CommandContext(ctx, githubHostEnvironment.ghPath, "auth", "token", "--hostname", "github.com")
		command.Env = githubHostEnvironment.childEnv
		out, err := command.Output()
		if err == nil {
			identity = strings.TrimSpace(string(out))
		}
	}
	if !tokenPattern.MatchString(identity) {
		return "", fmt.Errorf("cloudflare: no GitHub identity; sign in with gh auth login or provide GH_TOKEN/GITHUB_TOKEN through host credential custody")
	}
	body, _ := json.Marshal(map[string]string{"repository": repository, "tracker": tracker})
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, origin+"/auth/github", bytes.NewReader(body))
	if err != nil {
		return "", fmt.Errorf("cloudflare: GitHub exchange request failed")
	}
	request.Header.Set("Authorization", "Bearer "+identity)
	request.Header.Set("Content-Type", "application/json")
	client := &http.Client{Transport: githubHostEnvironment.transport, Timeout: 15 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return fmt.Errorf("redirect refused") }}
	response, err := client.Do(request)
	if err != nil {
		return "", fmt.Errorf("cloudflare: GitHub exchange failed (network, timeout or redirect)")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return "", fmt.Errorf("cloudflare: GitHub exchange refused (HTTP %d); check repository access and server policy", response.StatusCode)
	}
	var key githubKey
	if json.NewDecoder(io.LimitReader(response.Body, 65536)).Decode(&key) != nil || !tokenPattern.MatchString(key.Token) || !freshGithubCredential(key.Token, key.ExpiresAt) {
		return "", fmt.Errorf("cloudflare: GitHub exchange returned an invalid or expired credential")
	}
	return key.Token, nil
}

func githubOidcIdentity(audience string) (string, error) {
	raw := githubHostEnvironment.values["ACTIONS_ID_TOKEN_REQUEST_URL"]
	bearer := githubHostEnvironment.values["ACTIONS_ID_TOKEN_REQUEST_TOKEN"]
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.User != nil || u.Fragment != "" || !(u.Hostname() == "actions.githubusercontent.com" || strings.HasSuffix(u.Hostname(), ".actions.githubusercontent.com")) || !tokenPattern.MatchString(bearer) {
		return "", fmt.Errorf("cloudflare: GitHub OIDC request URL or runner identity is invalid; grant id-token: write")
	}
	query := u.Query()
	query.Set("audience", audience)
	u.RawQuery = query.Encode()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return "", fmt.Errorf("cloudflare: GitHub OIDC request failed")
	}
	request.Header.Set("Authorization", "Bearer "+bearer)
	client := &http.Client{Transport: githubHostEnvironment.transport, Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return fmt.Errorf("redirect refused") }}
	response, err := client.Do(request)
	if err != nil {
		return "", fmt.Errorf("cloudflare: GitHub OIDC identity request failed")
	}
	defer response.Body.Close()
	var result struct {
		Value string `json:"value"`
	}
	if response.StatusCode != http.StatusOK || json.NewDecoder(io.LimitReader(response.Body, 65536)).Decode(&result) != nil || !tokenPattern.MatchString(result.Value) {
		return "", fmt.Errorf("cloudflare: GitHub OIDC identity request refused; grant id-token: write")
	}
	return result.Value, nil
}
