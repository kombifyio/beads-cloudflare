package cloudflare

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"

	"github.com/steveyegge/beads/backend"
	"github.com/steveyegge/beads/issueops"
)

// The write roles: lifecycle, claim, release, take-ready-work, comment and
// dependency edit. Each method is the inverse of one upstream handler.

type lifecycleRole struct{ s *Store }

func (s *Store) IssueLifecycle() (issueops.Lifecycle, error) {
	return lifecycleRole{s}, s.checkOpen("IssueLifecycle")
}

func (s *Store) IssueClaimer() (issueops.Claimer, error) {
	return claimerRole{s}, s.checkOpen("IssueClaimer")
}

func (s *Store) Releaser() (issueops.Releaser, error) {
	return releaserRole{s}, s.checkOpen("Releaser")
}

func (s *Store) ReadyClaimer() (issueops.ReadyClaimer, error) {
	return readyClaimerRole{s}, s.checkOpen("ReadyClaimer")
}

func (s *Store) Commenter() (issueops.Commenter, error) {
	return commenterRole{s}, s.checkOpen("Commenter")
}

func (s *Store) DependencyEditor() (issueops.DependencyEditor, error) {
	return dependencyEditorRole{s}, s.checkOpen("DependencyEditor")
}

func issuePath(id string) string { return "/issues/" + url.PathEscape(id) }

func unsupportedField(op, field string) error {
	return &backend.ErrUnsupported{Op: op + "(" + field + ")", Backend: backendName}
}

// ---------------------------------------------------------------------- create

func (r lifecycleRole) Create(ctx context.Context, req issueops.CreateRequest) (issueops.CreateResult, error) {
	if err := r.s.writeRefused("IssueLifecycle.Create"); err != nil {
		return issueops.CreateResult{}, err
	}
	if req.Issue == nil {
		return issueops.CreateResult{}, fmt.Errorf("create: no issue: %w", backend.ErrValidation)
	}
	ctx = WithActor(ctx, req.Actor)
	body, err := r.s.prepareCreate(ctx, "Lifecycle.Create", req, r.s.client.actorFor(ctx), false)
	if err != nil {
		return issueops.CreateResult{}, err
	}
	var out backend.Issue
	if err := r.s.client.do(ctx, http.MethodPost, "/issues", nil, body, &out); err != nil {
		return issueops.CreateResult{}, err
	}
	return issueops.CreateResult{Issue: &out}, nil
}

// ---------------------------------------------------------------------- update

// patchBody encodes an IssuePatch as the wire patch object. Members the wire
// patch does not carry are refused rather than dropped: a silently ignored edit
// would read as a success.
func patchBody(op string, p issueops.IssuePatch, batch bool) (map[string]any, error) {
	refused := map[string]bool{"closed_by_session": p.ClosedBySession.Set, "persistence": p.Persistence.Set}
	if !batch {
		// Only the plan's patch has an owner member.
		refused["owner"] = p.Owner.Set
	}
	for _, field := range []string{"closed_by_session", "persistence", "owner"} {
		if refused[field] {
			return nil, unsupportedField(op, field)
		}
	}
	m := map[string]any{}
	put := func(name string, set bool, value any) {
		if set {
			m[name] = value
		}
	}
	if p.SpecID.Set || p.AwaitID.Set {
		// The core members the upstream patch has no member for ride x_extra.
		extra := map[string]any{}
		if p.SpecID.Set {
			extra["spec_id"] = p.SpecID.Value
		}
		if p.AwaitID.Set {
			extra["await_id"] = p.AwaitID.Value
		}
		m["x_extra"] = extra
	}
	if batch {
		put("owner", p.Owner.Set, p.Owner.Value)
	}
	put("title", p.Title.Set, p.Title.Value)
	put("description", p.Description.Set, p.Description.Value)
	put("design", p.Design.Set, p.Design.Value)
	put("acceptance_criteria", p.AcceptanceCriteria.Set, p.AcceptanceCriteria.Value)
	put("notes", p.Notes.Set, p.Notes.Value)
	put("append_notes", p.AppendNotes.Set, p.AppendNotes.Value)
	put("status", p.Status.Set, string(p.Status.Value))
	put("priority", p.Priority.Set, p.Priority.Value)
	put("issue_type", p.IssueType.Set, string(p.IssueType.Value))
	put("assignee", p.Assignee.Set, p.Assignee.Value)
	put("parent_id", p.ParentID.Set, p.ParentID.Value)
	put("estimated_minutes", p.EstimatedMinutes.Set, p.EstimatedMinutes.Value)
	put("external_ref", p.ExternalRef.Set, p.ExternalRef.Value)
	put("due_at", p.DueAt.Set, p.DueAt.Value)
	put("defer_until", p.DeferUntil.Set, p.DeferUntil.Value)
	if p.Labels.Replace.Set {
		values := p.Labels.Replace.Value
		if values == nil {
			values = []string{}
		}
		m["labels"] = values
	}
	if len(p.Labels.Add) > 0 {
		m["add_labels"] = p.Labels.Add
	}
	if len(p.Labels.Remove) > 0 {
		m["remove_labels"] = p.Labels.Remove
	}
	if md := metadataPatchBody(p.Metadata); md != nil {
		m["metadata"] = md
	}
	return m, nil
}

func metadataPatchBody(p issueops.MetadataPatch) map[string]any {
	md := map[string]any{}
	if p.Replace.Set {
		value := p.Replace.Value
		if len(value) == 0 {
			value = json.RawMessage("{}")
		}
		return map[string]any{"replace": value}
	}
	if p.Merge.Set {
		md["merge"] = p.Merge.Value
	}
	if len(p.Set) > 0 {
		md["set"] = p.Set
	}
	if len(p.Unset) > 0 {
		md["unset"] = p.Unset
	}
	if len(md) == 0 {
		return nil
	}
	return md
}

type changedIssue struct {
	Issue    backend.Issue `json:"issue"`
	Changed  bool          `json:"changed"`
	Revision string        `json:"revision"`
}

func (c changedIssue) issue() *backend.Issue {
	issue := c.Issue
	issue.RowVersion = parseRevision(c.Revision)
	return &issue
}

func (r lifecycleRole) Update(ctx context.Context, req issueops.UpdateRequest) (issueops.UpdateResult, error) {
	if err := r.s.writeRefused("IssueLifecycle.Update"); err != nil {
		return issueops.UpdateResult{}, err
	}
	ctx = WithActor(ctx, req.Actor)
	actor := r.s.client.actorFor(ctx)
	// Everything that can be refused is refused first: a claim that committed
	// before its patch failed is state the caller never asked to leave behind.
	if err := validateUpdate("Lifecycle.Update", req); err != nil {
		return issueops.UpdateResult{}, err
	}
	patch, err := patchBody("Lifecycle.Update", req.Patch, false)
	if err != nil {
		return issueops.UpdateResult{}, err
	}
	if _, ok := patch["x_extra"]; ok {
		if err := r.s.requireCapability(ctx, "Lifecycle.Update", capXExtra); err != nil {
			return issueops.UpdateResult{}, err
		}
	}

	guards := func(body map[string]any) {
		if req.ExpectedStatus != nil {
			body["expected_status"] = string(*req.ExpectedStatus)
		}
		if req.ExpectedAssignee != nil {
			body["expected_assignee"] = *req.ExpectedAssignee
		}
		if req.ForceClosePolicy {
			body["force_close_policy"] = true
		}
		if req.ForceAssigneeTransfer {
			body["force_assignee_transfer"] = true
		}
	}

	if !req.Claim {
		if req.IssuePlaneOnly {
			if _, err := r.s.issuePlaneRow(ctx, req.IssueID, true); err != nil {
				return issueops.UpdateResult{}, err
			}
		}
		if len(patch) == 0 {
			// Nothing to write, but the guards still answer: the row is read and each
			// guard compared, as the role does before it finds nothing to write.
			row, err := r.s.readIssue(ctx, req.IssueID)
			if err != nil {
				return issueops.UpdateResult{}, err
			}
			if req.ExpectedVersion != nil && row.RowVersion != *req.ExpectedVersion {
				return issueops.UpdateResult{}, fmt.Errorf("issue %s is at version %d, not %d: %w", req.IssueID, row.RowVersion, *req.ExpectedVersion, issueops.ErrVersionMismatch)
			}
			if req.ExpectedStatus != nil && row.Status != *req.ExpectedStatus {
				return issueops.UpdateResult{}, fmt.Errorf("issue %s has status %s, not %s: %w", req.IssueID, row.Status, *req.ExpectedStatus, issueops.ErrStatusMismatch)
			}
			if req.ExpectedAssignee != nil && row.Assignee != *req.ExpectedAssignee {
				return issueops.UpdateResult{}, fmt.Errorf("issue %s is assigned to %q, not %q: %w", req.IssueID, row.Assignee, *req.ExpectedAssignee, issueops.ErrAssigneeMismatch)
			}
			return issueops.UpdateResult{Issue: row}, nil
		}
		body := map[string]any{"actor": actor, "patch": patch}
		if v := versionGuard(req.ExpectedVersion); v != nil {
			body["expected_version"] = *v
		}
		guards(body)
		var out changedIssue
		if err := r.s.client.do(ctx, http.MethodPatch, issuePath(req.IssueID), nil, body, &out); err != nil {
			return issueops.UpdateResult{}, withIssue(err, req.IssueID)
		}
		return issueops.UpdateResult{Issue: out.issue(), Changed: out.Changed}, nil
	}

	// A claim is its own operation on the wire, and it has no member for a version
	// guard or for a patch: the row is read fresh first, so the guard is checked and
	// the state a failed patch must be returned to is known. The claim itself is
	// atomic and fenced by the server.
	var before *backend.Issue
	if req.ExpectedVersion != nil || len(patch) > 0 || req.IssuePlaneOnly {
		before, err = r.s.issuePlaneRow(ctx, req.IssueID, req.IssuePlaneOnly)
		if err != nil {
			return issueops.UpdateResult{}, err
		}
		if req.ExpectedVersion != nil && before.RowVersion != *req.ExpectedVersion {
			return issueops.UpdateResult{}, fmt.Errorf("issue %s is at version %d, not %d: %w", req.IssueID, before.RowVersion, *req.ExpectedVersion, issueops.ErrVersionMismatch)
		}
	}
	var out struct {
		Issue          backend.Issue `json:"issue"`
		AlreadyClaimed bool          `json:"already_claimed"`
		FencingToken   *int64        `json:"x_fencing_token"`
	}
	if err := r.s.client.do(ctx, http.MethodPost, issuePath(req.IssueID)+":claim", nil, map[string]any{"actor": actor}, &out); err != nil {
		return issueops.UpdateResult{}, withIssue(err, req.IssueID)
	}
	took := !out.AlreadyClaimed
	if len(patch) == 0 {
		return issueops.UpdateResult{Issue: &out.Issue, Changed: took}, nil
	}

	// The claim moved the row's version, so the patch is not guarded by the
	// caller's (it was checked above); the other guards do not apply to a claim.
	body := map[string]any{"actor": actor, "patch": patch}
	if req.ForceClosePolicy {
		body["force_close_policy"] = true
	}
	var patched changedIssue
	if err := r.s.client.do(ctx, http.MethodPatch, issuePath(req.IssueID), nil, body, &patched); err != nil {
		err = withIssue(err, req.IssueID)
		if took {
			// This command took the claim, so this command gives it back, and the
			// caller sees the error that stopped the update.
			if undo := r.s.releaseClaim(ctx, req.IssueID, actor, out.FencingToken, before); undo != nil {
				return issueops.UpdateResult{}, fmt.Errorf("%w (the claim this command took on %s could not be released: %v)", err, req.IssueID, undo)
			}
		}
		return issueops.UpdateResult{}, err
	}
	return issueops.UpdateResult{Issue: patched.issue(), Changed: patched.Changed || took}, nil
}

// issuePlaneRow reads an issue row fresh, for the checks that decide a write.
// The store keeps one table; a row on the ephemeral plane is not on the issue
// plane, which is what a request restricted to it must not reach.
func (s *Store) issuePlaneRow(ctx context.Context, id string, planeOnly bool) (*backend.Issue, error) {
	row, err := s.readIssue(ctx, id)
	if err != nil {
		return nil, err
	}
	if planeOnly && (row.Ephemeral || row.NoHistory) {
		return nil, fmt.Errorf("issue %s is not on the issue plane: %w", id, backend.ErrNotFound)
	}
	return row, nil
}

// releaseClaim gives back a claim this command took. The release carries the
// claim's fencing token, so a newer claim (the same principal's, taken in
// between) is refused as stale and left alone. The previous assignee is put back
// only where the row was open and already assigned to this same actor before the
// claim; in every other case the row stays as the release leaves it.
func (s *Store) releaseClaim(ctx context.Context, id, actor string, token *int64, before *backend.Issue) error {
	body := map[string]any{"actor": actor}
	if token != nil {
		body["x_fencing_token"] = *token
	}
	var released changedIssue
	if err := s.client.do(ctx, http.MethodPost, issuePath(id)+":release", nil, body, &released); err != nil {
		return err
	}
	if before != nil && before.Status == backend.StatusOpen && before.Assignee == actor {
		patch := map[string]any{"actor": actor, "patch": map[string]any{"assignee": actor}}
		return s.client.do(ctx, http.MethodPatch, issuePath(id), nil, patch, nil)
	}
	return nil
}

// readIssue reads one issue row without its comments or dependents.
func (s *Store) readIssue(ctx context.Context, id string) (*backend.Issue, error) {
	var out backend.IssueDetails
	if err := s.client.do(ctx, http.MethodGet, issuePath(id), nil, nil, &out); err != nil {
		return nil, err
	}
	issue := out.Issue
	issue.RowVersion = parseRevision(out.Revision)
	return &issue, nil
}

// ----------------------------------------------------------------- close, reopen

func (r lifecycleRole) Close(ctx context.Context, req issueops.CloseRequest) (issueops.CloseResult, error) {
	if err := r.s.writeRefused("IssueLifecycle.Close"); err != nil {
		return issueops.CloseResult{}, err
	}
	ctx = WithActor(ctx, req.Actor)
	body := map[string]any{"actor": r.s.client.actorFor(ctx)}
	if req.Reason != "" {
		body["reason"] = req.Reason
	}
	if req.Session != "" {
		body["session"] = req.Session
	}
	if req.Force {
		body["force"] = true
	}
	if v := versionGuard(req.ExpectedVersion); v != nil {
		body["expected_version"] = *v
	}
	var out struct {
		Issue         backend.Issue `json:"issue"`
		AlreadyClosed bool          `json:"already_closed"`
		OpenChildren  int           `json:"open_children"`
		Revision      string        `json:"revision"`
	}
	if err := r.s.client.do(ctx, http.MethodPost, issuePath(req.IssueID)+":close", nil, body, &out); err != nil {
		return issueops.CloseResult{}, withIssue(err, req.IssueID)
	}
	out.Issue.RowVersion = parseRevision(out.Revision)
	return issueops.CloseResult{Issue: &out.Issue, Changed: !out.AlreadyClosed, OpenChildren: out.OpenChildren}, nil
}

func (r lifecycleRole) Reopen(ctx context.Context, req issueops.ReopenRequest) (issueops.ReopenResult, error) {
	if err := r.s.writeRefused("IssueLifecycle.Reopen"); err != nil {
		return issueops.ReopenResult{}, err
	}
	ctx = WithActor(ctx, req.Actor)
	body := map[string]any{"actor": r.s.client.actorFor(ctx)}
	if req.Reason != "" {
		body["reason"] = req.Reason
	}
	if v := versionGuard(req.ExpectedVersion); v != nil {
		body["expected_version"] = *v
	}
	var out struct {
		Issue       backend.Issue `json:"issue"`
		AlreadyOpen bool          `json:"already_open"`
		Revision    string        `json:"revision"`
	}
	if err := r.s.client.do(ctx, http.MethodPost, issuePath(req.IssueID)+":reopen", nil, body, &out); err != nil {
		return issueops.ReopenResult{}, withIssue(err, req.IssueID)
	}
	out.Issue.RowVersion = parseRevision(out.Revision)
	return issueops.ReopenResult{Issue: &out.Issue, Changed: !out.AlreadyOpen}, nil
}

// ------------------------------------------------------------------ claim, release

type claimerRole struct{ s *Store }

func (r claimerRole) Claim(ctx context.Context, req issueops.ClaimRequest) (issueops.ClaimResult, error) {
	if err := r.s.writeRefused("IssueClaimer.Claim"); err != nil {
		return issueops.ClaimResult{}, err
	}
	ctx = WithActor(ctx, req.Actor)
	var out struct {
		Issue          backend.Issue `json:"issue"`
		AlreadyClaimed bool          `json:"already_claimed"`
	}
	if err := r.s.client.do(ctx, http.MethodPost, issuePath(req.IssueID)+":claim", nil, map[string]any{"actor": r.s.client.actorFor(ctx)}, &out); err != nil {
		return issueops.ClaimResult{}, withIssue(err, req.IssueID)
	}
	return issueops.ClaimResult{Issue: &out.Issue, Changed: !out.AlreadyClaimed}, nil
}

type releaserRole struct{ s *Store }

func (r releaserRole) Release(ctx context.Context, req issueops.ReleaseRequest) (issueops.ReleaseResult, error) {
	if err := r.s.writeRefused("Releaser.Release"); err != nil {
		return issueops.ReleaseResult{}, err
	}
	ctx = WithActor(ctx, req.Actor)
	body := map[string]any{"actor": r.s.client.actorFor(ctx)}
	if req.ExpectedAssignee != nil {
		body["expected_assignee"] = *req.ExpectedAssignee
	}
	if req.Force {
		body["force"] = true
	}
	var out changedIssue
	if err := r.s.client.do(ctx, http.MethodPost, issuePath(req.IssueID)+":release", nil, body, &out); err != nil {
		return issueops.ReleaseResult{}, withIssue(err, req.IssueID)
	}
	return issueops.ReleaseResult{Issue: out.issue(), Changed: out.Changed}, nil
}

type readyClaimerRole struct{ s *Store }

func (r readyClaimerRole) ClaimNext(ctx context.Context, req issueops.ClaimNextRequest) (issueops.ClaimNextResult, error) {
	if err := r.s.writeRefused("ReadyClaimer.ClaimNext"); err != nil {
		return issueops.ClaimNextResult{}, err
	}
	if readySelection(req.Filter).local() {
		// The claim is one atomic server operation over the ready set; a filter its
		// route does not carry cannot be honored inside it.
		return issueops.ClaimNextResult{}, unsupportedField("ReadyClaimer.ClaimNext", "mol_type")
	}
	ctx = WithActor(ctx, req.Actor)
	var out struct {
		Claimed *backend.IssueWithCounts `json:"claimed"`
	}
	policy := req.Filter.Sort
	switch policy {
	case "":
		policy = "hybrid"
	case "hybrid", "priority", "oldest":
	default:
		return issueops.ClaimNextResult{}, invalidf("ready sort %q is not hybrid, priority or oldest", policy)
	}
	q := readyParams(req.Filter).str("sort", policy)
	if err := r.s.client.do(ctx, http.MethodPost, "/issues:claimNext", q.values(), map[string]any{"actor": r.s.client.actorFor(ctx)}, &out); err != nil {
		return issueops.ClaimNextResult{}, err
	}
	return issueops.ClaimNextResult{Claimed: out.Claimed}, nil
}

// readyParams encodes the ready filters. The wire carries no sort or limit for a
// count or a claim, so those go only where the caller adds them.
func readyParams(req issueops.ReadyRequest) *query {
	q := newQuery().
		str("assignee", req.Assignee).
		flag("unassigned", req.Unassigned).
		str("type", req.IssueType).
		list("exclude_type", req.ExcludeTypes).
		list("label", req.Labels).
		list("label_any", req.LabelsAny).
		list("exclude_label", req.ExcludeLabels).
		str("label_pattern", req.LabelPattern).
		str("label_regex", req.LabelRegex).
		integer("priority", req.Priority).
		str("parent", req.ParentID).
		pairs("metadata_field", req.MetadataFields).
		str("has_metadata_key", req.HasMetadataKey).
		flag("include_ephemeral", req.IncludeEphemeral).
		flag("include_deferred", req.IncludeDeferred)
	return q
}

// --------------------------------------------------------------------- comments

type commenterRole struct{ s *Store }

func (r commenterRole) AddComment(ctx context.Context, req issueops.AddCommentRequest) (issueops.AddCommentResult, error) {
	if err := r.s.writeRefused("Commenter.AddComment"); err != nil {
		return issueops.AddCommentResult{}, err
	}
	ctx = WithActor(ctx, req.Author)
	var out backend.Comment
	body := map[string]any{"author": pickActor(req.Author, r.s.client.actorFor(ctx)), "text": req.Text}
	if err := r.s.client.do(ctx, http.MethodPost, issuePath(req.IssueID)+"/comments", nil, body, &out); err != nil {
		return issueops.AddCommentResult{}, err
	}
	if out.IssueID == "" {
		out.IssueID = req.IssueID
	}
	return issueops.AddCommentResult{Comment: &out}, nil
}

// ------------------------------------------------------------------ dependencies

type dependencyEditorRole struct{ s *Store }

type wireEdge struct {
	IssueID     string `json:"issue_id"`
	DependsOnID string `json:"depends_on_id"`
	Type        string `json:"type"`
}

func (r dependencyEditorRole) AddDependencies(ctx context.Context, req issueops.AddDependenciesRequest) (issueops.AddDependenciesResult, error) {
	if err := r.s.writeRefused("DependencyEditor.AddDependencies"); err != nil {
		return issueops.AddDependenciesResult{}, err
	}
	if req.SkipPerEdgeCycleCheck {
		return issueops.AddDependenciesResult{}, unsupportedField("DependencyEditor.AddDependencies", "SkipPerEdgeCycleCheck")
	}
	ctx = WithActor(ctx, req.Actor)
	edges := make([]wireEdge, 0, len(req.Edges))
	for _, e := range req.Edges {
		edges = append(edges, wireEdge{IssueID: e.IssueID, DependsOnID: e.DependsOnID, Type: string(e.Type)})
	}
	var out struct {
		Added []wireEdge `json:"added"`
	}
	body := map[string]any{"actor": r.s.client.actorFor(ctx), "edges": edges}
	if err := r.s.client.do(ctx, http.MethodPost, "/dependencies:add", nil, body, &out); err != nil {
		return issueops.AddDependenciesResult{}, fillEdgeConflict(err, req.Edges)
	}
	added := make([]issueops.DependencyEdge, 0, len(out.Added))
	for _, e := range out.Added {
		added = append(added, issueops.DependencyEdge{IssueID: e.IssueID, DependsOnID: e.DependsOnID, Type: issueops.DependencyType(e.Type)})
	}
	return issueops.AddDependenciesResult{Added: added}, nil
}

// fillEdgeConflict names the pair a type-conflict refusal could not: the wire
// carries the two types but not the edge, and a single-edge request has only one
// candidate.
func fillEdgeConflict(err error, edges []issueops.DependencyEdge) error {
	var conflict *issueops.DependencyTypeConflictError
	if errors.As(err, &conflict) && conflict.IssueID == "" && len(edges) == 1 {
		conflict.IssueID = edges[0].IssueID
		conflict.DependsOnID = edges[0].DependsOnID
	}
	return err
}

func (r dependencyEditorRole) RemoveDependency(ctx context.Context, req issueops.RemoveDependencyRequest) (issueops.RemoveDependencyResult, error) {
	if err := r.s.writeRefused("DependencyEditor.RemoveDependency"); err != nil {
		return issueops.RemoveDependencyResult{}, err
	}
	ctx = WithActor(ctx, req.Actor)
	var out struct {
		Removed bool `json:"removed"`
	}
	body := map[string]any{"actor": r.s.client.actorFor(ctx), "issue_id": req.IssueID, "depends_on_id": req.DependsOnID}
	if err := r.s.client.do(ctx, http.MethodPost, "/dependencies:remove", nil, body, &out); err != nil {
		return issueops.RemoveDependencyResult{}, err
	}
	return issueops.RemoveDependencyResult{Removed: out.Removed}, nil
}
