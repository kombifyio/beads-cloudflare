package cloudflare

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/steveyegge/beads/backend"
	"github.com/steveyegge/beads/issueops"
)

// Store implements the Beads storage engine interface over one Cloudflare
// tracker.
//
// It implements exactly what the Worker serves, which is a declared profile of
// the upstream `bd serve` /v0 contract: issue CRUD, dependencies, comments,
// readiness, memories and events. Everything else answers a typed
// ErrUnsupported rather than an approximation, because a backend that guesses at
// a semantic it cannot honour is worse than one that refuses: the caller gets a
// denial it can act on instead of a subtly wrong answer.
type Store struct {
	client   *Client
	readOnly bool

	mu     sync.Mutex
	closed bool
	local  *localMeta

	// cache holds rows read in bulk for the relation reads of the same command;
	// noExport is set once the server answered 404 to an export route.
	cache    snapshotCache
	noExport atomic.Bool

	// caps is the server capability document, read once.
	caps capabilityBook

	// lastInfra is the last good answer of GetInfraTypes.
	lastInfra map[string]bool
}

// New builds a Store for one tracker.
func New(base, tracker, token, actor string, readOnly bool) (*Store, error) {
	if base == "" {
		return nil, fmt.Errorf("cloudflare backend: no base URL configured")
	}
	if tracker == "" {
		return nil, fmt.Errorf("cloudflare backend: no tracker configured")
	}
	if token == "" {
		return nil, fmt.Errorf("cloudflare backend: no credential configured")
	}
	if actor == "" {
		actor = "bd"
	}
	return &Store{client: NewClient(base, tracker, token, actor), readOnly: readOnly}, nil
}

// unsupported builds the refusal every unimplemented method returns. The reason
// is not carried on the error: upstream's ErrUnsupported has only Op and Backend,
// and the per-method reasons live in the allowlists convert.go exposes to the
// conformance suite.
func (s *Store) unsupported(method, reason string) error {
	return &backend.ErrUnsupported{Op: method, Backend: "cloudflare"}
}

// notImplemented is the reason for a method the /v0 profile does not serve.
const notImplemented = "the /v0 profile served by kombifyio/beads-cloudflare does not implement this operation"

// writeRefused refuses a write on a read-only handle.
func (s *Store) writeRefused(method string) error {
	if !s.readOnly {
		return nil
	}
	return s.unsupported(method, "this handle was opened read-only")
}

func (s *Store) checkOpen(method string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return fmt.Errorf("cloudflare backend: %s called on a closed store", method)
	}
	return nil
}

// ------------------------------------------------------------------ lifecycle

func (s *Store) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.closed = true
	return nil
}

func (s *Store) Path() string     { return s.client.base + "/t/" + s.client.tracker }
func (s *Store) CLIDir() string   { return s.client.tracker }
func (s *Store) Database() string { return s.client.tracker }
func (s *Store) Backend() string  { return "cloudflare" }
func (s *Store) Active() bool     { return !s.closed }
func (s *Store) IsReadOnly() bool { return s.readOnly }

// ---------------------------------------------------------------- issue reads

// GetIssue reads one issue with its labels. The row is decoded whole: a member
// the server sends is a member the caller gets.
func (s *Store) GetIssue(ctx context.Context, id string) (*backend.Issue, error) {
	if err := s.checkOpen("GetIssue"); err != nil {
		return nil, err
	}
	var out backend.IssueDetails
	if err := s.client.do(ctx, http.MethodGet, issuePath(id), nil, nil, &out); err != nil {
		return nil, err
	}
	issue := out.Issue
	issue.RowVersion = parseRevision(out.Revision)
	issue.Labels = out.Labels
	return &issue, nil
}

// ListIssues returns one page plus the cursor for the next.
func (s *Store) ListIssues(ctx context.Context, limit int, status []string, cursor string) ([]*backend.Issue, string, bool, error) {
	if err := s.checkOpen("ListIssues"); err != nil {
		return nil, "", false, err
	}
	q := newQuery().csv("status", status...).str("cursor", cursor)
	if limit > 0 {
		q.v.Set("limit", itoa(limit))
	}
	page, err := s.getPage(ctx, "/issues", q.values())
	if err != nil {
		return nil, "", false, err
	}
	return issuesOf(page.Items), page.NextCursor, page.HasMore, nil
}

// ---------------------------------------------------------------- issue writes

// CreateIssue creates an issue over the create role, so the raw method and the
// role carry the same members and refuse the same ones. The row the server stored
// is adopted, so the caller sees the canonical issue. A caller-supplied id is
// kept, outside the configured prefix when need be.
func (s *Store) CreateIssue(ctx context.Context, issue *backend.Issue, actor string) error {
	if err := s.writeRefused("CreateIssue"); err != nil {
		return err
	}
	if err := s.checkOpen("CreateIssue"); err != nil {
		return err
	}
	req := issueops.CreateRequest{Actor: actor, Issue: issue, ForceIDPrefix: issue.ID != ""}
	ctx = WithActor(ctx, actor)
	// The raw method has always carried the issue author with it, so that an
	// issue keeps the authorship it was created with.
	body, err := s.prepareCreate(ctx, "CreateIssue", req, s.client.actorFor(ctx), true)
	if err != nil {
		return err
	}
	var stored backend.Issue
	if err := s.client.do(ctx, http.MethodPost, "/issues", nil, body, &stored); err != nil {
		return err
	}
	*issue = stored
	return nil
}

// CreateIssues writes a batch. The profile has no batch create that carries every
// member of an issue, so each issue is created in turn; every issue is checked
// before the first is written, and a failure names the issue that stopped the
// batch rather than reporting a partial write as a success.
func (s *Store) CreateIssues(ctx context.Context, issues []*backend.Issue, actor string) error {
	if err := s.writeRefused("CreateIssues"); err != nil {
		return err
	}
	for _, issue := range issues {
		if err := refuseCreate("CreateIssues", issueops.CreateRequest{Actor: actor, Issue: issue, ForceIDPrefix: issue.ID != ""}); err != nil {
			return fmt.Errorf("create %s: %w", issue.ID, err)
		}
	}
	for _, issue := range issues {
		if err := s.CreateIssue(ctx, issue, actor); err != nil {
			return fmt.Errorf("create %s: %w", issue.ID, err)
		}
	}
	return nil
}

func (s *Store) GetVersion(ctx context.Context, id string) (int64, error) {
	issue, err := s.readIssue(ctx, id)
	if err != nil {
		return 0, err
	}
	return issue.RowVersion, nil
}

func (s *Store) CloseIssueChecked(ctx context.Context, issueID, reason string, options backend.CloseIssueOptions) (backend.CloseIssueResult, error) {
	if err := s.writeRefused("CloseIssueChecked"); err != nil {
		return backend.CloseIssueResult{}, err
	}
	if reason == "" {
		reason = options.Reason
	}
	out, err := (lifecycleRole{s}).Close(ctx, issueops.CloseRequest{
		IssueID: issueID, Reason: reason, Session: options.Session, Force: options.Force, ExpectedVersion: options.ExpectedVersion,
	})
	if err != nil {
		return backend.CloseIssueResult{}, err
	}
	return backend.CloseIssueResult{Unchanged: !out.Changed, OpenChildren: out.OpenChildren}, nil
}

func (s *Store) CloseIssue(ctx context.Context, id, reason, actor, session string) error {
	if err := s.writeRefused("CloseIssue"); err != nil {
		return err
	}
	_, err := (lifecycleRole{s}).Close(ctx, issueops.CloseRequest{Actor: actor, IssueID: id, Reason: reason, Session: session})
	return err
}

func (s *Store) ClaimIssue(ctx context.Context, id, actor string) error {
	if err := s.writeRefused("ClaimIssue"); err != nil {
		return err
	}
	_, err := (claimerRole{s}).Claim(ctx, issueops.ClaimRequest{Actor: actor, IssueID: id})
	return err
}

func (s *Store) ReleaseIssue(ctx context.Context, id, actor string) error {
	if err := s.writeRefused("ReleaseIssue"); err != nil {
		return err
	}
	_, err := (releaserRole{s}).Release(ctx, issueops.ReleaseRequest{Actor: actor, IssueID: id})
	return err
}

// HeartbeatIssue renews this principal's lease on an issue it already holds.
//
// The lease length is the store's default rather than the caller's. Beads lets a
// caller override it with issueops.WithLeaseTTL, but that value lives in the
// context under an unexported key type in internal/storage/issueops, and at
// v1.3.1 no public package exposes a reader for it. An out-of-tree backend
// therefore cannot honour a caller-supplied TTL at all: the key cannot even be
// named, let alone constructed. Sending no x_lease_seconds leaves the server on
// its default, which is the honest behaviour; inventing a TTL here would
// silently claim to honour an override it never read.
//
// The fix belongs upstream: export the reader next to WithLeaseTTL. It is a
// one-line addition to a public package and unblocks every out-of-tree backend.
func (s *Store) HeartbeatIssue(ctx context.Context, id, actor string) error {
	if err := s.writeRefused("HeartbeatIssue"); err != nil {
		return err
	}
	body := map[string]any{"actor": pickActor(actor, s.client.actor)}
	_, err := s.client.CustomOp(ctx, id, "heartbeat", body)
	return err
}

// ReclaimExpiredLeases reverts claims whose lease has expired and reports the
// holder each one had.
//
// olderThan is signed on purpose: a negative age moves the cutoff into the
// future, so a caller can reclaim a fresh lease without waiting one out. That is
// how a test or an operator forces a sweep; an ordinary reaper passes zero and
// only ever sees leases that already expired.
func (s *Store) ReclaimExpiredLeases(ctx context.Context, olderThan time.Duration, filter backend.ReclaimFilter, actor string) ([]backend.ReclaimedLease, error) {
	if err := s.writeRefused("ReclaimExpiredLeases"); err != nil {
		return nil, err
	}
	if filter.AnyReplica {
		return nil, unsupportedField("ReclaimExpiredLeases", "AnyReplica: a tracker has no replicas")
	}
	// The route takes one assignee, and the label filters as repeated members:
	// several assignees are one request each, and their answers are joined.
	assignees := filter.Assignees
	if len(assignees) == 0 {
		assignees = []string{""}
	}
	out := []backend.ReclaimedLease{}
	for _, assignee := range assignees {
		query := url.Values{}
		query.Set("older_than", strconv.Itoa(int(olderThan.Seconds())))
		if len(filter.IDs) > 0 {
			query.Set("ids", strings.Join(filter.IDs, ","))
		}
		if assignee != "" {
			query.Set("assignee", assignee)
		}
		for _, l := range filter.Labels {
			query.Add("label", l)
		}
		for _, l := range filter.LabelsAny {
			query.Add("label_any", l)
		}
		for _, l := range filter.ExcludeLabels {
			query.Add("exclude_label", l)
		}
		var res struct {
			Reclaimed []struct {
				ID            string `json:"id"`
				PreviousOwner string `json:"previous_owner"`
			} `json:"reclaimed"`
		}
		body := map[string]any{"actor": pickActor(actor, s.client.actor)}
		if err := s.client.do(ctx, http.MethodPost, "/leases:reclaim", query, body, &res); err != nil {
			return out, err
		}
		for _, r := range res.Reclaimed {
			out = append(out, backend.ReclaimedLease{ID: r.ID, PreviousOwner: r.PreviousOwner})
		}
	}
	return out, nil
}

func (s *Store) ReopenIssue(ctx context.Context, id, actor, reason string) error {
	if err := s.writeRefused("ReopenIssue"); err != nil {
		return err
	}
	_, err := (lifecycleRole{s}).Reopen(ctx, issueops.ReopenRequest{Actor: actor, IssueID: id, Reason: reason})
	return err
}

func (s *Store) AddComment(ctx context.Context, issueID, author, text string) error {
	if err := s.writeRefused("AddComment"); err != nil {
		return err
	}
	_, err := s.AddIssueComment(ctx, issueID, author, text)
	return err
}

func (s *Store) AddIssueComment(ctx context.Context, issueID, author, text string) (*backend.Comment, error) {
	if err := s.writeRefused("AddIssueComment"); err != nil {
		return nil, err
	}
	if err := s.checkOpen("AddIssueComment"); err != nil {
		return nil, err
	}
	out, err := (commenterRole{s}).AddComment(ctx, issueops.AddCommentRequest{Author: author, IssueID: issueID, Text: text})
	if err != nil {
		return nil, err
	}
	return out.Comment, nil
}

// RemoveLabel drops one label, which the profile expresses as a patch member.
func (s *Store) RemoveLabel(ctx context.Context, issueID, label, actor string) error {
	if err := s.writeRefused("RemoveLabel"); err != nil {
		return err
	}
	_, err := (lifecycleRole{s}).Update(ctx, issueops.UpdateRequest{Actor: actor, IssueID: issueID,
		Patch: issueops.IssuePatch{Labels: issueops.LabelPatch{Remove: []string{label}}}})
	return err
}

// AddLabel is a label add on its own. The profile edits labels through the
// issue patch (add_labels/remove_labels), so this maps onto the same write rather
// than declaring an operation the Worker does not serve.
func (s *Store) AddLabel(ctx context.Context, issueID, label, actor string) error {
	if err := s.writeRefused("AddLabel"); err != nil {
		return err
	}
	_, err := (lifecycleRole{s}).Update(ctx, issueops.UpdateRequest{Actor: actor, IssueID: issueID,
		Patch: issueops.IssuePatch{Labels: issueops.LabelPatch{Add: []string{label}}}})
	return err
}

// GetIssueComments returns one issue's comment thread in chronological order.
//
// The profile has no comments listing verb; getIssue carries the thread when
// asked for it, and the server orders it, so this is a read of what the profile
// already serves rather than a new endpoint.
func (s *Store) GetIssueComments(ctx context.Context, issueID string) ([]*backend.Comment, error) {
	if err := s.checkOpen("GetIssueComments"); err != nil {
		return nil, err
	}
	var out backend.IssueDetails
	if err := s.client.do(ctx, http.MethodGet, issuePath(issueID), newQuery().flag("include_comments", true).values(), nil, &out); err != nil {
		return nil, err
	}
	if out.CommentsOmitted != nil && *out.CommentsOmitted {
		return nil, fmt.Errorf("issue %s: the server held back its comments although they were asked for: %w", issueID, backend.ErrValidation)
	}
	for _, c := range out.Comments {
		if c.IssueID == "" {
			c.IssueID = issueID
		}
	}
	return out.Comments, nil
}

// GetLabels returns one issue's labels: the row's own label set.
func (s *Store) GetLabels(ctx context.Context, issueID string) ([]string, error) {
	issue, err := s.GetIssue(ctx, issueID)
	if err != nil {
		return nil, err
	}
	return issue.Labels, nil
}

// --------------------------------------------------------------- dependencies

// ---------------------------------------------------------------- memories

func (s *Store) GetMemories(ctx context.Context) (map[string]string, error) {
	if err := s.checkOpen("GetMemories"); err != nil {
		return nil, err
	}
	raw, err := s.client.ListMemories(ctx)
	if err != nil {
		return nil, err
	}
	return memoriesFromMap(raw), nil
}

func (s *Store) GetMemory(ctx context.Context, key string) (string, error) {
	if err := s.checkOpen("GetMemory"); err != nil {
		return "", err
	}
	raw, err := s.client.Memory(ctx, key)
	if err != nil {
		return "", err
	}
	return strOf(raw["value"]), nil
}

func (s *Store) Remember(ctx context.Context, key, value string) error {
	if err := s.writeRefused("Remember"); err != nil {
		return err
	}
	return s.client.Remember(ctx, key, value)
}

func (s *Store) Forget(ctx context.Context, key string) error {
	if err := s.writeRefused("Forget"); err != nil {
		return err
	}
	return s.client.Forget(ctx, key)
}

// ---------------------------------------------------------------- events

// Store must satisfy the full engine interface. This assertion is the point of
// the type: if a Beads upgrade adds a required method, the build fails here
// rather than at the moment some agent reaches it.
var _ backend.DoltStorage = (*Store)(nil)

// ------------------------------------------------------- profile-served reads

// GetIssuesByIDs reads several issues by id. The profile has no batch read, so
// this is one getIssue per id; a missing id is left out of the result rather
// than failing the batch, which is what a caller reading a known set of ids
// wants.
func (s *Store) GetIssuesByIDs(ctx context.Context, ids []string) ([]*backend.Issue, error) {
	if err := s.checkOpen("GetIssuesByIDs"); err != nil {
		return nil, err
	}
	out := make([]*backend.Issue, 0, len(ids))
	// Callers decide writes from this read (an import checks every id of its batch
	// against the tracker before it writes), so it is always fresh: it never reads
	// the bulk-read cache. With the export route a hundred ids are one request.
	if len(ids) > 1 && !s.noExport.Load() {
		byID := map[string]*backend.Issue{}
		for start := 0; start < len(ids); start += exportIDsPerCall {
			q := allIssueValues()
			q.Set("ids", strings.Join(ids[start:min(start+exportIDsPerCall, len(ids))], ","))
			q.Set("revision", "true")
			q.Set("limit", itoa(exportIDsPerCall))
			err := s.eachExportPage(ctx, q, func(page exportRecords) {
				for _, item := range page.Items {
					byID[item.ID] = item.Issue
				}
			})
			if errors.Is(err, errNoExport) {
				return s.issuesByIDOneByOne(ctx, ids)
			}
			if err != nil {
				return nil, err
			}
		}
		for _, id := range ids {
			if issue, found := byID[id]; found {
				out = append(out, issue)
			}
		}
		return out, nil
	}
	return s.issuesByIDOneByOne(ctx, ids)
}

func (s *Store) issuesByIDOneByOne(ctx context.Context, ids []string) ([]*backend.Issue, error) {
	out := make([]*backend.Issue, 0, len(ids))
	for _, id := range ids {
		issue, err := s.GetIssue(ctx, id)
		if err != nil {
			if isNotFound(err) {
				continue
			}
			return nil, err
		}
		out = append(out, issue)
	}
	return out, nil
}

// GetIssueByExternalRef resolves an issue by its external reference. The profile's
// list has no external_ref filter, so the rows are read in full pages and matched
// client-side: correct and linear in the size of the tracker. Every tier is read,
// so a template, a gate or an infrastructure row is found too.
func (s *Store) GetIssueByExternalRef(ctx context.Context, ref string) (*backend.Issue, error) {
	if err := s.checkOpen("GetIssueByExternalRef"); err != nil {
		return nil, err
	}
	items, err := s.search(ctx, "", backend.IssueFilter{ExternalRef: &ref})
	if err != nil {
		return nil, err
	}
	if len(items) == 0 {
		return nil, fmt.Errorf("no issue carries external_ref %q: %w", ref, backend.ErrNotFound)
	}
	return items[0].Issue, nil
}

// ---------------------------------------------------- profile-served writes

// UpdateIssueType changes an issue's type, which is a patch of one member.
func (s *Store) UpdateIssueType(ctx context.Context, id, issueType, actor string) error {
	if err := s.writeRefused("UpdateIssueType"); err != nil {
		return err
	}
	if err := s.checkOpen("UpdateIssueType"); err != nil {
		return err
	}
	_, err := (lifecycleRole{s}).Update(ctx, issueops.UpdateRequest{Actor: actor, IssueID: id,
		Patch: issueops.IssuePatch{IssueType: issueops.Field[issueops.IssueType]{Set: true, Value: issueops.IssueType(issueType)}}})
	return err
}

// UnclaimIssue releases a claim.
func (s *Store) UnclaimIssue(ctx context.Context, id, actor string, force bool) error {
	if err := s.writeRefused("UnclaimIssue"); err != nil {
		return err
	}
	_, err := (releaserRole{s}).Release(ctx, issueops.ReleaseRequest{Actor: actor, IssueID: id, Force: force})
	return err
}

// UnclaimIssueIfAssignee releases a claim only while the issue is still held by
// expectedAssignee, which is the compare-and-set a supervisor returning a dead
// worker's bead depends on. The guard travels with the release, so the check and
// the release are one server operation: a release that lost the race to another
// claimant refuses with ErrAssigneeMismatch and writes nothing.
func (s *Store) UnclaimIssueIfAssignee(ctx context.Context, id, actor, expectedAssignee string) error {
	if err := s.writeRefused("UnclaimIssueIfAssignee"); err != nil {
		return err
	}
	_, err := (releaserRole{s}).Release(ctx, issueops.ReleaseRequest{Actor: actor, IssueID: id, ExpectedAssignee: &expectedAssignee})
	return err
}

// textMatches is the match rule: an empty query matches everything, and otherwise
// every whitespace-separated term must appear somewhere in the searchable text,
// case-insensitively. Terms are ANDed rather than ORed so a multi-word query
// narrows rather than widens.
func textMatches(issue *backend.Issue, query string) bool {
	terms := strings.Fields(strings.ToLower(query))
	if len(terms) == 0 {
		return true
	}
	haystack := strings.ToLower(strings.Join([]string{
		issue.ID, issue.Title, issue.Description, issue.Design,
		issue.AcceptanceCriteria, issue.Notes, derefString(issue.ExternalRef),
	}, " "))
	for _, term := range terms {
		if !strings.Contains(haystack, term) {
			return false
		}
	}
	return true
}
