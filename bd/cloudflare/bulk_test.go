package cloudflare_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	beadsbackend "github.com/steveyegge/beads/backend"

	"github.com/kombifyio/beads-cloudflare/bd/cloudflare"
)

// A bulk listing and the relation reads that follow it (labels, comments, edges,
// counts of the same ids) cost the requests of the listing, not one per issue, and
// the memories ride along in the config read the exporter takes them from.
func TestBulkReadsCostPagesNotIssues(t *testing.T) {
	const issues = 600
	var requests atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		path := strings.TrimPrefix(r.URL.Path, "/t/scratch/v0/beads")
		w.Header().Set("Content-Type", "application/json")
		switch path {
		case "/issues:export":
			start := 0
			if c := r.URL.Query().Get("cursor"); c != "" {
				fmt.Sscanf(c, "after-%d", &start)
			}
			end := min(start+500, issues)
			items := []map[string]any{}
			for i := start; i < end; i++ {
				items = append(items, map[string]any{
					"id": fmt.Sprintf("s-%04d", i), "title": "t", "status": "open", "priority": 2, "issue_type": "task",
					"created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-01T00:00:00Z",
					"labels":   []string{"l"},
					"comments": []map[string]any{{"id": "c", "author": "a", "text": "x", "created_at": "2026-01-02T00:00:00Z"}},
				})
			}
			body := map[string]any{"items": items, "has_more": end < issues}
			if end < issues {
				body["next_cursor"] = fmt.Sprintf("after-%d", end)
			}
			_ = json.NewEncoder(w).Encode(body)
		case "/memories":
			_, _ = w.Write([]byte(`{"items":[{"key":"note","value":"kept"}]}`))
		case "/config":
			_, _ = w.Write([]byte(`{"items":{"issue_prefix":"s"}}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	store, err := cloudflare.New(srv.URL, "scratch", "token", "agent:test", false)
	if err != nil {
		t.Fatal(err)
	}
	store.SetWorkspace(t.TempDir())
	ctx := t.Context()

	found, err := store.SearchIssues(ctx, "", beadsbackend.IssueFilter{})
	if err != nil || len(found) != issues {
		t.Fatalf("search: %d rows, %v", len(found), err)
	}
	ids := make([]string, 0, len(found))
	for _, i := range found {
		ids = append(ids, i.ID)
	}
	labels, err := store.GetLabelsForIssues(ctx, ids)
	if err != nil || len(labels) != issues {
		t.Fatalf("labels: %d, %v", len(labels), err)
	}
	comments, err := store.GetCommentsForIssues(ctx, ids)
	if err != nil || len(comments) != issues || comments[ids[0]][0].IssueID != ids[0] {
		t.Fatalf("comments: %d, %v", len(comments), err)
	}
	if _, err := store.GetCommentCounts(ctx, ids); err != nil {
		t.Fatal(err)
	}
	if got := requests.Load(); got != 2 {
		t.Fatalf("a %d-issue read and its relations took %d requests, want the 2 pages of the listing", issues, got)
	}

	config, err := store.GetAllConfig(ctx)
	if err != nil || config["kv.memory.note"] != "kept" || config["issue_prefix"] != "s" {
		t.Fatalf("config: %v, %v", config, err)
	}
}
