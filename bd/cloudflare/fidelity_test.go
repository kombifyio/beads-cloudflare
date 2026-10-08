package cloudflare_test

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	beadsbackend "github.com/steveyegge/beads/backend"
	"github.com/steveyegge/beads/issueops"

	"github.com/kombifyio/beads-cloudflare/bd/cloudflare"
)

// call is one request the fake server saw.
type call struct {
	Method, Path string
	Query        map[string][]string
	Header       http.Header
	Body         map[string]any
}

// fake is a Worker stand-in: it records every request and answers from a table.
type fake struct {
	t       *testing.T
	mu      sync.Mutex
	calls   []call
	handler func(c call) (status int, body any)
	caps    []string
}

func newFake(t *testing.T, handler func(c call) (int, any)) (*fake, *cloudflare.Store) {
	t.Helper()
	f := &fake{t: t, handler: handler, caps: []string{"profile.import_merge", "profile.x_extra", "profile.apply_batch_extensions"}}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		c := call{Method: r.Method, Path: strings.TrimPrefix(r.URL.Path, "/t/scratch/v0/beads"), Query: r.URL.Query(), Header: r.Header}
		if len(raw) > 0 {
			_ = json.Unmarshal(raw, &c.Body)
		}
		f.mu.Lock()
		f.calls = append(f.calls, c)
		f.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		if c.Path == "/context" {
			_ = json.NewEncoder(w).Encode(map[string]any{"capabilities": f.caps})
			return
		}
		status, body := 200, any(map[string]any{})
		if f.handler != nil {
			status, body = f.handler(c)
		}
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(body)
	}))
	t.Cleanup(srv.Close)
	store, err := cloudflare.New(srv.URL, "scratch", "token", "agent:test", false)
	if err != nil {
		t.Fatal(err)
	}
	store.SetWorkspace(t.TempDir())
	return f, store
}

// writes returns the mutating requests seen so far.
func (f *fake) writes() []call {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []call
	for _, c := range f.calls {
		if c.Method != http.MethodGet {
			out = append(out, c)
		}
	}
	return out
}

func problem(status int, code, detail string) (int, any) {
	return status, map[string]any{"status": status, "code": code, "detail": detail}
}

// Every member of a create request either arrives at the server under its wire
// name or the request is refused before anything is written. Silent loss of a
// field is the failure this guards: the tracker holds the organization's work.
func TestCreateCarriesEveryFieldOrRefuses(t *testing.T) {
	at := func(h int) *time.Time { v := time.Date(2026, 1, 2, h, 0, 0, 0, time.UTC); return &v }
	est := 90
	ref := "gh-7"
	f, store := newFake(t, func(c call) (int, any) {
		return 200, map[string]any{"id": "t-1", "title": "x", "status": "open", "priority": 1, "issue_type": "task"}
	})
	role, err := store.IssueLifecycle()
	if err != nil {
		t.Fatal(err)
	}

	issue := &beadsbackend.Issue{
		ID: "t-1", Title: "title", Description: "desc", Design: "design", AcceptanceCriteria: "ac", Notes: "notes",
		SpecID: "spec-1", Status: "open", Priority: 1, IssueType: "task", Assignee: "ann", Owner: "bob",
		EstimatedMinutes: &est, CreatedAt: *at(1), CreatedBy: "carol", StartedAt: at(2), DueAt: at(3), DeferUntil: at(4),
		ExternalRef: &ref, SourceSystem: "jira", Metadata: json.RawMessage(`{"k":"v"}`), Labels: []string{"a", "b"},
		Sender: "dave", NoHistory: true, WispType: "ping", StorageClass: "unversioned", Pinned: true, IsTemplate: true,
		BondedFrom: []beadsbackend.BondRef{{SourceID: "p-1", BondType: "parallel", BondPoint: "t-9"}},
		AwaitType:  "timer", AwaitID: "await-1", Timeout: 5 * time.Second, Waiters: []string{"w@x"},
		SourceFormula: "formula", SourceLocation: "steps[0]", MolType: "swarm", WorkType: "mutex",
		EventKind: "patrol.muted", Actor: "agent://x", Target: "t-2", Payload: `{"p":1}`,
	}
	_, err = role.Create(t.Context(), issueops.CreateRequest{
		Actor: "agent:test", Issue: issue, ParentID: "t-0", InheritLabelsFromParent: true, ForceIDPrefix: true,
		Dependencies: []issueops.CreateDependency{{TargetID: "t-5", Type: "blocks", Reverse: true, Metadata: `{"m":1}`}},
		WaitsFor:     &issueops.WaitsFor{SpawnerID: "t-6", Gate: "any-children"},
	})
	if err != nil {
		t.Fatal(err)
	}
	posts := f.writes()
	if len(posts) != 1 || posts[0].Path != "/issues" {
		t.Fatalf("want one create request, got %+v", posts)
	}
	want := map[string]any{
		"actor": "agent:test", "id": "t-1", "title": "title", "description": "desc", "design": "design",
		"acceptance_criteria": "ac", "notes": "notes", "status": "open", "priority": float64(1), "issue_type": "task",
		"assignee": "ann", "owner": "bob", "estimated_minutes": float64(90), "external_ref": "gh-7",
		"due_at": "2026-01-02T03:00:00Z", "defer_until": "2026-01-02T04:00:00Z", "metadata": map[string]any{"k": "v"},
		"labels": []any{"a", "b"}, "sender": "dave", "no_history": true, "parent_id": "t-0",
		"inherit_labels_from_parent": true, "force_id_prefix": true,
		"dependencies":        []any{map[string]any{"target_id": "t-5", "type": "blocks", "reverse": true, "metadata": map[string]any{"m": float64(1)}}},
		"waits_for":           map[string]any{"spawner_id": "t-6", "gate": "any-children"},
		"preserve_timestamps": true, "created_at": "2026-01-02T01:00:00Z", "started_at": "2026-01-02T02:00:00Z",
		"original_created_by": "carol",
		"x_extra": map[string]any{
			"spec_id": "spec-1", "source_system": "jira", "wisp_type": "ping", "storage_class": "unversioned",
			"pinned": true, "is_template": true, "await_type": "timer", "await_id": "await-1", "timeout": float64(5 * time.Second),
			"waiters": []any{"w@x"}, "source_formula": "formula", "source_location": "steps[0]", "mol_type": "swarm",
			"work_type": "mutex", "event_kind": "patrol.muted", "actor": "agent://x", "target": "t-2", "payload": `{"p":1}`,
			"bonded_from": []any{map[string]any{"source_id": "p-1", "bond_type": "parallel", "bond_point": "t-9"}},
		},
	}
	if !reflect.DeepEqual(posts[0].Body, want) {
		got, _ := json.MarshalIndent(posts[0].Body, "", " ")
		exp, _ := json.MarshalIndent(want, "", " ")
		t.Fatalf("the create body differs from the expected wire members\n got: %s\nwant: %s", got, exp)
	}

	// A member the wire has no place for refuses the request, and nothing is sent.
	for name, mutate := range map[string]func(*beadsbackend.Issue){
		"close_reason":      func(i *beadsbackend.Issue) { i.CloseReason = "done" },
		"closed_by_session": func(i *beadsbackend.Issue) { i.ClosedBySession = "s" },
		"comments":          func(i *beadsbackend.Issue) { i.Comments = []*beadsbackend.Comment{{Text: "x"}} },
		"dependencies":      func(i *beadsbackend.Issue) { i.Dependencies = []*beadsbackend.Dependency{{DependsOnID: "t-3"}} },
		"updated_at":        func(i *beadsbackend.Issue) { i.UpdatedAt = time.Date(2030, 1, 1, 0, 0, 0, 0, time.UTC) },
	} {
		before := len(f.writes())
		bad := &beadsbackend.Issue{ID: "t-2", Title: "x", Priority: 2, IssueType: "task"}
		mutate(bad)
		if _, err := role.Create(t.Context(), issueops.CreateRequest{Actor: "agent:test", Issue: bad}); err == nil {
			t.Fatalf("%s: the create was accepted, so the member was dropped", name)
		}
		if got := len(f.writes()); got != before {
			t.Fatalf("%s: a refused create still sent %d request(s)", name, got-before)
		}
	}
}

// An update that claims and patches is validated before the claim, and a patch
// the server refuses after the claim gives the claim back, so a failed command
// leaves no claim behind.
func TestClaimAndPatchLeaveNoClaimBehindOnFailure(t *testing.T) {
	f, store := newFake(t, func(c call) (int, any) {
		switch {
		case c.Method == http.MethodGet:
			return 200, map[string]any{"id": "t-1", "title": "x", "status": "open", "priority": 2, "issue_type": "task", "revision": "7"}
		case strings.HasSuffix(c.Path, ":claim"):
			return 200, map[string]any{"issue": map[string]any{"id": "t-1", "status": "in_progress", "assignee": "agent:test"}, "already_claimed": false, "x_fencing_token": 5}
		case c.Method == http.MethodPatch:
			return problem(400, "invalid_argument", "the status is not one this workspace knows")
		case strings.HasSuffix(c.Path, ":release"):
			return 200, map[string]any{"issue": map[string]any{"id": "t-1", "status": "open"}, "changed": true, "revision": "9"}
		}
		return 200, map[string]any{}
	})
	role, _ := store.IssueLifecycle()

	// Refused by the client: no claim, no patch.
	_, err := role.Update(t.Context(), issueops.UpdateRequest{Actor: "agent:test", IssueID: "t-1", Claim: true,
		Patch: issueops.IssuePatch{Metadata: issueops.MetadataPatch{Replace: issueops.Field[json.RawMessage]{Set: true, Value: json.RawMessage(`[]`)}}}})
	if !errors.Is(err, beadsbackend.ErrValidation) {
		t.Fatalf("an invalid metadata patch must be refused as a validation error, got %v", err)
	}
	if n := len(f.writes()); n != 0 {
		t.Fatalf("a refused update sent %d write(s)", n)
	}

	// Refused by the server after the claim: the claim is released and the
	// caller sees the original error.
	_, err = role.Update(t.Context(), issueops.UpdateRequest{Actor: "agent:test", IssueID: "t-1", Claim: true,
		Patch: issueops.IssuePatch{Status: issueops.Field[issueops.Status]{Set: true, Value: "bogus"}}})
	if err == nil || !strings.Contains(err.Error(), "not one this workspace knows") {
		t.Fatalf("the original error must be returned, got %v", err)
	}
	var verbs []string
	for _, w := range f.writes() {
		verbs = append(verbs, w.Method+" "+w.Path)
	}
	want := []string{"POST /issues/t-1:claim", "PATCH /issues/t-1", "POST /issues/t-1:release"}
	if !reflect.DeepEqual(verbs, want) {
		t.Fatalf("writes %v, want %v", verbs, want)
	}
	if ws := f.writes(); ws[2].Body["x_fencing_token"] != float64(5) {
		t.Fatalf("the release must carry the claim's fencing token so a newer claim is left alone: %v", ws[2].Body)
	}

	// A stale version guard on a claim-only update refuses before the claim.
	before := len(f.writes())
	stale := int64(3)
	_, err = role.Update(t.Context(), issueops.UpdateRequest{Actor: "agent:test", IssueID: "t-1", Claim: true, ExpectedVersion: &stale})
	if !errors.Is(err, issueops.ErrVersionMismatch) {
		t.Fatalf("a stale version must refuse the claim, got %v", err)
	}
	if len(f.writes()) != before {
		t.Fatal("a claim with a stale version guard was still sent")
	}
}

// A transaction whose callback fails leaves the store unchanged: nothing is
// sent, comments, dependency removals and settings included; and one that
// succeeds sends every write in one atomic plan.
func TestTransactionIsOnePlanOrNothing(t *testing.T) {
	f, store := newFake(t, func(c call) (int, any) { return 200, map[string]any{"keys": map[string]string{}, "items": []any{}} })
	boom := errors.New("callback failed")
	err := store.RunInTransaction(t.Context(), "msg", func(tx beadsbackend.Transaction) error {
		ctx := t.Context()
		if err := tx.AddComment(ctx, "t-1", "agent:test", "hello"); err != nil {
			return err
		}
		if err := tx.RemoveDependency(ctx, "t-1", "t-2", "agent:test"); err != nil {
			return err
		}
		if err := tx.SetConfig(ctx, "custom.k", "v"); err != nil {
			return err
		}
		return boom
	})
	if !errors.Is(err, boom) || len(f.writes()) != 0 {
		t.Fatalf("a failing callback must send nothing: err=%v writes=%d", err, len(f.writes()))
	}

	err = store.RunInTransaction(t.Context(), "msg", func(tx beadsbackend.Transaction) error {
		ctx := t.Context()
		for _, step := range []error{
			tx.AddComment(ctx, "t-1", "agent:test", "hello"),
			tx.RemoveDependency(ctx, "t-1", "t-2", "agent:test"),
			tx.SetConfig(ctx, "custom.k", "v"),
		} {
			if step != nil {
				return step
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	posts := f.writes()
	if len(posts) != 1 || posts[0].Path != "/issues:batchApply" {
		t.Fatalf("want one batchApply request, got %+v", posts)
	}
	var kinds []string
	for _, it := range posts[0].Body["items"].([]any) {
		kinds = append(kinds, it.(map[string]any)["kind"].(string))
	}
	if !reflect.DeepEqual(kinds, []string{"x_comment", "x_dep_remove", "x_set_config"}) {
		t.Fatalf("plan kinds %v", kinds)
	}
}

// A merge import is the only import route: it sends mode "merge" with the stale
// guard, reports stale ids and dropped edges through upstream's callbacks, and a
// server without the capability is refused before any write.
func TestImportIsAMergeAndRefusesWithoutTheCapability(t *testing.T) {
	f, store := newFake(t, func(c call) (int, any) {
		return 200, map[string]any{
			"mode": "merge", "issues": map[string]any{"created": 1, "updated": 0, "unchanged": 0, "skipped_stale": 1},
			"skipped_stale_ids": []string{"t-old"}, "skipped_dependencies": []map[string]string{{"issue_id": "t-1", "depends_on_id": "t-x", "reason": "target not found"}},
		}
	})
	var stale, skipped []string
	issues := []*beadsbackend.Issue{
		{ID: "t-1", Title: "one", Status: "open", Priority: 2, IssueType: "task", Labels: []string{"l"},
			Comments: []*beadsbackend.Comment{{Author: "a", Text: "c", CreatedAt: time.Now()}}},
		{ID: "t-old", Title: "old", Status: "open", Priority: 2, IssueType: "task", UpdatedAt: time.Now()},
	}
	err := store.CreateIssuesWithFullOptions(t.Context(), issues, "agent:test", beadsbackend.BatchCreateOptions{
		RejectStaleUpserts: true, SkipDependencyValidationErrors: true,
		OnStaleRejected:     func(id string) { stale = append(stale, id) },
		OnSkippedDependency: func(a, b, why string) { skipped = append(skipped, a+">"+b+":"+why) },
	})
	if err != nil {
		t.Fatal(err)
	}
	ws := f.writes()
	if len(ws) != 1 || ws[0].Path != "/issues:import" || ws[0].Body["mode"] != "merge" || ws[0].Body["reject_stale"] != true {
		t.Fatalf("import request %+v", ws)
	}
	if rec := ws[0].Body["issues"].([]any)[0].(map[string]any); rec["created_at"] == nil || strings.HasPrefix(fmt.Sprint(rec["created_at"]), "0001") || rec["comments"] == nil || rec["labels"] == nil {
		t.Fatalf("the record lost members, or has no age or a year-one one: %v", rec)
	}
	if !reflect.DeepEqual(stale, []string{"t-old"}) || !reflect.DeepEqual(skipped, []string{"t-1>t-x:target not found"}) {
		t.Fatalf("callbacks: stale=%v skipped=%v", stale, skipped)
	}

	f.caps = []string{"profile.import"}
	f2, store2 := newFake(t, nil)
	f2.caps = []string{"profile.import"}
	err = store2.CreateIssuesWithFullOptions(t.Context(), issues, "agent:test", beadsbackend.BatchCreateOptions{SkipDependencyValidationErrors: true})
	var unsupported *beadsbackend.ErrUnsupported
	if !errors.As(err, &unsupported) || !strings.Contains(err.Error(), "profile.import_merge") {
		t.Fatalf("want a typed refusal naming the capability, got %v", err)
	}
	if n := len(f2.writes()); n != 0 {
		t.Fatalf("a refused import wrote %d time(s)", n)
	}
}

// A read of more rows than any fixed cap returns every one of them, and a filter
// applies before the limit, so a match that lies behind the cap is still found.
func TestSearchReadsEveryPage(t *testing.T) {
	const total = 10500
	_, store := newFake(t, func(c call) (int, any) {
		if c.Path != "/issues:export" {
			return problem(404, "not_found", "no such route")
		}
		start := 0
		if v := c.Query["cursor"]; len(v) > 0 {
			fmt.Sscanf(v[0], "after-%d", &start)
		}
		end := min(start+500, total)
		items := make([]map[string]any, 0, 500)
		for i := start; i < end; i++ {
			title := "plain"
			if i == total-1 {
				title = "needle"
			}
			items = append(items, map[string]any{"id": fmt.Sprintf("s-%05d", i), "title": title, "status": "open", "priority": 2,
				"issue_type": "task", "created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-01T00:00:00Z"})
		}
		body := map[string]any{"items": items, "has_more": end < total}
		if end < total {
			body["next_cursor"] = fmt.Sprintf("after-%d", end)
		}
		return 200, body
	})
	all, err := store.SearchIssues(t.Context(), "", beadsbackend.IssueFilter{})
	if err != nil || len(all) != total {
		t.Fatalf("an unlimited search returned %d of %d rows (%v)", len(all), total, err)
	}
	hit, err := store.SearchIssues(t.Context(), "", beadsbackend.IssueFilter{TitleContains: "needle", Limit: 1})
	if err != nil || len(hit) != 1 || hit[0].ID != fmt.Sprintf("s-%05d", total-1) {
		t.Fatalf("the only match lay beyond the old cap and was not found: %v %v", hit, err)
	}
}

// A singular open selector for ready work means open plus the custom statuses of
// category active, as upstream defines it; any other selector stays exact.
func TestReadyOpenIncludesActiveCustomStatuses(t *testing.T) {
	_, store := newFake(t, func(c call) (int, any) {
		switch c.Path {
		case "/config:statuses:detailed":
			return 200, map[string]any{"statuses": []map[string]any{{"name": "triaged", "category": "active"}, {"name": "parked", "category": "frozen"}}}
		case "/ready":
			row := func(id, status string) map[string]any {
				return map[string]any{"id": id, "title": id, "status": status, "priority": 2, "issue_type": "task",
					"created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-01T00:00:00Z"}
			}
			return 200, map[string]any{"items": []any{row("t-1", "open"), row("t-2", "triaged"), row("t-3", "in_progress")}, "has_more": false}
		}
		return 200, map[string]any{}
	})
	ids := func(f beadsbackend.WorkFilter) string {
		got, err := store.GetReadyWork(t.Context(), f)
		if err != nil {
			t.Fatal(err)
		}
		var out []string
		for _, i := range got {
			out = append(out, i.ID)
		}
		return strings.Join(out, ",")
	}
	if got := ids(beadsbackend.WorkFilter{Status: beadsbackend.StatusOpen}); got != "t-1,t-2" {
		t.Fatalf("open selector kept %q, want the open and the triaged issue", got)
	}
	if got := ids(beadsbackend.WorkFilter{Status: beadsbackend.StatusInProgress}); got != "t-3" {
		t.Fatalf("an other selector must stay exact, kept %q", got)
	}
}
