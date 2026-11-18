package cloudflare

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/steveyegge/beads/backend"
	"github.com/steveyegge/beads/issueops"
)

// The batch, delete, sweep and metadata roles.

func (s *Store) BatchApplier() (issueops.BatchApplier, error) {
	return batchApplierRole{s}, s.checkOpen("BatchApplier")
}
func (s *Store) BatchCloser() (issueops.BatchCloser, error) {
	return batchCloserRole{s}, s.checkOpen("BatchCloser")
}
func (s *Store) BatchCreator() (issueops.BatchCreator, error) {
	return batchCreatorRole{s}, s.checkOpen("BatchCreator")
}
func (s *Store) Deleter() (issueops.Deleter, error) { return deleterRole{s}, s.checkOpen("Deleter") }
func (s *Store) Sweeper() (issueops.Sweeper, error) { return sweeperRole{s}, s.checkOpen("Sweeper") }
func (s *Store) MetadataCAS() (issueops.MetadataCAS, error) {
	return metadataCASRole{s}, s.checkOpen("MetadataCAS")
}

// ------------------------------------------------------------------ batch apply

type batchApplierRole struct{ s *Store }

type wireRef struct {
	ID  string `json:"id,omitempty"`
	Key string `json:"key,omitempty"`
}

func refOf(r issueops.Ref) wireRef { return wireRef{ID: r.ID, Key: r.Key} }

// applyPatchBody is the batch update's patch. It differs from the single-issue
// patch in two ways the wire is explicit about: labels are an object with
// add/remove/replace, and there is no parent_id.
func applyPatchBody(p issueops.IssuePatch) (map[string]any, error) {
	if p.ParentID.Set {
		return nil, unsupportedField("BatchApplier.ApplyBatch", "parent_id")
	}
	m, err := patchBody("BatchApplier.ApplyBatch", p, true)
	if err != nil {
		return nil, err
	}
	delete(m, "labels")
	delete(m, "add_labels")
	delete(m, "remove_labels")
	labels := map[string]any{}
	if p.Labels.Replace.Set {
		replace := p.Labels.Replace.Value
		if replace == nil {
			replace = []string{}
		}
		labels["replace"] = replace
	}
	if len(p.Labels.Add) > 0 {
		labels["add"] = p.Labels.Add
	}
	if len(p.Labels.Remove) > 0 {
		labels["remove"] = p.Labels.Remove
	}
	if len(labels) > 0 {
		m["labels"] = labels
	}
	return m, nil
}

func (r batchApplierRole) ApplyBatch(ctx context.Context, req issueops.ApplyBatchRequest) (issueops.ApplyBatchResult, error) {
	if err := r.s.writeRefused("BatchApplier.ApplyBatch"); err != nil {
		return issueops.ApplyBatchResult{}, err
	}
	ctx = WithActor(ctx, req.Actor)
	items := make([]map[string]any, 0, len(req.Items))
	for _, item := range req.Items {
		wire := map[string]any{"kind": string(item.Kind)}
		switch item.Kind {
		case issueops.ItemCreate:
			if item.Create == nil || item.Create.Issue == nil {
				return issueops.ApplyBatchResult{}, fmt.Errorf("apply batch: create item without an issue: %w", backend.ErrValidation)
			}
			create, err := createItemBody(item.Create.Issue)
			if err != nil {
				return issueops.ApplyBatchResult{}, err
			}
			if item.Create.Key != "" {
				create["key"] = item.Create.Key
			}
			if len(item.Create.MetadataRefs) > 0 {
				refs := map[string]wireRef{}
				for name, ref := range item.Create.MetadataRefs {
					refs[name] = refOf(ref)
				}
				create["metadata_refs"] = refs
			}
			wire["create"] = create
		case issueops.ItemUpdate:
			u := item.Update
			if u == nil {
				return issueops.ApplyBatchResult{}, fmt.Errorf("apply batch: update item without a body: %w", backend.ErrValidation)
			}
			patch, err := applyPatchBody(u.Patch)
			if err != nil {
				return issueops.ApplyBatchResult{}, err
			}
			body := map[string]any{"target": refOf(u.Target), "patch": patch}
			if v := versionGuard(u.ExpectedVersion); v != nil {
				body["expected_version"] = *v
			}
			if u.ExpectedStatus != nil {
				body["expected_status"] = string(*u.ExpectedStatus)
			}
			if u.ExpectedAssignee != nil {
				body["expected_assignee"] = *u.ExpectedAssignee
			}
			if u.ForceClosePolicy {
				body["force_close_policy"] = true
			}
			if u.ForceAssigneeTransfer {
				body["force_assignee_transfer"] = true
			}
			wire["update"] = body
		case issueops.ItemClose:
			c := item.Close
			if c == nil {
				return issueops.ApplyBatchResult{}, fmt.Errorf("apply batch: close item without a body: %w", backend.ErrValidation)
			}
			body := map[string]any{"target": refOf(c.Target)}
			if c.Reason != "" {
				body["reason"] = c.Reason
			}
			if c.Session != "" {
				body["session"] = c.Session
			}
			if c.Force {
				body["force"] = true
			}
			if v := versionGuard(c.ExpectedVersion); v != nil {
				body["expected_version"] = *v
			}
			wire["close"] = body
		case issueops.ItemDepAdd:
			d := item.DepAdd
			if d == nil {
				return issueops.ApplyBatchResult{}, fmt.Errorf("apply batch: dep_add item without a body: %w", backend.ErrValidation)
			}
			body := map[string]any{"source": refOf(d.Source), "target": refOf(d.Target), "type": string(d.Type)}
			if d.Metadata != "" {
				body["metadata"] = json.RawMessage(d.Metadata)
			}
			wire["dep_add"] = body
		default:
			return issueops.ApplyBatchResult{}, fmt.Errorf("apply batch: unknown item kind %q: %w", item.Kind, backend.ErrValidation)
		}
		items = append(items, wire)
	}
	return r.s.postBatch(ctx, req, items)
}

// postBatch sends a plan of wire items as one atomic request.
func (s *Store) postBatch(ctx context.Context, req issueops.ApplyBatchRequest, items []map[string]any) (issueops.ApplyBatchResult, error) {
	for _, item := range items {
		for _, kind := range []string{"create", "update"} {
			if body, ok := item[kind].(map[string]any); ok {
				if _, extra := body["x_extra"]; extra {
					if err := s.requireCapability(ctx, "BatchApplier.ApplyBatch", capXExtra); err != nil {
						return issueops.ApplyBatchResult{}, err
					}
				}
				if _, p := body["x_parent_id"]; p {
					if err := s.requireCapability(ctx, "BatchApplier.ApplyBatch", capApplyExtensions); err != nil {
						return issueops.ApplyBatchResult{}, err
					}
				}
			}
		}
		if k, _ := item["kind"].(string); strings.HasPrefix(k, "x_") {
			if err := s.requireCapability(ctx, "BatchApplier.ApplyBatch", capApplyExtensions); err != nil {
				return issueops.ApplyBatchResult{}, err
			}
		}
	}
	body := map[string]any{"actor": s.client.actorFor(ctx), "items": items}
	if req.Provenance != "" {
		body["provenance"] = req.Provenance
	}
	if req.ForceIDPrefix {
		body["force_id_prefix"] = true
	}
	if req.SkipPerEdgeCycleCheck {
		body["skip_per_edge_cycle_check"] = true
	}
	var out struct {
		Keys  map[string]string `json:"keys"`
		Items []struct {
			Kind        string `json:"kind"`
			IssueID     string `json:"issue_id"`
			DependsOnID string `json:"depends_on_id"`
			Changed     bool   `json:"changed"`
			Revision    string `json:"revision"`
		} `json:"items"`
	}
	if err := s.client.do(ctx, http.MethodPost, "/issues:batchApply", nil, body, &out); err != nil {
		return issueops.ApplyBatchResult{}, err
	}
	result := issueops.ApplyBatchResult{Keys: out.Keys}
	for _, it := range out.Items {
		result.Items = append(result.Items, issueops.ItemResult{
			Kind: issueops.ItemKind(it.Kind), IssueID: it.IssueID, DependsOnID: it.DependsOnID,
			Changed: it.Changed, RowVersion: parseRevision(it.Revision),
		})
	}
	return result, nil
}

// nowish is how far from the server's clock a caller-supplied created_at may be
// and still count as "now": a plan's create item has no timestamp member, so the
// server stamps its own, and a caller that meant the present loses nothing.
const nowish = 5 * time.Minute

// createItemBody is the create member of a batch item: the issue's own fields,
// without the request-level members (parent, edges, waits-for) a batch spells as
// separate items. A member the item cannot carry refuses the plan.
func createItemBody(i *backend.Issue) (map[string]any, error) {
	var lost []string
	if !i.CreatedAt.IsZero() && time.Since(i.CreatedAt).Abs() > nowish {
		lost = append(lost, "created_at")
	}
	if i.StartedAt != nil {
		lost = append(lost, "started_at")
	}
	if i.ClosedAt != nil {
		lost = append(lost, "closed_at")
	}
	lost = append(lost, issueFieldsNoWire(i)...)
	if len(lost) > 0 {
		return nil, unsupportedField("BatchApplier.ApplyBatch", "create item: "+strings.Join(lost, ", "))
	}
	if len(i.Comments) > 0 || len(i.Dependencies) > 0 {
		return nil, invalidf("BatchApplier.ApplyBatch: a create item's Comments and Dependencies must be empty; the plan carries them as items")
	}
	m := map[string]any{"title": i.Title}
	set := func(name string, v string) {
		if v != "" {
			m[name] = v
		}
	}
	set("id", i.ID)
	set("description", i.Description)
	set("design", i.Design)
	set("acceptance_criteria", i.AcceptanceCriteria)
	set("notes", i.Notes)
	set("status", string(i.Status))
	set("issue_type", string(i.IssueType))
	set("assignee", i.Assignee)
	set("owner", i.Owner)
	set("sender", i.Sender)
	set("external_ref", derefString(i.ExternalRef))
	m["priority"] = i.Priority
	if len(i.Labels) > 0 {
		m["labels"] = i.Labels
	}
	if i.EstimatedMinutes != nil {
		m["estimated_minutes"] = *i.EstimatedMinutes
	}
	if i.DueAt != nil {
		m["due_at"] = i.DueAt
	}
	if i.DeferUntil != nil {
		m["defer_until"] = i.DeferUntil
	}
	if len(i.Metadata) > 0 {
		m["metadata"] = i.Metadata
	}
	if i.Ephemeral {
		m["ephemeral"] = true
	}
	if i.NoHistory {
		m["no_history"] = true
	}
	if extra := issueExtra(i); extra != nil {
		m["x_extra"] = extra
	}
	return m, nil
}

// ----------------------------------------------------------------- batch close

type batchCloserRole struct{ s *Store }

func (r batchCloserRole) CloseBatch(ctx context.Context, req issueops.CloseBatchRequest) (issueops.CloseBatchResult, error) {
	if err := r.s.writeRefused("BatchCloser.CloseBatch"); err != nil {
		return issueops.CloseBatchResult{}, err
	}
	ctx = WithActor(ctx, req.Actor)
	items := make([]map[string]any, 0, len(req.Items))
	for _, it := range req.Items {
		item := map[string]any{"id": it.IssueID}
		if it.Reason != "" {
			item["reason"] = it.Reason
		}
		items = append(items, item)
	}
	body := map[string]any{"actor": r.s.client.actorFor(ctx), "items": items}
	if req.Session != "" {
		body["session"] = req.Session
	}
	if req.Force {
		body["force"] = true
	}
	var out struct {
		Outcomes []struct {
			IssueID       string         `json:"issue_id"`
			Issue         *backend.Issue `json:"issue"`
			AlreadyClosed *bool          `json:"already_closed"`
			OpenChildren  *int           `json:"open_children"`
			Code          *string        `json:"code"`
			Detail        *string        `json:"detail"`
		} `json:"outcomes"`
	}
	if err := r.s.client.do(ctx, http.MethodPost, "/issues:batchClose", nil, body, &out); err != nil {
		return issueops.CloseBatchResult{}, err
	}
	result := issueops.CloseBatchResult{}
	for _, o := range out.Outcomes {
		outcome := issueops.CloseOutcome{IssueID: o.IssueID, Issue: o.Issue}
		if o.AlreadyClosed != nil {
			outcome.Changed = !*o.AlreadyClosed
		} else {
			outcome.Changed = o.Issue != nil
		}
		if o.OpenChildren != nil {
			outcome.OpenChildren = *o.OpenChildren
		}
		if o.Code != nil {
			p := &Problem{Code: *o.Code, Detail: str(o.Detail), OpenChildren: o.OpenChildren, IssueID: &o.IssueID}
			if p.Code == "not_found" {
				p.Status = 404
			}
			outcome.Err = &apiError{problem: p, mapped: problemSentinel(p)}
			outcome.Changed = false
		}
		result.Outcomes = append(result.Outcomes, outcome)
	}
	// The wire close has no take-next member: a caller that asked for the next
	// ready issue gets one claim after the batch landed.
	if req.ClaimNext != nil {
		claimed, err := (readyClaimerRole{r.s}).ClaimNext(ctx, issueops.ClaimNextRequest{Actor: req.Actor, Filter: *req.ClaimNext})
		if err != nil {
			return result, err
		}
		result.ClaimedNext = claimed.Claimed
	}
	return result, nil
}

// ---------------------------------------------------------------- batch create

type batchCreatorRole struct{ s *Store }

func (r batchCreatorRole) CreateBatch(ctx context.Context, req issueops.CreateBatchRequest) (issueops.CreateBatchResult, error) {
	if err := r.s.writeRefused("BatchCreator.CreateBatch"); err != nil {
		return issueops.CreateBatchResult{}, err
	}
	ctx = WithActor(ctx, req.Actor)
	items := make([]map[string]any, 0, len(req.Items))
	for i, it := range req.Items {
		if it.Issue == nil {
			return issueops.CreateBatchResult{}, fmt.Errorf("create batch: item %d has no issue: %w", i, backend.ErrValidation)
		}
		// The wire batch carries a narrow member set; anything else would be
		// dropped silently, which a caller reads as success.
		issue := it.Issue
		for field, present := range map[string]bool{
			"id": issue.ID != "", "notes": issue.Notes != "", "owner": issue.Owner != "",
			"external_ref": issue.ExternalRef != nil, "metadata": len(issue.Metadata) > 0,
			"status": issue.Status != "" && issue.Status != backend.StatusOpen, "due_at": issue.DueAt != nil,
			"defer_until": issue.DeferUntil != nil, "estimated_minutes": issue.EstimatedMinutes != nil,
			"sender": issue.Sender != "", "ephemeral": issue.Ephemeral, "no_history": issue.NoHistory,
			"created_at": !issue.CreatedAt.IsZero() && time.Since(issue.CreatedAt).Abs() > nowish,
			"started_at": issue.StartedAt != nil, "closed_at": issue.ClosedAt != nil,
			"comments": len(issue.Comments) > 0, "dependencies (on the issue)": len(issue.Dependencies) > 0,
		} {
			if present {
				return issueops.CreateBatchResult{}, unsupportedField("BatchCreator.CreateBatch", field)
			}
		}
		if fields := issueFieldsNoWire(issue); len(fields) > 0 {
			return issueops.CreateBatchResult{}, unsupportedField("BatchCreator.CreateBatch", strings.Join(fields, ", "))
		}
		item := map[string]any{"title": issue.Title, "priority": issue.Priority}
		if issue.Description != "" {
			item["description"] = issue.Description
		}
		if issue.Design != "" {
			item["design"] = issue.Design
		}
		if issue.AcceptanceCriteria != "" {
			item["acceptance_criteria"] = issue.AcceptanceCriteria
		}
		if issue.Assignee != "" {
			item["assignee"] = issue.Assignee
		}
		if issue.IssueType != "" {
			item["issue_type"] = string(issue.IssueType)
		}
		if len(issue.Labels) > 0 {
			item["labels"] = issue.Labels
		}
		if extra := issueExtra(issue); extra != nil {
			if err := r.s.requireCapability(ctx, "BatchCreator.CreateBatch", capXExtra); err != nil {
				return issueops.CreateBatchResult{}, err
			}
			item["x_extra"] = extra
		}
		if len(it.Dependencies) > 0 {
			deps := make([]map[string]any, 0, len(it.Dependencies))
			for _, d := range it.Dependencies {
				if d.Reverse || d.Metadata != "" || d.ThreadID != "" {
					return issueops.CreateBatchResult{}, unsupportedField("BatchCreator.CreateBatch", "dependencies: reverse, metadata and thread_id")
				}
				deps = append(deps, map[string]any{"target_id": d.TargetID, "type": string(d.Type)})
			}
			item["dependencies"] = deps
		}
		items = append(items, item)
	}
	body := map[string]any{"actor": r.s.client.actorFor(ctx), "items": items}
	var out struct {
		Items []*backend.Issue `json:"items"`
	}
	if err := r.s.client.do(ctx, http.MethodPost, "/issues:batchCreate", nil, body, &out); err != nil {
		return issueops.CreateBatchResult{}, err
	}
	return issueops.CreateBatchResult{Issues: out.Items}, nil
}

// ---------------------------------------------------------------------- delete

type deleterRole struct{ s *Store }

func (r deleterRole) Delete(ctx context.Context, req issueops.DeleteRequest) (issueops.DeleteResult, error) {
	if err := r.s.writeRefused("Deleter.Delete"); err != nil {
		return issueops.DeleteResult{}, err
	}
	ctx = WithActor(ctx, req.Actor)
	body := map[string]any{"actor": r.s.client.actorFor(ctx), "ids": req.IDs}
	if req.Cascade {
		body["cascade"] = true
	}
	if req.Force {
		body["force"] = true
	}
	if req.DryRun {
		body["dry_run"] = true
	}
	if v := versionGuard(req.ExpectedVersion); v != nil {
		body["expected_version"] = *v
	}
	var out struct {
		Deleted           int      `json:"deleted"`
		Dependencies      int      `json:"dependencies"`
		DryRun            bool     `json:"dry_run"`
		Events            int      `json:"events"`
		Labels            int      `json:"labels"`
		ReferencesUpdated int      `json:"references_updated"`
		Orphaned          []string `json:"orphaned"`
	}
	if err := r.s.client.do(ctx, http.MethodPost, "/issues:delete", nil, body, &out); err != nil {
		return issueops.DeleteResult{}, deleteError(err, req.IDs)
	}
	return issueops.DeleteResult{
		DryRun: out.DryRun, Deleted: out.Deleted, Dependencies: out.Dependencies, Labels: out.Labels,
		Events: out.Events, ReferencesUpdated: out.ReferencesUpdated, Orphaned: out.Orphaned,
	}, nil
}

// deleteError restores the typed refusals the delete role raises. The wire sends
// both as a 400 whose detail is the role's own sentence.
func deleteError(err error, ids []string) error {
	var p *Problem
	if !asProblem(err, &p) {
		return err
	}
	if p.Status == 404 {
		return &issueops.NotFoundError{IDs: ids}
	}
	if strings.Contains(p.Detail, "dependents not in deletion set") {
		return &issueops.DependentsOutsideRequestError{IssueID: firstWord(p.Detail, "issue "), Dependents: nil}
	}
	return err
}

func firstWord(s, after string) string {
	i := strings.Index(s, after)
	if i < 0 {
		return ""
	}
	rest := s[i+len(after):]
	if j := strings.IndexByte(rest, ' '); j >= 0 {
		return rest[:j]
	}
	return rest
}

// ----------------------------------------------------------------------- sweep

type sweeperRole struct{ s *Store }

func (r sweeperRole) Sweep(ctx context.Context, req issueops.SweepRequest) (issueops.SweepResult, error) {
	if err := r.s.writeRefused("Sweeper.Sweep"); err != nil {
		return issueops.SweepResult{}, err
	}
	if req.ProtectLiveDependents || req.Limit > 0 {
		// The wire sweep has neither: a destructive request must not run without the
		// protection or the cap it asked for.
		return issueops.SweepResult{}, unsupportedField("Sweeper.Sweep", "ProtectLiveDependents and Limit")
	}
	ctx = WithActor(ctx, req.Actor)
	body := map[string]any{"actor": r.s.client.actorFor(ctx), "tier": string(req.Tier)}
	if req.ClosedBefore != nil {
		body["closed_before"] = req.ClosedBefore.UTC().Format(time.RFC3339Nano)
	}
	if req.IDPattern != "" {
		body["pattern"] = req.IDPattern
	}
	if req.ProtectReferenced {
		body["protect_referenced"] = true
	}
	if req.DryRun {
		body["dry_run"] = true
	}
	var out struct {
		Swept         int      `json:"swept"`
		Dependencies  int      `json:"dependencies"`
		Labels        int      `json:"labels"`
		Events        int      `json:"events"`
		DryRun        bool     `json:"dry_run"`
		ReferencedIDs []string `json:"referenced_ids"`
		Skipped       struct {
			Pinned                int `json:"pinned"`
			Referenced            int `json:"referenced"`
			NotClosed             int `json:"not_closed"`
			UnknownClosedAt       int `json:"unknown_closed_at"`
			ClosedAtOrAfterCutoff int `json:"closed_at_or_after_cutoff"`
			Unreadable            int `json:"unreadable"`
		} `json:"skipped"`
	}
	if err := r.s.client.do(ctx, http.MethodPost, "/issues:sweep", nil, body, &out); err != nil {
		return issueops.SweepResult{}, err
	}
	return issueops.SweepResult{
		DryRun: out.DryRun, Swept: out.Swept, Dependencies: out.Dependencies, Labels: out.Labels, Events: out.Events,
		ReferencedIDs: out.ReferencedIDs,
		Skipped: issueops.SweepSkips{
			Pinned: out.Skipped.Pinned, Referenced: out.Skipped.Referenced, NotClosed: out.Skipped.NotClosed,
			UnknownClosedAt: out.Skipped.UnknownClosedAt, ClosedAtOrAfterCutoff: out.Skipped.ClosedAtOrAfterCutoff,
			Unreadable: out.Skipped.Unreadable,
		},
	}, nil
}

// -------------------------------------------------------------- metadata compare-and-set

type metadataCASRole struct{ s *Store }

func (r metadataCASRole) CompareAndSetKey(ctx context.Context, req issueops.CompareAndSetKeyRequest) (issueops.CompareAndSetKeyResult, error) {
	if err := r.s.writeRefused("MetadataCAS.CompareAndSetKey"); err != nil {
		return issueops.CompareAndSetKeyResult{}, err
	}
	ctx = WithActor(ctx, req.Actor)
	body := map[string]any{"actor": r.s.client.actorFor(ctx), "key": req.Key}
	if req.Expected != nil {
		body["expected"] = *req.Expected
	}
	if req.Value != nil {
		body["value"] = *req.Value
	}
	var out struct {
		Swapped bool             `json:"swapped"`
		Current *json.RawMessage `json:"current"`
	}
	if err := r.s.client.do(ctx, http.MethodPost, issuePath(req.IssueID)+":casMetadata", nil, body, &out); err != nil {
		return issueops.CompareAndSetKeyResult{}, err
	}
	return issueops.CompareAndSetKeyResult{Swapped: out.Swapped, Current: out.Current}, nil
}
