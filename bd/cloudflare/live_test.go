package cloudflare_test

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"sync"
	"testing"

	beadsbackend "github.com/steveyegge/beads/backend"
	"github.com/steveyegge/beads/backend/conformance"

	"github.com/kombifyio/beads-cloudflare/bd/cloudflare"
)

// TestLiveConformance runs the upstream portable conformance suite against the
// real Worker, in a scratch tracker.
//
// This is the test that decides whether the mirror can carry authority. RunAll
// drives the store's own methods — issue CRUD, dependencies and readiness,
// labels, comments, transactions, claim and lease — against the live /v0 profile,
// and it fails on any behavior the profile gets wrong. A store that only passes
// the unsupported contract has declared its refusals correctly and nothing more.
//
// It is skipped unless BEADS_CLOUDFLARE_LIVE=1, because it writes to a real
// tracker. Set BEADS_CLOUDFLARE_TRACKER to a scratch name; the suite creates and
// deletes its own fixtures inside it.
func TestLiveConformance(t *testing.T) {
	// A plain `go test ./...` skips: the suite writes to a real tracker, which
	// is not something an ordinary test run may do. The gate sets
	// BEADS_CLOUDFLARE_LIVE=1, and asking for the suite without the credentials
	// to run it is a broken gate, so that combination fails instead of skipping.
	if os.Getenv("BEADS_CLOUDFLARE_LIVE") != "1" {
		t.Skip("set BEADS_CLOUDFLARE_LIVE=1 to run the conformance suite against the live Worker")
	}
	// The suite was asked for, so an incomplete environment is a failure. A skip
	// here would let the gate report success without having checked anything.
	base := os.Getenv("BEADS_CLOUDFLARE_BASE")
	token := os.Getenv("BEADS_CLOUDFLARE_TOKEN")
	tracker := os.Getenv("BEADS_CLOUDFLARE_TRACKER")
	for name, value := range map[string]string{
		"BEADS_CLOUDFLARE_BASE":    base,
		"BEADS_CLOUDFLARE_TOKEN":   token,
		"BEADS_CLOUDFLARE_TRACKER": tracker,
	} {
		if value == "" {
			t.Fatalf("the live suite was requested but %s is not set; skipping here would report a green gate that checked nothing", name)
		}
	}

	conformance.RunAll(t, func(t *testing.T) beadsbackend.DoltStorage {
		store, err := cloudflare.New(base, perSubtestTracker(t, tracker), token, "agent:conformance", false)
		if err != nil {
			t.Fatalf("open the store: %v", err)
		}
		// Clone-local metadata lives in a file under the workspace directory.
		store.SetWorkspace(t.TempDir())
		t.Cleanup(func() { _ = store.Close() })
		return store
	})
}

// perSubtestTracker gives every subtest its own tracker.
//
// The suite's Factory is called once per subtest and each subtest seeds only
// its own fixtures, then asserts on exact counts: testReadyNoDeps creates one
// issue and requires GetReadyWork to return exactly that one. A shared tracker
// therefore makes every count wrong and every unfiltered read grow, because the
// previous subtests' rows are still there.
//
// This is what turned one missing operation into a wall of unrelated failures:
// leaked fixtures made is_blocked true for rows no subtest had blocked, made
// ready sets contain other subtests' issues, and made re-creating a fixed
// fixture id collide. The store was answering correctly for the rows it could
// see; it was being shown a tracker nobody had cleaned.
//
// Subtest names are unique within a run, and the suite creates its fixtures
// inside the tracker, so deriving the name from the subtest is enough to isolate
// it. Trackers are created implicitly on first write.
//
// The suffix is a hash, not the readable name: a tracker id is capped at 40
// characters and the deepest subtests ("SearchPaging/MaxRowsAnswersTheTypedRefusal/
// OverTheCapAnswersTheTypedRefusal/cap3") blow that budget, which the server
// answers as an unknown route.
func perSubtestTracker(t *testing.T, base string) string {
	if encoded := os.Getenv("PAIR_TEST_POOL"); encoded != "" {
		trackerPool.Lock()
		defer trackerPool.Unlock()
		if tracker := trackerPool.used[t.Name()]; tracker != "" {
			return tracker
		}
		var pool []string
		if json.Unmarshal([]byte(encoded), &pool) != nil || len(pool) < 3 || len(trackerPool.used)+2 >= len(pool) {
			t.Fatal("invalid or exhausted finite shared-test tracker pool")
		}
		tracker := pool[len(trackerPool.used)+2]
		if len(tracker) > cloudflare.MaxTrackerID || len(tracker) < 8 || tracker[:8] != "cf-test-" {
			t.Fatal("live conformance pool contains a non-test tracker")
		}
		file, err := os.OpenFile(os.Getenv("PAIR_USED_TRACKERS"), os.O_APPEND|os.O_WRONLY, 0600)
		if err != nil {
			t.Fatalf("record test tracker for cleanup: %v", err)
		}
		line, _ := json.Marshal(tracker)
		_, err = file.Write(append(line, '\n'))
		closeErr := file.Close()
		if err != nil || closeErr != nil {
			t.Fatal("record test tracker for cleanup failed")
		}
		trackerPool.used[t.Name()] = tracker
		return tracker
	}
	sum := sha256.Sum256([]byte(t.Name()))
	suffix := hex.EncodeToString(sum[:6])
	room := cloudflare.MaxTrackerID - len(base) - 1
	if room < len(suffix) {
		t.Fatalf("tracker base %q leaves no room for a per-subtest suffix within the %d character limit", base, cloudflare.MaxTrackerID)
	}
	return base + "-" + suffix
}

var trackerPool = struct {
	sync.Mutex
	used map[string]string
}{used: make(map[string]string)}
