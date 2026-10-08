package cloudflare

import (
	"context"
	"fmt"
	"math"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strings"

	"github.com/steveyegge/beads/backend"
	"github.com/steveyegge/beads/issueops"
)

// The read roles. List, ready and query answer a page of issues; the rest are
// graph and statistics reads. The wire list understands a narrower filter than
// the role's ListRequest, so a request that names a predicate the wire does not
// carry is answered by paging the wire result and filtering it here.

type readerRole struct {
	s *Store
	// noBlocked leaves is_blocked out of a bulk read: internal callers that
	// never look at it skip the server's graph walk.
	noBlocked bool
}

func (s *Store) IssueReader() (issueops.Reader, error) {
	return readerRole{s: s}, s.checkOpen("IssueReader")
}

func (s *Store) Counter() (issueops.Counter, error) { return counterRole{s}, s.checkOpen("Counter") }
func (s *Store) ReadyCounter() (issueops.ReadyCounter, error) {
	return readyCounterRole{s}, s.checkOpen("ReadyCounter")
}
func (s *Store) Querier() (issueops.Querier, error) { return querierRole{s}, s.checkOpen("Querier") }
func (s *Store) StatsReporter() (issueops.StatsReporter, error) {
	return statsRole{s}, s.checkOpen("StatsReporter")
}
func (s *Store) IssueRelations() (issueops.Relations, error) {
	return relationsRole{s}, s.checkOpen("IssueRelations")
}
func (s *Store) EdgeReader() (issueops.EdgeReader, error) {
	return edgeReaderRole{s}, s.checkOpen("EdgeReader")
}
func (s *Store) BlockingAnnotator() (issueops.BlockingAnnotator, error) {
	return blockingRole{s}, s.checkOpen("BlockingAnnotator")
}
func (s *Store) TreeWalker() (issueops.TreeWalker, error) {
	return treeRole{s}, s.checkOpen("TreeWalker")
}
func (s *Store) CycleDetector() (issueops.CycleDetector, error) {
	return cycleRole{s}, s.checkOpen("CycleDetector")
}
func (s *Store) GraphCounter() (issueops.GraphCounter, error) {
	return graphCounterRole{s}, s.checkOpen("GraphCounter")
}

// pageSize is the page the client asks for when it has to read everything.
const pageSize = 200

// The shared defaults upstream's front doors register for a request that names
// no limit: workapi.DefaultListLimit, DefaultQueryLimit and DefaultReadyLimit.
const (
	defaultListLimit  = 50
	defaultQueryLimit = 50
	defaultReadyLimit = 100
)

// unboundedLimit is what an unlimited read asks the server for where the route
// has no cursor (ready, query): a bound no tracker reaches, and the answer's
// has_more is checked, so a truncated read is an error and never a short answer.
const unboundedLimit = math.MaxInt32

type issuesPage struct {
	Items      []*backend.IssueWithCounts `json:"items"`
	HasMore    bool                       `json:"has_more"`
	NextCursor string                     `json:"next_cursor"`
}

func (s *Store) getPage(ctx context.Context, path string, q url.Values) (issuesPage, error) {
	var page issuesPage
	err := s.client.do(ctx, http.MethodGet, path, q, nil, &page)
	return page, err
}

// effectiveLimit resolves a request's limit: nil is the shared default, zero is
// unlimited (reported as 0), a negative limit is refused.
func effectiveLimit(limit *int, fallback int) (int, error) {
	switch {
	case limit == nil:
		return fallback, nil
	case *limit < 0:
		return 0, invalidf("limit %d is negative; use 0 for no limit", *limit)
	}
	return *limit, nil
}

// window cuts the page [offset, offset+limit) out of rows, limit 0 meaning to the
// end, and reports whether rows follow it.
func window(items []*backend.IssueWithCounts, offset, limit int) ([]*backend.IssueWithCounts, bool) {
	if offset > 0 {
		if offset >= len(items) {
			return nil, false
		}
		items = items[offset:]
	}
	if limit > 0 && len(items) > limit {
		return items[:limit], true
	}
	return items, false
}

// ---------------------------------------------------------------------- ready

// readySelection is the client-side part of a ready request: the filters the
// ready routes do not carry.
func readySelection(req issueops.ReadyRequest) *selection {
	sel := &selection{}
	if req.MolType != nil {
		want := *req.MolType
		sel.addIssue(func(i *backend.Issue) bool { return i.MolType == want })
	}
	return sel
}

// readyRows runs one ready read. The routes have no cursor and no offset, so the
// head of the set is read and the window cut here; rows the client-side tests
// reject are removed before the window, which is why a test makes the read
// unbounded.
func (s *Store) readyRows(ctx context.Context, req issueops.ReadyRequest, sel *selection, statuses map[string]bool, maxRows int, maxRowsSource string) (issueops.IssuePage, error) {
	limit, err := effectiveLimit(req.Limit, defaultReadyLimit)
	if err != nil {
		return issueops.IssuePage{}, err
	}
	if req.Offset < 0 {
		return issueops.IssuePage{}, invalidf("offset %d is negative", req.Offset)
	}
	policy := req.Sort
	switch policy {
	case "":
		// Empty resolves to hybrid at the storage layer; no front door relies on it.
		policy = "hybrid"
	case "hybrid", "priority", "oldest":
	default:
		return issueops.IssuePage{}, invalidf("ready sort %q is not hybrid, priority or oldest", req.Sort)
	}
	q := readyParams(req).str("sort", policy)
	needsAll := sel.local() || len(statuses) > 0 || maxRows > 0
	brief := req.Brief && !sel.needsText
	q.flag("brief", brief)

	read := func(bound int) (issuesPage, error) {
		q.v.Set("limit", itoa(bound))
		return s.getPage(ctx, "/ready", q.values())
	}
	var items []*backend.IssueWithCounts
	more := false
	if needsAll || limit == 0 {
		page, err := read(unboundedLimit)
		if err != nil {
			return issueops.IssuePage{}, err
		}
		if page.HasMore {
			return issueops.IssuePage{}, fmt.Errorf("the ready set did not fit one read although no bound was asked for: %w", backend.ErrValidation)
		}
		items = page.Items
		if len(statuses) > 0 {
			kept := items[:0:0]
			for _, item := range items {
				if item != nil && item.Issue != nil && statuses[string(item.Status)] {
					kept = append(kept, item)
				}
			}
			items = kept
		}
		items = sel.filter(items)
		if err := checkMaxRows(len(items), maxRows, limit, req.Offset, maxRowsSource); err != nil {
			return issueops.IssuePage{}, err
		}
		items, more = window(items, req.Offset, limit)
	} else {
		page, err := read(limit + req.Offset)
		if err != nil {
			return issueops.IssuePage{}, err
		}
		items, _ = window(page.Items, req.Offset, limit)
		more = page.HasMore
	}
	if req.Brief {
		briefProject(items)
	}
	return issueops.IssuePage{Items: items, HasMore: more}, nil
}

func (r readerRole) Ready(ctx context.Context, req issueops.ReadyRequest) (issueops.IssuePage, error) {
	return r.s.readyRows(ctx, req, readySelection(req), nil, 0, "")
}

// readyFromList answers a list request that asked for the blocker-aware ready
// set. Every field the ready query cannot carry was refused by the caller; what
// is left either rides the wire or is tested here.
func (r readerRole) readyFromList(ctx context.Context, req issueops.ListRequest) (issueops.IssuePage, error) {
	if req.IncludeGates || req.IncludeInfra || req.IncludeAllTypes {
		return issueops.IssuePage{}, unsupportedField("List(ReadyFlag)", "include-gates, include-infra and include-all-types: the ready routes always hold back gates and infrastructure types")
	}
	ready := issueops.ReadyRequest{
		IssueType: req.IssueType, Assignee: req.Assignee, Unassigned: req.NoAssignee,
		Labels: req.Labels, LabelsAny: req.LabelsAny, ExcludeLabels: req.ExcludeLabels,
		LabelPattern: req.LabelPattern, LabelRegex: req.LabelRegex, Priority: req.Priority,
		ParentID: req.ParentID, MolType: req.MolType, IncludeEphemeral: req.IncludeEphemeral,
		ExcludeTypes: req.ExcludeTypes, MetadataFields: req.MetadataFields, HasMetadataKey: req.HasMetadataKey,
		// The list's own sort and limit are display concerns applied to the page
		// below; the ready query keeps its policy, hybrid by default.
		Brief: req.Brief,
	}
	sel := readySelection(ready)
	if req.WispType != nil {
		want := *req.WispType
		sel.addIssue(func(i *backend.Issue) bool { return i.WispType == want })
	}
	if req.NoPinnedFlag {
		sel.addIssue(func(i *backend.Issue) bool { return !i.Pinned })
	}
	// An explicit status is the intersection with the ready set; "all" and no
	// status are the open default the ready query already applies.
	statuses, err := r.s.readyStatusSet(ctx, splitList([]string{req.Status}))
	if err != nil {
		return issueops.IssuePage{}, err
	}
	// The ready query returns its set in its own order; the list's display sort
	// and limit apply to what it returned, as upstream applies them to the page.
	limit, err := effectiveLimit(req.Limit, defaultListLimit)
	if err != nil {
		return issueops.IssuePage{}, err
	}
	if req.Offset < 0 {
		return issueops.IssuePage{}, invalidf("offset %d is negative", req.Offset)
	}
	ready.Limit = &limit
	ready.Offset = req.Offset
	needsDisplay := req.SortBy != "" || req.Reverse
	if needsDisplay {
		if !knownSort(req.SortBy) {
			return issueops.IssuePage{}, invalidf("sort %q is not a list sort", req.SortBy)
		}
		// The display order is applied to the page the query bounded.
		page, err := r.s.readyRows(ctx, ready, sel, statuses, req.MaxRows, req.MaxRowsSource)
		if err != nil {
			return issueops.IssuePage{}, err
		}
		if req.SortBy != "" {
			sortRows(page.Items, req.SortBy)
		}
		if req.Reverse {
			slices.Reverse(page.Items)
		}
		return page, nil
	}
	return r.s.readyRows(ctx, ready, sel, statuses, req.MaxRows, req.MaxRowsSource)
}

// ------------------------------------------------------------------------ list

func (r readerRole) List(ctx context.Context, req issueops.ListRequest) (issueops.IssuePage, error) {
	return r.list(ctx, req, false)
}

// listAll reads every row a request selects, whatever its limit would have asked
// the server for, and trims to the limit afterwards.
func (r readerRole) listAll(ctx context.Context, req issueops.ListRequest) ([]*backend.IssueWithCounts, error) {
	zero := 0
	req.Limit = &zero
	req.Offset = 0
	page, err := r.list(ctx, req, true)
	return page.Items, err
}

// listQuery is the wire half of a list request.
func listQuery(req issueops.ListRequest, wireSort string, serverBrief bool) *query {
	all := req.AllFlag || req.PinnedFlag
	q := newQuery().
		csv("status", req.Status).
		str("type", req.IssueType).
		str("assignee", req.Assignee).
		list("label", req.Labels).
		list("label_any", req.LabelsAny).
		list("exclude_label", req.ExcludeLabels).
		str("parent", req.ParentID).
		flag("brief", serverBrief).
		flag("all", all).
		flag("include_templates", req.IncludeTemplates || req.IncludeAllTypes).
		flag("include_gates", req.IncludeGates || req.IncludeAllTypes).
		flag("include_infra", req.IncludeInfra || req.IncludeAllTypes).
		flag("include_ephemeral", req.IncludeEphemeral || req.IncludeAllTypes).
		stamp("created_before", req.CreatedBefore).
		stamp("created_after", req.CreatedAfter).
		pairs("metadata_field", req.MetadataFields).
		str("has_metadata_key", req.HasMetadataKey).
		str("sort", wireSort)
	return q
}

func (r readerRole) list(ctx context.Context, req issueops.ListRequest, all bool) (issueops.IssuePage, error) {
	if req.ReadyFlag {
		if err := issueops.ValidateReadyFlagScope(req); err != nil {
			return issueops.IssuePage{}, err
		}
		return r.readyFromList(ctx, req)
	}
	return r.listSelected(ctx, req, nil, all)
}

// listSelected is the list over the wire plus the client-side tests, extra being
// further tests a raw filter adds. The order is upstream's: priority, then
// created newest first, then id, unless a sort names another.
func (r readerRole) listSelected(ctx context.Context, req issueops.ListRequest, extra *selection, all bool) (issueops.IssuePage, error) {
	sel, err := listSelection(req)
	if err != nil {
		return issueops.IssuePage{}, err
	}
	if extra != nil {
		sel = sel.merge(extra)
	}
	if !knownSort(req.SortBy) {
		return issueops.IssuePage{}, invalidf("sort %q is not a list sort", req.SortBy)
	}
	if req.Offset < 0 {
		return issueops.IssuePage{}, invalidf("offset %d is negative", req.Offset)
	}
	limit, err := effectiveLimit(req.Limit, defaultListLimit)
	if err != nil {
		return issueops.IssuePage{}, err
	}
	// The empty sort is not "whatever the server does": the list's own default is
	// priority ascending, then created newest first, and the server's is created.
	sortBy := req.SortBy
	if sortBy == "" {
		sortBy = "priority"
	}
	wireSort := wireListSort(sortBy)
	serverBrief := req.Brief && !sel.needsText
	q := listQuery(req, wireSort, serverBrief)

	needAll := all || limit == 0 || sel.local() || req.Reverse || req.MaxRows > 0 || wireSort == ""
	if !needAll {
		q.v.Set("limit", itoa(limit+req.Offset))
		page, err := r.s.getPage(ctx, "/issues", q.values())
		if err != nil {
			return issueops.IssuePage{}, err
		}
		items, _ := window(page.Items, req.Offset, limit)
		more := page.HasMore
		if req.Brief {
			briefProject(items)
		}
		return issueops.IssuePage{Items: items, HasMore: more}, nil
	}

	items, err := r.every(ctx, req, q, wireSort, serverBrief, sel.needsBlocked)
	if err != nil {
		return issueops.IssuePage{}, err
	}
	items = sel.filter(items)
	if wireSort == "" {
		sortRows(items, sortBy)
	}
	if req.Reverse {
		slices.Reverse(items)
	}
	if err := checkMaxRows(len(items), req.MaxRows, limit, req.Offset, req.MaxRowsSource); err != nil {
		return issueops.IssuePage{}, err
	}
	items, more := window(items, req.Offset, limit)
	if req.Brief {
		briefProject(items)
	}
	return issueops.IssuePage{Items: items, HasMore: more}, nil
}

// every reads all rows a request selects. Where the server has the bulk export
// it is read from there, a few hundred rows to a request with their relations; the
// rows come back in the order the wire list would have produced.
func (r readerRole) every(ctx context.Context, req issueops.ListRequest, q *query, wireSort string, serverBrief, needBlocked bool) ([]*backend.IssueWithCounts, error) {
	// The export's default is every status; a listing without a status or the
	// "all" flag hides closed rows, and brief rows omit their text, so those
	// stay on the list route.
	if !serverBrief && (req.Status != "" || req.AllFlag || req.PinnedFlag) && !r.s.noExport.Load() {
		items, err := r.s.exportEvery(ctx, exportListValues(q.v, needBlocked || !r.noBlocked))
		if err == nil {
			sortAsList(items, wireSort)
			return items, nil
		}
		if !exportUnsupported(err) {
			return nil, err
		}
		r.s.noExport.Store(true)
	}
	return r.s.listEvery(ctx, "/issues", q)
}

// listEvery reads every page of a cursor-paged listing.
func (s *Store) listEvery(ctx context.Context, path string, q *query) ([]*backend.IssueWithCounts, error) {
	var all []*backend.IssueWithCounts
	v := cloneValues(q.v)
	v.Set("limit", itoa(pageSize))
	v.Del("cursor")
	for {
		page, err := s.getPage(ctx, path, v)
		if err != nil {
			return nil, err
		}
		all = append(all, page.Items...)
		if !page.HasMore {
			return all, nil
		}
		if page.NextCursor == "" {
			return nil, fmt.Errorf("%s said more rows follow but gave no cursor to read them with: %w", path, backend.ErrValidation)
		}
		v.Set("cursor", page.NextCursor)
	}
}

// wireListSort maps a role sort onto the sorts the wire list publishes. Any
// other sort is applied here, after the read.
func wireListSort(sortBy string) string {
	switch sortBy {
	case "priority", "created":
		return sortBy
	}
	return ""
}

func anyLabel(i *backend.Issue, match func(string) bool) bool {
	for _, l := range i.Labels {
		if match(l) {
			return true
		}
	}
	return false
}

func globRegexp(glob string) *regexp.Regexp {
	var b strings.Builder
	b.WriteString("^")
	for _, r := range glob {
		switch r {
		case '*':
			b.WriteString(".*")
		case '?':
			b.WriteString(".")
		default:
			b.WriteString(regexp.QuoteMeta(string(r)))
		}
	}
	b.WriteString("$")
	return regexp.MustCompile(b.String())
}

// ------------------------------------------------------------------------- get

func (r readerRole) Get(ctx context.Context, req issueops.GetRequest) (*backend.IssueDetails, error) {
	q := newQuery().flag("include_comments", req.IncludeComments).flag("include_dependents", req.IncludeDependents).flag("brief_deps", req.BriefDeps)
	var out backend.IssueDetails
	if err := r.s.client.do(ctx, http.MethodGet, issuePath(req.ID), q.values(), nil, &out); err != nil {
		return nil, err
	}
	out.Issue.RowVersion = parseRevision(out.Revision)
	return &out, nil
}

// ----------------------------------------------------------------------- counts

type counterRole struct{ s *Store }

func countParams(req issueops.CountRequest) *query {
	return newQuery().
		str("status", req.Status).
		str("type", req.IssueType).
		str("assignee", req.Assignee).
		integer("priority", req.Priority).
		integer("priority_min", req.PriorityMin).
		integer("priority_max", req.PriorityMax).
		list("label", req.Labels).
		list("label_any", req.LabelsAny).
		str("title", req.TitleSearch).
		str("id", req.IDFilter).
		str("title_contains", req.TitleContains).
		str("desc_contains", req.DescContains).
		str("notes_contains", req.NotesContains).
		stamp("created_after", req.CreatedAfter).
		stamp("created_before", req.CreatedBefore).
		stamp("updated_after", req.UpdatedAfter).
		stamp("updated_before", req.UpdatedBefore).
		stamp("closed_after", req.ClosedAfter).
		stamp("closed_before", req.ClosedBefore).
		flag("empty_description", req.EmptyDesc).
		flag("no_assignee", req.NoAssignee).
		flag("no_labels", req.NoLabels).
		flag("include_infra", req.IncludeInfra)
}

type issueCount struct {
	Total  int64          `json:"total"`
	Groups map[string]int `json:"groups"`
}

func (r counterRole) Count(ctx context.Context, req issueops.CountRequest) (issueops.CountResult, error) {
	var out issueCount
	if err := r.s.client.do(ctx, http.MethodGet, "/issues:count", countParams(req).values(), nil, &out); err != nil {
		return issueops.CountResult{}, err
	}
	return issueops.CountResult{Total: out.Total}, nil
}

func (r counterRole) CountByGroup(ctx context.Context, req issueops.CountByGroupRequest) (issueops.CountByGroupResult, error) {
	q := countParams(req.Filter).str("group_by", string(req.GroupBy))
	var out issueCount
	if err := r.s.client.do(ctx, http.MethodGet, "/issues:count", q.values(), nil, &out); err != nil {
		return issueops.CountByGroupResult{}, err
	}
	return issueops.CountByGroupResult{Groups: out.Groups, Total: out.Total}, nil
}

type readyCounterRole struct{ s *Store }

func (r readyCounterRole) CountReady(ctx context.Context, req issueops.ReadyRequest) (issueops.ReadyCountResult, error) {
	// A count is of the whole ready set: the request's paging and order say
	// nothing about it.
	if sel := readySelection(req); sel.local() {
		// A filter the count route does not carry: count the rows it keeps.
		zero := 0
		page, err := r.s.readyRows(ctx, issueops.ReadyRequest{
			IssueType: req.IssueType, Assignee: req.Assignee, Unassigned: req.Unassigned, Labels: req.Labels,
			LabelsAny: req.LabelsAny, ExcludeLabels: req.ExcludeLabels, LabelPattern: req.LabelPattern,
			LabelRegex: req.LabelRegex, Priority: req.Priority, ParentID: req.ParentID, MolType: req.MolType,
			IncludeDeferred: req.IncludeDeferred, IncludeEphemeral: req.IncludeEphemeral, ExcludeTypes: req.ExcludeTypes,
			MetadataFields: req.MetadataFields, HasMetadataKey: req.HasMetadataKey, Limit: &zero, Brief: true,
		}, sel, nil, 0, "")
		return issueops.ReadyCountResult{Total: int64(len(page.Items))}, err
	}
	var out struct {
		Total int64 `json:"total"`
	}
	if err := r.s.client.do(ctx, http.MethodGet, "/ready:count", readyParams(req).values(), nil, &out); err != nil {
		return issueops.ReadyCountResult{}, err
	}
	return issueops.ReadyCountResult{Total: out.Total}, nil
}

// ----------------------------------------------------------------------- query

type querierRole struct{ s *Store }

func (r querierRole) Query(ctx context.Context, req issueops.QueryRequest) (issueops.IssuePage, error) {
	limit, err := effectiveLimit(req.Limit, defaultQueryLimit)
	if err != nil {
		return issueops.IssuePage{}, err
	}
	if req.Offset < 0 {
		return issueops.IssuePage{}, invalidf("offset %d is negative", req.Offset)
	}
	if req.Offset > 0 && req.SortBy != "" {
		// Upstream refuses the pair at every backend: the order is applied to the
		// rows the query bounded, so a walk by offset would neither visit every
		// row nor visit any row once.
		return issueops.IssuePage{}, invalidf("an offset with a sort is refused: each page would be sorted for itself")
	}
	// The query route has no cursor and no offset: the head of the matches is read
	// and the window cut here, and an unlimited query asks for a bound no result
	// set reaches.
	bound := unboundedLimit
	if limit > 0 {
		bound = limit + req.Offset
	}
	q := newQuery().str("q", req.Expression).flag("all", req.IncludeClosed).str("sort", req.SortBy).flag("reverse", req.Reverse).integer("limit", &bound)
	page, err := r.s.getPage(ctx, "/issues:query", q.values())
	if err != nil {
		return issueops.IssuePage{}, err
	}
	if limit == 0 && page.HasMore {
		return issueops.IssuePage{}, fmt.Errorf("the query matched more rows than one read returns although no bound was asked for: %w", backend.ErrValidation)
	}
	items, _ := window(page.Items, req.Offset, limit)
	return issueops.IssuePage{Items: items, HasMore: page.HasMore}, nil
}

// ----------------------------------------------------------------------- stats

type statsRole struct{ s *Store }

func (r statsRole) fetch(ctx context.Context, q *query) (issueops.StatsResult, error) {
	var out struct {
		Summary backend.Statistics `json:"summary"`
	}
	if err := r.s.client.do(ctx, http.MethodGet, "/stats", q.values(), nil, &out); err != nil {
		return issueops.StatsResult{}, err
	}
	return issueops.StatsResult{Summary: out.Summary}, nil
}

func (r statsRole) Stats(ctx context.Context, req issueops.StatsRequest) (issueops.StatsResult, error) {
	return r.fetch(ctx, newQuery().flag("skip_blocked", req.SkipBlocked))
}

func (r statsRole) AssigneeStats(ctx context.Context, req issueops.AssigneeStatsRequest) (issueops.StatsResult, error) {
	return r.fetch(ctx, newQuery().str("assignee", req.Assignee))
}

// ------------------------------------------------------------------ graph reads

type relationsRole struct{ s *Store }

func (r relationsRole) Related(ctx context.Context, req issueops.RelatedRequest) ([]*issueops.RelatedIssue, error) {
	q := newQuery().str("direction", string(req.Direction)).list("type", depTypes(req.Types))
	var out struct {
		Items []*issueops.RelatedIssue `json:"items"`
	}
	if err := r.s.client.do(ctx, http.MethodGet, issuePath(req.ID)+"/related", q.values(), nil, &out); err != nil {
		return nil, err
	}
	return out.Items, nil
}

func depTypes(types []issueops.DependencyType) []string {
	out := make([]string, 0, len(types))
	for _, t := range types {
		out = append(out, string(t))
	}
	return out
}

type edgeReaderRole struct{ s *Store }

func (r edgeReaderRole) ReadEdges(ctx context.Context, req issueops.EdgeReadRequest) (issueops.EdgeReadResult, error) {
	q := newQuery().list("issue_id", req.IDs).list("type", depTypes(req.Types))
	var out struct {
		Items   []*backend.Dependency `json:"items"`
		Missing []string              `json:"missing"`
	}
	if err := r.s.client.do(ctx, http.MethodGet, "/dependencies", q.values(), nil, &out); err != nil {
		return issueops.EdgeReadResult{}, err
	}
	missing := map[string]bool{}
	for _, id := range out.Missing {
		missing[id] = true
	}
	byAnchor := map[string][]*backend.Dependency{}
	for _, e := range out.Items {
		byAnchor[e.IssueID] = append(byAnchor[e.IssueID], e)
	}
	result := issueops.EdgeReadResult{}
	for _, id := range req.IDs {
		result.Anchors = append(result.Anchors, issueops.AnchorEdges{ID: id, Edges: byAnchor[id], Missing: missing[id]})
	}
	return result, nil
}

type blockingRole struct{ s *Store }

func (r blockingRole) AnnotateBlocking(ctx context.Context, req issueops.BlockingRequest) (issueops.BlockingResult, error) {
	if len(req.IDs) == 0 {
		return issueops.BlockingResult{}, nil
	}
	var out issueops.BlockingResult
	q := newQuery().list("issue_id", req.IDs)
	if err := r.s.client.do(ctx, http.MethodGet, "/dependencies/blocking", q.values(), nil, &out); err != nil {
		return issueops.BlockingResult{}, err
	}
	return out, nil
}

type treeRole struct{ s *Store }

func (r treeRole) WalkTree(ctx context.Context, req issueops.WalkTreeRequest) (issueops.TreeResult, error) {
	q := newQuery().str("root_id", req.RootID).str("direction", string(req.Direction)).str("status", string(req.Status))
	if req.MaxDepth > 0 {
		q.v.Set("max_depth", itoa(req.MaxDepth))
	}
	var out struct {
		Items []*backend.TreeNode `json:"items"`
	}
	if err := r.s.client.do(ctx, http.MethodGet, "/dependencies/tree", q.values(), nil, &out); err != nil {
		return issueops.TreeResult{}, err
	}
	if err := checkMaxRows(len(out.Items), req.MaxRows, 0, 0, req.MaxRowsSource); err != nil {
		return issueops.TreeResult{}, err
	}
	return issueops.TreeResult{Nodes: out.Items}, nil
}

type cycleRole struct{ s *Store }

func (r cycleRole) DetectCycles(ctx context.Context, _ issueops.DetectCyclesRequest) (issueops.CycleReport, error) {
	var out struct {
		Items []issueops.Cycle `json:"items"`
	}
	if err := r.s.client.do(ctx, http.MethodGet, "/dependencies/cycles", nil, nil, &out); err != nil {
		return issueops.CycleReport{}, err
	}
	return issueops.CycleReport{Cycles: out.Items}, nil
}

type graphCounterRole struct{ s *Store }

func (r graphCounterRole) CountEdges(ctx context.Context, req issueops.EdgeCountRequest) (issueops.EdgeCountResult, error) {
	q := newQuery().list("issue_id", req.IDs).str("direction", string(req.Direction)).list("type", depTypes(req.Types)).str("status", req.Status)
	var out struct {
		Anchors []issueops.AnchorEdgeCount `json:"anchors"`
	}
	if err := r.s.client.do(ctx, http.MethodGet, "/dependencies:count", q.values(), nil, &out); err != nil {
		return issueops.EdgeCountResult{}, err
	}
	return issueops.EdgeCountResult{Anchors: out.Anchors}, nil
}
