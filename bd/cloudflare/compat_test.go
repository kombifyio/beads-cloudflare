package cloudflare_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/kombifyio/beads-cloudflare/bd/cloudflare"
)

var allCapabilities = []string{
	"profile.beads-cloudflare", "profile.idempotency_key", "issues.batchApply", "issues.close",
	"issues.create", "issues.get", "issues.list", "issues.update", "ready.list",
}

// A bd and a store that do not fit together must fail at connect with one line that
// names both versions and the command that fixes it, and a store that is merely newer
// must keep working. The rule is in docs/compatibility.md.
func TestConnectRefusesAMismatchedPairWithOneLine(t *testing.T) {
	previous := cloudflare.Version
	t.Cleanup(func() { cloudflare.Version = previous })

	var contextReads atomic.Int32
	serve := func(doc map[string]any) *cloudflare.Store {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			if strings.HasSuffix(r.URL.Path, "/context") {
				contextReads.Add(1)
				_ = json.NewEncoder(w).Encode(doc)
				return
			}
			_, _ = w.Write([]byte(`{"id":"scratch-1","title":"x","status":"open","priority":2,"issue_type":"task"}`))
		}))
		t.Cleanup(srv.Close)
		store, err := cloudflare.New(srv.URL, "scratch", "token", "agent:test", false)
		if err != nil {
			t.Fatal(err)
		}
		store.SetWorkspace(t.TempDir())
		return store
	}
	read := func(store *cloudflare.Store) error {
		_, err := store.GetIssue(context.Background(), "scratch-1")
		return err
	}

	cloudflare.Version = "0.2.1"

	// A store from before versions were published, and one that lacks a capability.
	err := read(serve(map[string]any{"capabilities": allCapabilities}))
	if err == nil || strings.Contains(err.Error(), "\n") ||
		!strings.Contains(err.Error(), "0.2.1") || !strings.Contains(err.Error(), "predates") ||
		!strings.Contains(err.Error(), "npx --yes github:kombifyio/beads-cloudflare#v0.2.1 setup") {
		t.Fatalf("an unversioned store: want one line naming both sides and the store update command, got %v", err)
	}
	err = read(serve(map[string]any{"x_store_version": "0.1.0", "capabilities": allCapabilities[1:]}))
	if err == nil || !strings.Contains(err.Error(), "0.1.0") || !strings.Contains(err.Error(), "profile.beads-cloudflare") || !strings.Contains(err.Error(), "setup") {
		t.Fatalf("a store lacking a capability: got %v", err)
	}

	// A store that demands a newer bd names the bd update command, pinned to the store's version.
	err = read(serve(map[string]any{"x_store_version": "0.3.4", "x_min_client_version": "0.3.0", "capabilities": allCapabilities}))
	if err == nil || strings.Contains(err.Error(), "\n") ||
		!strings.Contains(err.Error(), "npx --yes github:kombifyio/beads-cloudflare#v0.3.4 join http://") {
		t.Fatalf("a store that needs a newer bd: got %v", err)
	}

	// Newer stores on the same minor line, and newer minors that do not raise the floor, are fine.
	for _, doc := range []map[string]any{
		{"x_store_version": "0.2.9", "x_min_client_version": "0.2.0", "capabilities": allCapabilities},
		{"x_store_version": "0.4.0", "x_min_client_version": "0.1.0", "capabilities": append([]string{"issues.future"}, allCapabilities...)},
	} {
		if err := read(serve(doc)); err != nil {
			t.Fatalf("store %v should work with bd 0.2.1: %v", doc["x_store_version"], err)
		}
	}

	// The verdict is read once per process.
	store := serve(map[string]any{"x_store_version": "0.2.2", "capabilities": allCapabilities})
	before := contextReads.Load()
	for i := 0; i < 3; i++ {
		if err := read(store); err != nil {
			t.Fatal(err)
		}
	}
	if n := contextReads.Load() - before; n != 1 {
		t.Fatalf("the context was read %d times for three requests; want once", n)
	}

	// A handshake that cannot be completed never lets the operation through: a transient failure is
	// retried, and a persistent one fails the command before anything is sent.
	var flaky, operations atomic.Int32
	failing := func(failures int32) *cloudflare.Store {
		flaky.Store(0)
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			if strings.HasSuffix(r.URL.Path, "/context") {
				if flaky.Add(1) <= failures {
					w.WriteHeader(http.StatusServiceUnavailable)
					_, _ = w.Write([]byte(`{"status":503,"code":"unavailable","detail":"try later"}`))
					return
				}
				_ = json.NewEncoder(w).Encode(map[string]any{"x_store_version": "0.2.2", "capabilities": allCapabilities})
				return
			}
			operations.Add(1)
			_, _ = w.Write([]byte(`{"id":"scratch-1","title":"x","status":"open","priority":2,"issue_type":"task"}`))
		}))
		t.Cleanup(srv.Close)
		s, err := cloudflare.New(srv.URL, "scratch", "token", "agent:test", false)
		if err != nil {
			t.Fatal(err)
		}
		s.SetWorkspace(t.TempDir())
		return s
	}
	if err := read(failing(2)); err != nil {
		t.Fatalf("a handshake that fails twice and then answers should pass: %v", err)
	}
	operations.Store(0)
	err = read(failing(1000))
	if err == nil || strings.Contains(err.Error(), "\n") || !strings.Contains(err.Error(), "could not be reached for the version check") || operations.Load() != 0 {
		t.Fatalf("a store whose handshake never completes must fail the command before any operation: err=%v operations=%d", err, operations.Load())
	}
}
