package cloudflare

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/steveyegge/beads/backend"
	"github.com/steveyegge/beads/issueops"
)

// This file holds the field-for-field mapping of upstream's create and update
// requests onto the wire, and the checks that make a request fail before anything
// is written. The rule is the one the whole adapter follows: a member is carried
// to the server, or the request is refused with a typed error before the first
// write. It is never accepted and dropped, because a create that "succeeds" with
// half its fields is the one failure a tracker holding the organization's work
// cannot afford.

// ----------------------------------------------------------------- create fields

// issueFieldsNoWire names the members of an Issue the create operation has no
// wire member for. A request that sets one is refused. Members upstream's create
// itself ignores (content hash, row version, lease state, compaction state,
// routing overrides, hydration flags, derived fields) are not listed: setting
// them changes nothing there either.
func issueFieldsNoWire(i *backend.Issue) []string {
	var set []string
	add := func(name string, ok bool) {
		if ok {
			set = append(set, name)
		}
	}
	// Everything else a create can carry rides the wire's own members or its
	// x_extra object (see issueExtra); these two have no member on a create.
	add("close_reason", i.CloseReason != "")
	add("closed_by_session", i.ClosedBySession != "")
	return set
}

// refuseCreate checks, before any request, that every member of a create
// request has somewhere to go.
func refuseCreate(op string, req issueops.CreateRequest) error {
	i := req.Issue
	if len(i.Comments) > 0 || len(i.Dependencies) > 0 {
		// Upstream's rule: edges travel in the request's own Dependencies, and a
		// comment is its own operation. Dropping either would lose it silently.
		return invalidf("%s: Issue.Comments and Issue.Dependencies must be empty; supply edges through the request's Dependencies and comments through AddComment", op)
	}
	for _, d := range req.Dependencies {
		if d.ThreadID != "" {
			return unsupportedField(op, "dependencies.thread_id")
		}
	}
	if fields := issueFieldsNoWire(i); len(fields) > 0 {
		return unsupportedField(op, strings.Join(fields, ", "))
	}
	// updated_at is not a wire member: the server writes it equal to created_at.
	if !i.UpdatedAt.IsZero() && !i.UpdatedAt.Equal(i.CreatedAt) {
		return unsupportedField(op, "updated_at: the server stamps it equal to created_at")
	}
	return nil
}

// createRequestFor encodes a create request as the wire body, member by member.
// preserveAuthor sends the issue's created_by with the timestamps even when no
// timestamp is carried (the raw CreateIssue's convention).
func createRequestFor(req issueops.CreateRequest, actor string, preserveAuthor bool) createRequest {
	issue := req.Issue
	body := createRequest{
		Actor:              actor,
		Title:              issue.Title,
		ID:                 issue.ID,
		Description:        issue.Description,
		Design:             issue.Design,
		AcceptanceCriteria: issue.AcceptanceCriteria,
		Notes:              issue.Notes,
		IssueType:          string(issue.IssueType),
		Status:             string(issue.Status),
		Priority:           issue.Priority,
		Assignee:           issue.Assignee,
		Owner:              issue.Owner,
		Labels:             issue.Labels,
		EstimatedMinutes:   issue.EstimatedMinutes,
		ExternalRef:        derefString(issue.ExternalRef),
		DueAt:              issue.DueAt,
		DeferUntil:         issue.DeferUntil,
		Metadata:           rawOrNil(issue.Metadata),
		Sender:             issue.Sender,
		NoHistory:          issue.NoHistory,
		Ephemeral:          issue.Ephemeral,
		ParentID:           req.ParentID,
		InheritLabels:      req.InheritLabelsFromParent,
		// A caller-supplied prefix replaces the server's own for the explicit id,
		// which the profile spells as "do not check the id against the prefix". An id
		// that prefix does not admit is not refused here: the server checks it against
		// its own prefix and allowed_prefixes, which this client cannot see, and its
		// refusal comes back as upstream's prefix-mismatch error.
		ForceIDPrefix: req.ForceIDPrefix || (req.IDPrefix != "" && issue.ID != "" && prefixAdmits(issue.ID, req.IDPrefix)),
	}
	if req.WaitsFor != nil {
		body.WaitsFor = &createWaitsFor{SpawnerID: req.WaitsFor.SpawnerID, Gate: req.WaitsFor.Gate}
	}
	for _, dep := range req.Dependencies {
		d := createDependency{TargetID: dep.TargetID, Type: string(dep.Type), Reverse: dep.Reverse}
		if dep.Metadata != "" {
			d.Metadata = json.RawMessage(dep.Metadata)
		}
		body.Dependencies = append(body.Dependencies, d)
	}
	// An imported issue keeps the age and the author it was created with. A zero
	// time is not a time: sending it would store year one as the issue's age.
	if !issue.CreatedAt.IsZero() {
		created := issue.CreatedAt
		body.CreatedAt = &created
	}
	body.StartedAt = issue.StartedAt
	body.ClosedAt = issue.ClosedAt
	if body.CreatedAt != nil || body.StartedAt != nil || body.ClosedAt != nil || (preserveAuthor && issue.CreatedBy != "") {
		body.PreserveTimestamps = true
		body.OriginalCreatedBy = issue.CreatedBy
	}
	return body
}

// prefixAdmits is upstream's rule (issueops.ValidateIssueIDPrefix: the id starts
// with the prefix and a hyphen), also read for a prefix configured with its
// trailing hyphen.
func prefixAdmits(id, prefix string) bool {
	return strings.HasPrefix(id, prefix+"-") || (strings.HasSuffix(prefix, "-") && strings.HasPrefix(id, prefix))
}

// ------------------------------------------------------------ update validation

var metadataKeyRe = regexp.MustCompile(`^[a-zA-Z_][a-zA-Z0-9_./]*$`)

// maxFieldLen is the bound upstream puts on a short text member, in characters.
const maxFieldLen = 255

func checkFieldLen(name, value string) error {
	if n := utf8.RuneCountInString(value); n > maxFieldLen {
		return invalidf("%s is %d characters (max %d)", name, n, maxFieldLen)
	}
	return nil
}

// validateUpdate refuses, before a claim or a patch is sent, every update the
// server would refuse for a reason this client can see: the checks upstream runs
// first (ValidateUpdateRequest, the metadata rules, the field bounds) and the
// shapes the wire does not accept. A claim that committed before its patch failed
// is state the caller never asked to leave behind.
func validateUpdate(op string, req issueops.UpdateRequest) error {
	p := req.Patch
	if req.Claim && (req.ExpectedAssignee != nil || req.ExpectedStatus != nil) {
		return invalidf("%s: a claim cannot use expected assignee or status", op)
	}
	if req.ForceAssigneeTransfer && (req.Claim || !p.Assignee.Set || req.ExpectedAssignee != nil) {
		return invalidf("%s: invalid forced assignee transfer", op)
	}
	if p.Title.Set {
		if p.Title.Value == "" || len(p.Title.Value) > 500 {
			return invalidf("%s: title must be 1 to 500 bytes (got %d)", op, len(p.Title.Value))
		}
	}
	if p.Priority.Set && (p.Priority.Value < 0 || p.Priority.Value > 4) {
		return invalidf("%s: priority must be between 0 and 4 (got %d)", op, p.Priority.Value)
	}
	if p.EstimatedMinutes.Set && p.EstimatedMinutes.Value != nil && *p.EstimatedMinutes.Value < 0 {
		return invalidf("%s: estimated_minutes cannot be negative", op)
	}
	if p.Notes.Set && p.AppendNotes.Set {
		return invalidf("%s: notes and append_notes are mutually exclusive", op)
	}
	if p.Status.Set && p.Status.Value == "" {
		return invalidf("%s: status must not be empty", op)
	}
	if p.IssueType.Set && p.IssueType.Value == "" {
		return invalidf("%s: issue_type must not be empty", op)
	}
	for name, field := range map[string]issueops.Field[string]{"assignee": p.Assignee} {
		if field.Set {
			if err := checkFieldLen(name, field.Value); err != nil {
				return fmt.Errorf("%s: %w", op, err)
			}
		}
	}
	if p.ExternalRef.Set && p.ExternalRef.Value != nil {
		if err := checkFieldLen("external_ref", *p.ExternalRef.Value); err != nil {
			return fmt.Errorf("%s: %w", op, err)
		}
	}
	labels := slices.Concat(p.Labels.Add, p.Labels.Remove, p.Labels.Replace.Value)
	for _, label := range labels {
		if err := checkFieldLen("label", label); err != nil {
			return fmt.Errorf("%s: %w", op, err)
		}
	}
	return validateMetadataPatch(op, p.Metadata)
}

func validateMetadataPatch(op string, m issueops.MetadataPatch) error {
	if m.Replace.Set && (m.Merge.Set || len(m.Set) > 0 || len(m.Unset) > 0) {
		return invalidf("%s: cannot combine metadata replacement with incremental metadata edits", op)
	}
	object := func(what string, raw json.RawMessage) error {
		var doc map[string]json.RawMessage
		if err := json.Unmarshal(raw, &doc); err != nil || doc == nil {
			return invalidf("%s: metadata %s must be a JSON object", op, what)
		}
		return nil
	}
	if m.Replace.Set && len(strings.TrimSpace(string(m.Replace.Value))) > 0 {
		if !json.Valid(m.Replace.Value) {
			return invalidf("%s: metadata replacement is not valid JSON", op)
		}
		if err := object("replacement", m.Replace.Value); err != nil {
			return err
		}
	}
	if m.Merge.Set {
		if err := object("merge", m.Merge.Value); err != nil {
			return err
		}
	}
	for key, value := range m.Set {
		if !metadataKeyRe.MatchString(key) {
			return invalidf("%s: invalid metadata key %q: must match %s", op, key, metadataKeyRe)
		}
		if !json.Valid(value) {
			return invalidf("%s: metadata value for key %q is not valid JSON", op, key)
		}
	}
	for _, key := range m.Unset {
		if !metadataKeyRe.MatchString(key) {
			return invalidf("%s: invalid metadata key %q: must match %s", op, key, metadataKeyRe)
		}
	}
	return nil
}

// prepareCreate refuses what cannot be carried, builds the wire body, and checks
// the server can take the members that depend on an extension. Nothing is sent.
func (s *Store) prepareCreate(ctx context.Context, op string, req issueops.CreateRequest, actor string, preserveAuthor bool) (createRequest, error) {
	if err := refuseCreate(op, req); err != nil {
		return createRequest{}, err
	}
	body := createRequestFor(req, actor, preserveAuthor)
	if extra := issueExtra(req.Issue); extra != nil {
		if err := s.requireCapability(ctx, op, capXExtra); err != nil {
			return createRequest{}, err
		}
		body.XExtra = extra
	}
	return body, nil
}
