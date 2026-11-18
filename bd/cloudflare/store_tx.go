package cloudflare

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/steveyegge/beads/backend"
	"github.com/steveyegge/beads/issueops"
)

// RunInTransaction maps a transaction closure onto the store's one atomic write,
// issues:batchApply. The closure runs against a recorder: every write is queued as
// an item of one plan, reads go straight to the store, and when the closure
// returns nil the plan is submitted as a single request that applies whole or not
// at all. A closure that returns an error submits nothing, so the store is left
// exactly as it was: no write of any kind (settings and comments included) takes
// effect before the plan lands.
//
// The plan has an item for every write a transaction makes: create, update, close,
// dependency add and remove, comment and setting write. What no item can express
// (deleting an issue, a memory write, a comment with a past timestamp) is refused
// at the call that asks for it, so the closure fails and nothing is written. A read
// inside the closure does not see the closure's own earlier writes. A created
// issue without an id gets a placeholder id until the plan lands; later items that
// name it are sent as references to its item, and its *Issue carries the real id
// when the plan has landed.

const forceClosePolicyKey = "_force_close_policy"

// pendingPrefix marks the placeholder id of an issue created in this plan.
const pendingPrefix = "bdcf-pending-"

type planTx struct {
	s       *Store
	ctx     context.Context
	actor   string
	items   []map[string]any
	created map[string]*backend.Issue
	// local holds writes to the clone-local plane; they run only once the plan has
	// landed, so a failed callback leaves them untouched too.
	local []func(context.Context) error
}

func (s *Store) RunInTransaction(ctx context.Context, commitMsg string, fn func(backend.Transaction) error) error {
	if err := s.writeRefused("RunInTransaction"); err != nil {
		return err
	}
	if err := s.checkOpen("RunInTransaction"); err != nil {
		return err
	}
	tx := &planTx{s: s, ctx: ctx, created: map[string]*backend.Issue{}}
	if err := fn(tx); err != nil {
		return err
	}
	if len(tx.items) > issueops.MaxApplyBatchItems {
		return fmt.Errorf("transaction has %d writes; one plan holds at most %d: %w", len(tx.items), issueops.MaxApplyBatchItems, backend.ErrValidation)
	}
	if len(tx.items) > 0 {
		res, err := s.postBatch(WithActor(ctx, tx.actor), issueops.ApplyBatchRequest{Actor: tx.actor, Provenance: commitMsg, ForceIDPrefix: true}, tx.items)
		if err != nil {
			return err
		}
		for key, issue := range tx.created {
			id, ok := res.Keys[key]
			if !ok {
				return fmt.Errorf("the plan landed but did not report the id of the issue it created for %q: %w", issue.Title, backend.ErrValidation)
			}
			issue.ID = id
		}
	}
	for _, step := range tx.local {
		if err := step(ctx); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) RunInIssueLifecycleTransaction(ctx context.Context, commitMsg string, fn func(backend.IssueLifecycleTransaction) error) error {
	return s.RunInTransaction(ctx, commitMsg, func(tx backend.Transaction) error {
		return fn(&lifecycleTx{planTx: tx.(*planTx)})
	})
}

type lifecycleTx struct{ *planTx }

func (t *lifecycleTx) ReopenIssueWithResult(ctx context.Context, id, reason, actor string) (bool, error) {
	if reason != "" {
		// The plan has no reopen item, and a status update carries no reason.
		return false, unsupportedField("Transaction.ReopenIssueWithResult", "reason")
	}
	before, err := t.s.readIssue(ctx, id)
	if err != nil {
		return false, err
	}
	changed := before.Status == backend.StatusClosed
	return changed, t.UpdateIssue(ctx, id, map[string]interface{}{"status": string(backend.StatusOpen)}, actor)
}

func (t *planTx) note(actor string) {
	if actor != "" {
		t.actor = actor
	}
}

// ref names an issue in a plan: by id, or by the key of the item that creates it.
func (t *planTx) ref(id string) (wireRef, error) {
	switch {
	case id == "":
		return wireRef{}, invalidf("a plan item names no issue")
	case strings.HasPrefix(id, pendingPrefix):
		return wireRef{Key: strings.TrimPrefix(id, pendingPrefix)}, nil
	}
	return wireRef{ID: id}, nil
}

func (t *planTx) add(kind string, body map[string]any) {
	t.items = append(t.items, map[string]any{"kind": kind, kind: body})
}

func (t *planTx) CreateIssue(_ context.Context, issue *backend.Issue, actor string) error {
	t.note(actor)
	body, err := createItemBody(issue)
	if err != nil {
		return err
	}
	key := fmt.Sprintf("k%d", len(t.items))
	body["key"] = key
	t.created[key] = issue
	if issue.ID == "" {
		issue.ID = pendingPrefix + key
	}
	t.add("create", body)
	return nil
}

func (t *planTx) CreateIssues(ctx context.Context, issues []*backend.Issue, actor string) error {
	for _, issue := range issues {
		if err := t.CreateIssue(ctx, issue, actor); err != nil {
			return err
		}
	}
	return nil
}

// issuePatchFromMap reads the raw update map the transaction and the raw store
// methods share. A key it does not know is refused, never skipped.
func issuePatchFromMap(updates map[string]interface{}) (issueops.IssuePatch, bool, error) {
	var p issueops.IssuePatch
	force := false
	var bad error
	str := func(v any) issueops.Field[string] {
		s, ok := v.(string)
		if !ok {
			bad = fmt.Errorf("update: %v is not a string: %w", v, backend.ErrValidation)
		}
		return issueops.Field[string]{Set: true, Value: s}
	}
	for key, value := range updates {
		if bad != nil {
			return p, false, bad
		}
		switch key {
		case forceClosePolicyKey:
			b, ok := value.(bool)
			if !ok {
				return p, false, fmt.Errorf("update: %s %v is not a boolean: %w", key, value, backend.ErrValidation)
			}
			force = b
		case "title":
			p.Title = str(value)
		case "description":
			p.Description = str(value)
		case "design":
			p.Design = str(value)
		case "acceptance_criteria":
			p.AcceptanceCriteria = str(value)
		case "notes":
			p.Notes = str(value)
		case "append_notes":
			p.AppendNotes = str(value)
		case "spec_id":
			p.SpecID = str(value)
		case "await_id":
			p.AwaitID = str(value)
		case "owner":
			p.Owner = str(value)
		case "status":
			p.Status = issueops.Field[issueops.Status]{Set: true, Value: issueops.Status(fmt.Sprint(value))}
		case "issue_type":
			p.IssueType = issueops.Field[issueops.IssueType]{Set: true, Value: issueops.IssueType(fmt.Sprint(value))}
		case "assignee":
			p.Assignee = str(value)
		case "parent_id":
			p.ParentID = str(value)
		case "priority":
			n, ok := intValue(value)
			if !ok {
				return p, false, fmt.Errorf("update: priority %v is not an integer: %w", value, backend.ErrValidation)
			}
			p.Priority = issueops.Field[int]{Set: true, Value: n}
		case "estimated_minutes":
			switch v := value.(type) {
			case nil:
				p.EstimatedMinutes = issueops.Field[*int]{Set: true}
			case *int:
				p.EstimatedMinutes = issueops.Field[*int]{Set: true, Value: v}
			default:
				n, ok := intValue(value)
				if !ok {
					return p, false, fmt.Errorf("update: estimated_minutes %v is not an integer: %w", value, backend.ErrValidation)
				}
				p.EstimatedMinutes = issueops.Field[*int]{Set: true, Value: &n}
			}
		case "external_ref":
			switch v := value.(type) {
			case nil:
				p.ExternalRef = issueops.Field[*string]{Set: true}
			case *string:
				p.ExternalRef = issueops.Field[*string]{Set: true, Value: v}
			default:
				s := fmt.Sprint(value)
				p.ExternalRef = issueops.Field[*string]{Set: true, Value: &s}
			}
		case "due_at", "defer_until":
			var at *time.Time
			switch v := value.(type) {
			case nil:
			case *time.Time:
				at = v
			case time.Time:
				at = &v
			default:
				return p, false, fmt.Errorf("update: %s %v is not a time: %w", key, value, backend.ErrValidation)
			}
			if key == "due_at" {
				p.DueAt = issueops.Field[*time.Time]{Set: true, Value: at}
			} else {
				p.DeferUntil = issueops.Field[*time.Time]{Set: true, Value: at}
			}
		case "metadata":
			raw, err := metadataValue(value)
			if err != nil {
				return p, false, err
			}
			p.Metadata.Replace = issueops.Field[json.RawMessage]{Set: true, Value: raw}
		case "labels":
			v, ok := value.([]string)
			if !ok {
				return p, false, fmt.Errorf("update: labels %v is not a list of strings: %w", value, backend.ErrValidation)
			}
			p.Labels.Replace = issueops.Field[[]string]{Set: true, Value: v}
		case "add_labels":
			v, ok := value.([]string)
			if !ok {
				return p, false, fmt.Errorf("update: add_labels %v is not a list of strings: %w", value, backend.ErrValidation)
			}
			p.Labels.Add = v
		case "remove_labels":
			v, ok := value.([]string)
			if !ok {
				return p, false, fmt.Errorf("update: remove_labels %v is not a list of strings: %w", value, backend.ErrValidation)
			}
			p.Labels.Remove = v
		default:
			return p, false, unsupportedField("Transaction.UpdateIssue", key)
		}
	}
	if bad != nil {
		return p, false, bad
	}
	return p, force, nil
}

func intValue(v any) (int, bool) {
	switch n := v.(type) {
	case int:
		return n, true
	case int64:
		return int(n), true
	case float64:
		if n == float64(int(n)) {
			return int(n), true
		}
	}
	return 0, false
}

// metadataValue reads a metadata document from the shapes a raw update carries.
func metadataValue(v any) (json.RawMessage, error) {
	switch m := v.(type) {
	case json.RawMessage:
		return m, nil
	case []byte:
		return json.RawMessage(m), nil
	case string:
		return json.RawMessage(m), nil
	case nil:
		return nil, nil
	}
	raw, err := json.Marshal(v)
	if err != nil {
		return nil, fmt.Errorf("update: metadata cannot be encoded: %w", backend.ErrValidation)
	}
	return raw, nil
}

func (t *planTx) UpdateIssue(_ context.Context, id string, updates map[string]interface{}, actor string) error {
	t.note(actor)
	patch, force, err := issuePatchFromMap(updates)
	if err != nil {
		return err
	}
	if err := validateUpdate("Transaction.UpdateIssue", issueops.UpdateRequest{Patch: patch}); err != nil {
		return err
	}
	target, err := t.ref(id)
	if err != nil {
		return err
	}
	return t.addUpdate(target, patch, force)
}

func (t *planTx) addUpdate(target wireRef, patch issueops.IssuePatch, force bool) error {
	wirePatch, err := applyPatchBody(patch)
	if err != nil {
		return err
	}
	body := map[string]any{"target": target, "patch": wirePatch}
	if force {
		body["force_close_policy"] = true
	}
	t.add("update", body)
	return nil
}

func (t *planTx) CloseIssue(_ context.Context, id, reason, actor, session string) error {
	t.note(actor)
	target, err := t.ref(id)
	if err != nil {
		return err
	}
	body := map[string]any{"target": target}
	if reason != "" {
		body["reason"] = reason
	}
	if session != "" {
		body["session"] = session
	}
	t.add("close", body)
	return nil
}

func (t *planTx) DeleteIssue(context.Context, string) error {
	return unsupportedField("Transaction.DeleteIssue", "no plan item deletes an issue")
}

func (t *planTx) AddDependency(_ context.Context, dep *backend.Dependency, actor string) error {
	t.note(actor)
	if dep.ThreadID != "" {
		return unsupportedField("Transaction.AddDependency", "thread_id")
	}
	source, err := t.ref(dep.IssueID)
	if err != nil {
		return err
	}
	target, err := t.ref(dep.DependsOnID)
	if err != nil {
		return err
	}
	body := map[string]any{"source": source, "target": target, "type": string(dep.Type)}
	if dep.Metadata != "" {
		body["metadata"] = json.RawMessage(dep.Metadata)
	}
	t.add("dep_add", body)
	return nil
}

func (t *planTx) AddDependencyWithOptions(ctx context.Context, dep *backend.Dependency, actor string, opts backend.DependencyAddOptions) error {
	if opts.SkipCycleCheck {
		return unsupportedField("Transaction.AddDependencyWithOptions", "SkipCycleCheck")
	}
	return t.AddDependency(ctx, dep, actor)
}

func (t *planTx) RemoveDependency(_ context.Context, issueID, dependsOnID, actor string) error {
	t.note(actor)
	source, err := t.ref(issueID)
	if err != nil {
		return err
	}
	target, err := t.ref(dependsOnID)
	if err != nil {
		return err
	}
	t.add("x_dep_remove", map[string]any{"source": source, "target": target})
	return nil
}

// RemoveDependencyWithOptions: the server always journals the removal, where
// upstream's structural removals leave it unrecorded; the edge goes either way.
func (t *planTx) RemoveDependencyWithOptions(ctx context.Context, issueID, dependsOnID, actor string, _ backend.DependencyRemoveOptions) error {
	return t.RemoveDependency(ctx, issueID, dependsOnID, actor)
}

func (t *planTx) labelUpdate(issueID, actor string, patch issueops.LabelPatch) error {
	t.note(actor)
	target, err := t.ref(issueID)
	if err != nil {
		return err
	}
	return t.addUpdate(target, issueops.IssuePatch{Labels: patch}, false)
}

func (t *planTx) AddLabel(_ context.Context, issueID, label, actor string) error {
	return t.labelUpdate(issueID, actor, issueops.LabelPatch{Add: []string{label}})
}

func (t *planTx) RemoveLabel(_ context.Context, issueID, label, actor string) error {
	return t.labelUpdate(issueID, actor, issueops.LabelPatch{Remove: []string{label}})
}

// AddComment is a plan item: the comment lands with the rest of the plan or not at all.
func (t *planTx) AddComment(_ context.Context, issueID, actor, comment string) error {
	t.note(actor)
	target, err := t.ref(issueID)
	if err != nil {
		return err
	}
	t.add("x_comment", map[string]any{"target": target, "text": comment})
	return nil
}

// SetConfig is a plan item. A memory is its own plane with no plan item, so a
// memory key is refused rather than written outside the plan.
func (t *planTx) SetConfig(_ context.Context, k, v string) error {
	if strings.HasPrefix(k, memoryKeyPrefix) {
		return unsupportedField("Transaction.SetConfig", "memory keys have no plan item")
	}
	t.add("x_set_config", map[string]any{"key": k, "value": v})
	return nil
}

// SetMetadata and SetLocalMetadata write the clone-local plane, which has no
// remote meaning. They run once the plan has landed.
func (t *planTx) SetMetadata(_ context.Context, k, v string) error {
	t.local = append(t.local, func(ctx context.Context) error { return t.s.SetMetadata(ctx, k, v) })
	return nil
}

func (t *planTx) SetLocalMetadata(_ context.Context, k, v string) error {
	t.local = append(t.local, func(ctx context.Context) error { return t.s.SetLocalMetadata(ctx, k, v) })
	return nil
}

// ---- reads and plane-less writes go straight to the store

func (t *planTx) GetIssue(ctx context.Context, id string) (*backend.Issue, error) {
	return t.s.GetIssue(ctx, id)
}
func (t *planTx) SearchIssues(ctx context.Context, q string, f backend.IssueFilter) ([]*backend.Issue, error) {
	return t.s.SearchIssues(ctx, q, f)
}
func (t *planTx) SearchIssueIDs(ctx context.Context, q string, f backend.IssueFilter) ([]string, error) {
	return t.s.SearchIssueIDs(ctx, q, f)
}
func (t *planTx) GetDependencyRecords(ctx context.Context, id string) ([]*backend.Dependency, error) {
	return t.s.GetDependencyRecords(ctx, id)
}
func (t *planTx) CycleThroughEdges(context.Context, [][2]string) (string, error) {
	return "", unsupportedField("Transaction.CycleThroughEdges", "the plan checks cycles when it lands")
}
func (t *planTx) GetLabels(ctx context.Context, id string) ([]string, error) {
	return t.s.GetLabels(ctx, id)
}
func (t *planTx) GetConfig(ctx context.Context, k string) (string, error) {
	return t.s.GetConfig(ctx, k)
}
func (t *planTx) GetMetadata(ctx context.Context, k string) (string, error) {
	return t.s.GetMetadata(ctx, k)
}
func (t *planTx) GetLocalMetadata(ctx context.Context, k string) (string, error) {
	return t.s.GetLocalMetadata(ctx, k)
}
func (t *planTx) ImportIssueComment(ctx context.Context, issueID, author, text string, at time.Time) (*backend.Comment, error) {
	return t.s.ImportIssueComment(ctx, issueID, author, text, at)
}
func (t *planTx) GetIssueComments(ctx context.Context, id string) ([]*backend.Comment, error) {
	return t.s.GetIssueComments(ctx, id)
}
func (t *planTx) GetIssueCommentsPage(ctx context.Context, id string, after backend.CommentPageCursor, limit int) ([]*backend.Comment, error) {
	return t.s.GetIssueCommentsPage(ctx, id, after, limit)
}
func (t *planTx) CountIssuesByGroup(ctx context.Context, f backend.IssueFilter, g string) (map[string]int, error) {
	return t.s.CountIssuesByGroup(ctx, f, g)
}
func (t *planTx) GetDependentRecords(ctx context.Context, id, depType string, limit int, after string) ([]*backend.Dependency, error) {
	return t.s.GetDependentRecords(ctx, id, depType, limit, after)
}
func (t *planTx) GetDependentRecordsForIssues(ctx context.Context, ids []string) (map[string][]*backend.Dependency, error) {
	return t.s.GetDependentRecordsForIssues(ctx, ids)
}
func (t *planTx) CountDependentRecords(ctx context.Context, id, depType string) (int, error) {
	records, err := t.s.GetDependentRecords(ctx, id, depType, 0, "")
	return len(records), err
}
func (t *planTx) IsBlocked(ctx context.Context, id string) (bool, []string, error) {
	return t.s.IsBlocked(ctx, id)
}
func (t *planTx) IsBlockedBatch(ctx context.Context, ids []string) (map[string]bool, error) {
	return t.s.IsBlockedBatch(ctx, ids)
}
func (t *planTx) EventsSince(ctx context.Context, c backend.EventCursor, id string, limit int) ([]*backend.Event, error) {
	return t.s.EventsSince(ctx, c, id, limit)
}

var (
	_ backend.Transaction               = (*planTx)(nil)
	_ backend.IssueLifecycleTransaction = (*lifecycleTx)(nil)
)
