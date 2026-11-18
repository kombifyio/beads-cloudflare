package cloudflare

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/steveyegge/beads/backend"
	"github.com/steveyegge/beads/issueops"
)

// The raw Storage methods the CLI still calls directly. Every one of them is a
// thin projection onto a role: the server filters and pages, and this file only
// translates the filter vocabulary. A command on a large tracker costs a handful
// of requests, never a scan of every issue.

// ---------------------------------------------------------------- filter mapping

func statusCSV(f backend.IssueFilter) string {
	var out []string
	if f.Status != nil {
		out = append(out, string(*f.Status))
	}
	for _, s := range f.Statuses {
		out = append(out, string(s))
	}
	return strings.Join(out, ",")
}

// listRequestFor maps a raw IssueFilter onto the role's ListRequest. Members
// the server cannot evaluate travel in the request anyway: the reader applies
// them after the read. The members no ListRequest member carries are tested by
// rawSelection.
func listRequestFor(f backend.IssueFilter) issueops.ListRequest {
	req := issueops.ListRequest{
		Status:           statusCSV(f),
		Assignee:         derefString(f.Assignee),
		Labels:           f.Labels,
		LabelsAny:        f.LabelsAny,
		ExcludeLabels:    f.ExcludeLabels,
		LabelPattern:     f.LabelPattern,
		LabelRegex:       f.LabelRegex,
		TitleContains:    f.TitleContains,
		DescContains:     f.DescriptionContains,
		NotesContains:    f.NotesContains,
		ExternalContains: f.ExternalRefContains,
		ExternalRef:      derefString(f.ExternalRef),
		CreatedAfter:     f.CreatedAfter,
		CreatedBefore:    f.CreatedBefore,
		UpdatedAfter:     f.UpdatedAfter,
		UpdatedBefore:    f.UpdatedBefore,
		ClosedAfter:      f.ClosedAfter,
		ClosedBefore:     f.ClosedBefore,
		DeferAfter:       f.DeferAfter,
		DeferBefore:      f.DeferBefore,
		DueAfter:         f.DueAfter,
		DueBefore:        f.DueBefore,
		EmptyDesc:        f.EmptyDescription,
		NoAssignee:       f.NoAssignee,
		NoLabels:         f.NoLabels,
		Priority:         f.Priority,
		PriorityMin:      f.PriorityMin,
		PriorityMax:      f.PriorityMax,
		TitleSearch:      f.TitleSearch,
		SpecPrefix:       f.SpecIDPrefix,
		DeferredFlag:     f.Deferred,
		OverdueFlag:      f.Overdue,
		NoParent:         f.NoParent,
		MolType:          f.MolType,
		WispType:         f.WispType,
		MetadataFields:   f.MetadataFields,
		HasMetadataKey:   f.HasMetadataKey,
		AfterCreatedAt:   f.AfterCreatedAt,
		AfterID:          f.AfterID,
		AfterPriority:    f.AfterPriority,
		MaxRows:          f.MaxRows,
		MaxRowsSource:    f.MaxRowsSource,
		// A raw search hides nothing by type or tier: its exclusions are the
		// filter's own members. The ephemeral plane is read unless the caller
		// skips it, which is how upstream's merged search behaves.
		IncludeAllTypes:  true,
		IncludeTemplates: true,
		IncludeGates:     true,
		IncludeInfra:     true,
		IncludeEphemeral: !f.SkipWisps || f.Ephemeral != nil || f.EphemeralTier != nil,
		Offset:           f.Offset,
		SortBy:           f.SortBy,
		Reverse:          f.SortDesc,
		AllFlag:          statusCSV(f) == "",
		ParentID:         derefString(f.ParentID),
	}
	if f.IssueType != nil {
		req.IssueType = string(*f.IssueType)
	}
	if f.Pinned != nil {
		req.PinnedFlag = *f.Pinned
		req.NoPinnedFlag = !*f.Pinned
	}
	for _, t := range f.ExcludeTypes {
		req.ExcludeTypes = append(req.ExcludeTypes, string(t))
	}
	return req
}

// search answers a filter: by exact id when ids are named, by the server's list
// otherwise. limit follows the raw convention that zero means no limit, and every
// page is read for an unlimited one. The tests no wire member carries run before
// the limit is applied, so a limit never hides the match that lies behind rows the
// tests reject.
func (s *Store) search(ctx context.Context, query string, f backend.IssueFilter) ([]*backend.IssueWithCounts, error) {
	if err := s.checkOpen("SearchIssues"); err != nil {
		return nil, err
	}
	if f.Limit < 0 || f.Offset < 0 {
		return nil, invalidf("limit %d and offset %d must not be negative", f.Limit, f.Offset)
	}
	raw, err := rawSelection(f, query)
	if err != nil {
		return nil, err
	}
	req := listRequestFor(f)
	limit := f.Limit
	req.Limit = &limit

	var items []*backend.IssueWithCounts
	if len(f.IDs) > 0 {
		// An exact id is one read, not a scan: this is the call every id argument
		// of every command makes first.
		items, err = s.searchByIDs(ctx, f, req, raw)
	} else {
		var page issueops.IssuePage
		page, err = (readerRole{s: s, noBlocked: !raw.needsBlocked}).listSelected(ctx, req, raw, false)
		items = page.Items
	}
	if err != nil {
		return nil, err
	}
	if f.IncludeDependencies {
		if err := s.hydrateDependencies(ctx, items); err != nil {
			return nil, err
		}
	}
	return items, nil
}

// searchByIDs reads the named rows and applies every member of the filter to
// them: the wire members, the client-side tests, the order, the offset and the
// limit.
func (s *Store) searchByIDs(ctx context.Context, f backend.IssueFilter, req issueops.ListRequest, raw *selection) ([]*backend.IssueWithCounts, error) {
	var items []*backend.IssueWithCounts
	seen := map[string]bool{}
	for _, id := range f.IDs {
		if seen[id] {
			continue
		}
		seen[id] = true
		var details backend.IssueDetails
		err := s.client.do(ctx, "GET", issuePath(id), nil, nil, &details)
		if isNotFound(err) {
			continue
		}
		if err != nil {
			return nil, err
		}
		row := &backend.IssueWithCounts{Issue: &details.Issue, Parent: details.Parent}
		row.Issue.RowVersion = parseRevision(details.Revision)
		row.Issue.Labels = details.Labels
		if details.DependencyCount != nil {
			row.DependencyCount = int(*details.DependencyCount)
		}
		if details.CommentCount != nil {
			row.CommentCount = int(*details.CommentCount)
		}
		if details.DependentCount != nil {
			row.DependentCount = int(*details.DependentCount)
		}
		items = append(items, row)
	}
	if raw.needsBlocked {
		// A row read by id carries no is_blocked; the blocking annotation says it.
		for start := 0; start < len(items); start += 100 {
			end := min(start+100, len(items))
			ids := make([]string, 0, end-start)
			for _, item := range items[start:end] {
				ids = append(ids, item.ID)
			}
			res, err := (blockingRole{s}).AnnotateBlocking(ctx, issueops.BlockingRequest{IDs: ids})
			if err != nil {
				return nil, err
			}
			blocked := map[string]bool{}
			for _, entry := range res.Items {
				blocked[entry.ID] = len(entry.BlockedBy) > 0
			}
			for _, item := range items[start:end] {
				item.Issue.IsBlocked = blocked[item.ID]
			}
		}
	}
	local, err := listSelection(req)
	if err != nil {
		return nil, err
	}
	sel := wireSelection(req).merge(local).merge(raw)
	items = sel.filter(items)
	if !knownSort(req.SortBy) {
		return nil, invalidf("sort %q is not a list sort", req.SortBy)
	}
	orderRows(items, req.SortBy)
	if req.Reverse {
		slices.Reverse(items)
	}
	if err := checkMaxRows(len(items), req.MaxRows, f.Limit, req.Offset, req.MaxRowsSource); err != nil {
		return nil, err
	}
	items, _ = window(items, req.Offset, f.Limit)
	return items, nil
}

// hydrateDependencies fills Issue.Dependencies on rows the filter asked to carry
// them.
func (s *Store) hydrateDependencies(ctx context.Context, items []*backend.IssueWithCounts) error {
	ids := make([]string, 0, len(items))
	for _, item := range items {
		ids = append(ids, item.ID)
	}
	edges, err := s.GetDependencyRecordsForIssues(ctx, ids)
	if err != nil {
		return err
	}
	for _, item := range items {
		item.Issue.Dependencies = edges[item.ID]
	}
	return nil
}

func issuesOf(items []*backend.IssueWithCounts) []*backend.Issue {
	out := make([]*backend.Issue, 0, len(items))
	for _, item := range items {
		if item != nil && item.Issue != nil {
			out = append(out, item.Issue)
		}
	}
	return out
}

func (s *Store) SearchIssues(ctx context.Context, query string, filter backend.IssueFilter) ([]*backend.Issue, error) {
	items, err := s.search(ctx, query, filter)
	if err != nil {
		return nil, err
	}
	return issuesOf(items), nil
}

func (s *Store) SearchIssuesWithCounts(ctx context.Context, query string, filter backend.IssueFilter) ([]*backend.IssueWithCounts, error) {
	return s.search(ctx, query, filter)
}

func (s *Store) SearchIssueIDs(ctx context.Context, query string, filter backend.IssueFilter) ([]string, error) {
	items, err := s.search(ctx, query, filter)
	if err != nil {
		return nil, err
	}
	ids := make([]string, 0, len(items))
	for _, item := range items {
		ids = append(ids, item.ID)
	}
	return ids, nil
}

func (s *Store) IterIssues(ctx context.Context, query string, filter backend.IssueFilter) (backend.Iter[backend.Issue], error) {
	items, err := s.search(ctx, query, filter)
	if err != nil {
		return nil, err
	}
	return backend.NewSliceIter(issuesOf(items)), nil
}

func (s *Store) GetIssuesByLabel(ctx context.Context, label string) ([]*backend.Issue, error) {
	return s.SearchIssues(ctx, "", backend.IssueFilter{Labels: []string{label}})
}

// ------------------------------------------------------------------ ready work

// readySpec is a raw WorkFilter as the ready routes and this client's own tests
// carry it.
type readySpec struct {
	req      issueops.ReadyRequest
	sel      *selection
	statuses map[string]bool
	maxRows  int
	source   string
}

// local reports whether the ready routes alone cannot answer the filter.
func (r readySpec) local() bool { return r.sel.local() || len(r.statuses) > 0 }

// readySpecFor maps a WorkFilter, refusing before any read what has no meaning
// here.
func (s *Store) readySpecFor(ctx context.Context, f backend.WorkFilter) (readySpec, error) {
	if f.MoleculeID != "" {
		return readySpec{}, unsupportedField("GetReadyWork", "MoleculeID: no molecule membership is stored")
	}
	req := issueops.ReadyRequest{
		IssueType: f.Type, Assignee: derefString(f.Assignee), Unassigned: f.Unassigned,
		Labels: f.Labels, LabelsAny: f.LabelsAny, ExcludeLabels: f.ExcludeLabels,
		LabelPattern: f.LabelPattern, LabelRegex: f.LabelRegex, Priority: f.Priority,
		ParentID: derefString(f.ParentID), MolType: f.MolType, IncludeDeferred: f.IncludeDeferred,
		IncludeEphemeral: f.IncludeEphemeral, MetadataFields: f.MetadataFields, HasMetadataKey: f.HasMetadataKey,
		Sort: string(f.SortPolicy), Offset: f.Offset, Brief: f.Lite,
	}
	for _, t := range f.ExcludeTypes {
		req.ExcludeTypes = append(req.ExcludeTypes, string(t))
	}
	limit := max(f.Limit, 0)
	req.Limit = &limit
	spec := readySpec{req: req, sel: readySelection(req), statuses: map[string]bool{}, maxRows: f.MaxRows, source: f.MaxRowsSource}
	if f.WispType != nil {
		want := *f.WispType
		spec.sel.addIssue(func(i *backend.Issue) bool { return i.WispType == want })
	}
	// As upstream's ready filter reads them: a singular status wins over the list,
	// and a singular open means open plus the custom statuses of category active.
	switch {
	case f.Status != "":
		set, err := s.readyStatusSet(ctx, []string{string(f.Status)})
		if err != nil {
			return readySpec{}, err
		}
		spec.statuses = set
	case len(f.Statuses) > 0:
		for _, st := range f.Statuses {
			spec.statuses[string(st)] = true
		}
	}
	return spec, nil
}

func (s *Store) readyItems(ctx context.Context, f backend.WorkFilter) ([]*backend.IssueWithCounts, error) {
	if err := s.checkOpen("GetReadyWork"); err != nil {
		return nil, err
	}
	spec, err := s.readySpecFor(ctx, f)
	if err != nil {
		return nil, err
	}
	page, err := s.readyRows(ctx, spec.req, spec.sel, spec.statuses, spec.maxRows, spec.source)
	if err != nil {
		return nil, err
	}
	return page.Items, nil
}

func (s *Store) GetReadyWork(ctx context.Context, filter backend.WorkFilter) ([]*backend.Issue, error) {
	items, err := s.readyItems(ctx, filter)
	if err != nil {
		return nil, err
	}
	return issuesOf(items), nil
}

func (s *Store) GetReadyWorkWithCounts(ctx context.Context, filter backend.WorkFilter) ([]*backend.IssueWithCounts, error) {
	return s.readyItems(ctx, filter)
}

func (s *Store) IterReadyWork(ctx context.Context, filter backend.WorkFilter) (backend.Iter[backend.Issue], error) {
	items, err := s.readyItems(ctx, filter)
	if err != nil {
		return nil, err
	}
	return backend.NewSliceIter(issuesOf(items)), nil
}

func (s *Store) CountReadyWork(ctx context.Context, filter backend.WorkFilter) (int, error) {
	if err := s.checkOpen("CountReadyWork"); err != nil {
		return 0, err
	}
	spec, err := s.readySpecFor(ctx, filter)
	if err != nil {
		return 0, err
	}
	if spec.local() {
		zero := 0
		spec.req.Limit, spec.req.Offset, spec.req.Brief = &zero, 0, true
		page, err := s.readyRows(ctx, spec.req, spec.sel, spec.statuses, 0, "")
		return len(page.Items), err
	}
	out, err := (readyCounterRole{s}).CountReady(ctx, spec.req)
	return int(out.Total), err
}

func (s *Store) ClaimReadyIssue(ctx context.Context, filter backend.WorkFilter, actor string) (*backend.Issue, error) {
	if err := s.writeRefused("ClaimReadyIssue"); err != nil {
		return nil, err
	}
	spec, err := s.readySpecFor(ctx, filter)
	if err != nil {
		return nil, err
	}
	if spec.local() {
		// The claim is one atomic server operation over the ready set; a filter the
		// route does not carry cannot be honored inside it.
		return nil, unsupportedField("ClaimReadyIssue", "status, mol_type and wisp_type filters")
	}
	out, err := (readyClaimerRole{s}).ClaimNext(ctx, issueops.ClaimNextRequest{Actor: actor, Filter: spec.req})
	if err != nil || out.Claimed == nil {
		return nil, err
	}
	return out.Claimed.Issue, nil
}

// -------------------------------------------------------------------- counting

// CountIssues counts the rows a filter selects, exactly as SearchIssues selects
// them. The server's count route answers `bd count`'s question, which hides
// templates and gates and compares a status by equality; the raw count is the
// filter's own, so it is the length of the selection.
func (s *Store) CountIssues(ctx context.Context, query string, filter backend.IssueFilter) (int64, error) {
	if err := s.checkOpen("CountIssues"); err != nil {
		return 0, err
	}
	items, err := s.search(ctx, query, withoutLimit(filter))
	return int64(len(items)), err
}

func withoutLimit(f backend.IssueFilter) backend.IssueFilter {
	f.Limit, f.Offset = 0, 0
	return f
}

func (s *Store) CountIssuesByGroup(ctx context.Context, filter backend.IssueFilter, groupBy string) (map[string]int, error) {
	if err := s.checkOpen("CountIssuesByGroup"); err != nil {
		return nil, err
	}
	if groupBy == "issue_type" {
		groupBy = "type"
	}
	items, err := s.search(ctx, "", withoutLimit(filter))
	if err != nil {
		return nil, err
	}
	return groupRows(items, groupBy)
}

// groupRows tallies rows by one of the count groups, with the keys `bd count`
// displays: P<n> for a priority, (unassigned) and (no labels) for the empty ones.
func groupRows(items []*backend.IssueWithCounts, groupBy string) (map[string]int, error) {
	out := map[string]int{}
	for _, item := range items {
		i := item.Issue
		switch groupBy {
		case "status":
			out[string(i.Status)]++
		case "priority":
			out["P"+itoa(i.Priority)]++
		case "type":
			out[string(i.IssueType)]++
		case "assignee":
			key := i.Assignee
			if key == "" {
				key = "(unassigned)"
			}
			out[key]++
		case "label":
			if len(i.Labels) == 0 {
				out["(no labels)"]++
			}
			for _, l := range i.Labels {
				out[l]++
			}
		default:
			return nil, invalidf("cannot group by %q", groupBy)
		}
	}
	return out, nil
}

func (s *Store) GetStatistics(ctx context.Context) (*backend.Statistics, error) {
	if err := s.checkOpen("GetStatistics"); err != nil {
		return nil, err
	}
	out, err := (statsRole{s}).Stats(ctx, issueops.StatsRequest{})
	if err != nil {
		return nil, err
	}
	return &out.Summary, nil
}

// ---------------------------------------------------------------------- blocked

// GetBlockedIssues lists open issues the server marks blocked, with the open
// blockers the server's blocking annotation names for each.
func (s *Store) GetBlockedIssues(ctx context.Context, filter backend.WorkFilter) ([]*backend.BlockedIssue, error) {
	if err := s.checkOpen("GetBlockedIssues"); err != nil {
		return nil, err
	}
	blocked := true
	f := backend.IssueFilter{IsBlocked: &blocked, ExcludeStatus: []backend.Status{backend.StatusClosed, backend.StatusPinned}}
	if filter.Assignee != nil {
		f.Assignee = filter.Assignee
	}
	f.Labels, f.LabelsAny, f.ExcludeLabels = filter.Labels, filter.LabelsAny, filter.ExcludeLabels
	if filter.Type != "" {
		t := backend.IssueType(filter.Type)
		f.IssueType = &t
	}
	f.ParentID = filter.ParentID
	f.Priority, f.NoAssignee = filter.Priority, filter.Unassigned
	f.LabelPattern, f.LabelRegex = filter.LabelPattern, filter.LabelRegex
	f.ExcludeTypes, f.MolType, f.WispType = filter.ExcludeTypes, filter.MolType, filter.WispType
	f.MetadataFields, f.HasMetadataKey = filter.MetadataFields, filter.HasMetadataKey
	items, err := s.search(ctx, "", f)
	if err != nil {
		return nil, err
	}
	ids := make([]string, 0, len(items))
	for _, item := range items {
		ids = append(ids, item.ID)
	}
	by := map[string][]string{}
	for start := 0; start < len(ids); start += 100 {
		end := min(start+100, len(ids))
		res, err := (blockingRole{s}).AnnotateBlocking(ctx, issueops.BlockingRequest{IDs: ids[start:end]})
		if err != nil {
			return nil, err
		}
		for _, entry := range res.Items {
			by[entry.ID] = entry.BlockedBy
		}
	}
	out := make([]*backend.BlockedIssue, 0, len(items))
	for _, item := range items {
		out = append(out, &backend.BlockedIssue{Issue: *item.Issue, BlockedBy: by[item.ID], BlockedByCount: len(by[item.ID])})
	}
	if filter.Limit > 0 && len(out) > filter.Limit {
		out = out[:filter.Limit]
	}
	return out, nil
}

func (s *Store) IterBlockedIssues(ctx context.Context, filter backend.WorkFilter) (backend.Iter[backend.BlockedIssue], error) {
	items, err := s.GetBlockedIssues(ctx, filter)
	if err != nil {
		return nil, err
	}
	return backend.NewSliceIter(items), nil
}

func (s *Store) IsBlockedBatch(ctx context.Context, ids []string) (map[string]bool, error) {
	out := map[string]bool{}
	for start := 0; start < len(ids); start += 100 {
		end := min(start+100, len(ids))
		res, err := (blockingRole{s}).AnnotateBlocking(ctx, issueops.BlockingRequest{IDs: ids[start:end]})
		if err != nil {
			return nil, err
		}
		for _, entry := range res.Items {
			out[entry.ID] = len(entry.BlockedBy) > 0
		}
	}
	return out, nil
}

func (s *Store) IsBlocked(ctx context.Context, id string) (bool, []string, error) {
	res, err := (blockingRole{s}).AnnotateBlocking(ctx, issueops.BlockingRequest{IDs: []string{id}})
	if err != nil {
		return false, nil, err
	}
	for _, entry := range res.Items {
		if entry.ID == id {
			return len(entry.BlockedBy) > 0, entry.BlockedBy, nil
		}
	}
	return false, nil, nil
}

// GetBlockingInfoForIssues returns, per issue, the open blockers, the issues it
// blocks and its parent: the same three maps the blocking annotation carries.
func (s *Store) GetBlockingInfoForIssues(ctx context.Context, ids []string) (map[string][]string, map[string][]string, map[string]string, error) {
	blockedBy, blocks, parent := map[string][]string{}, map[string][]string{}, map[string]string{}
	for start := 0; start < len(ids); start += 100 {
		end := min(start+100, len(ids))
		res, err := (blockingRole{s}).AnnotateBlocking(ctx, issueops.BlockingRequest{IDs: ids[start:end]})
		if err != nil {
			return nil, nil, nil, err
		}
		for _, entry := range res.Items {
			if len(entry.BlockedBy) > 0 {
				blockedBy[entry.ID] = entry.BlockedBy
			}
			if len(entry.Blocks) > 0 {
				blocks[entry.ID] = entry.Blocks
			}
			if entry.Parent != "" {
				parent[entry.ID] = entry.Parent
			}
		}
	}
	return blockedBy, blocks, parent, nil
}

// GetNewlyUnblockedByClose reports the issues the closed issue was the last
// open blocker of: its dependents that are open and now have no open blocker.
func (s *Store) GetNewlyUnblockedByClose(ctx context.Context, closedID string) ([]*backend.Issue, error) {
	related, err := (relationsRole{s}).Related(ctx, issueops.RelatedRequest{ID: closedID, Direction: issueops.RelationIn, Types: []issueops.DependencyType{"blocks"}})
	if err != nil {
		return nil, err
	}
	var ids []string
	for _, r := range related {
		if r.Status != backend.StatusClosed && r.Status != backend.StatusPinned {
			ids = append(ids, r.ID)
		}
	}
	state, err := s.IsBlockedBatch(ctx, ids)
	if err != nil {
		return nil, err
	}
	var out []*backend.Issue
	for _, r := range related {
		if blocked, known := state[r.ID]; known && !blocked && r.Status != backend.StatusClosed && r.Status != backend.StatusPinned {
			issue := r.Issue
			out = append(out, &issue)
		}
	}
	return out, nil
}

// -------------------------------------------------------------------- graph reads

func (s *Store) relatedWithMetadata(ctx context.Context, id string, dir issueops.RelationDirection) ([]*backend.IssueWithDependencyMetadata, error) {
	if err := s.checkOpen("Related"); err != nil {
		return nil, err
	}
	return (relationsRole{s}).Related(ctx, issueops.RelatedRequest{ID: id, Direction: dir})
}

func (s *Store) GetDependenciesWithMetadata(ctx context.Context, id string) ([]*backend.IssueWithDependencyMetadata, error) {
	return s.relatedWithMetadata(ctx, id, issueops.RelationOut)
}

func (s *Store) GetDependentsWithMetadata(ctx context.Context, id string) ([]*backend.IssueWithDependencyMetadata, error) {
	return s.relatedWithMetadata(ctx, id, issueops.RelationIn)
}

func (s *Store) IterDependenciesWithMetadata(ctx context.Context, id string) (backend.Iter[backend.IssueWithDependencyMetadata], error) {
	items, err := s.GetDependenciesWithMetadata(ctx, id)
	if err != nil {
		return nil, err
	}
	return backend.NewSliceIter(items), nil
}

func (s *Store) IterDependentsWithMetadata(ctx context.Context, id string) (backend.Iter[backend.IssueWithDependencyMetadata], error) {
	items, err := s.GetDependentsWithMetadata(ctx, id)
	if err != nil {
		return nil, err
	}
	return backend.NewSliceIter(items), nil
}

func (s *Store) GetDependencies(ctx context.Context, id string) ([]*backend.Issue, error) {
	rows, err := s.GetDependenciesWithMetadata(ctx, id)
	if err != nil {
		return nil, err
	}
	return relatedIssues(rows), nil
}

func (s *Store) GetDependents(ctx context.Context, id string) ([]*backend.Issue, error) {
	rows, err := s.GetDependentsWithMetadata(ctx, id)
	if err != nil {
		return nil, err
	}
	return relatedIssues(rows), nil
}

func relatedIssues(rows []*backend.IssueWithDependencyMetadata) []*backend.Issue {
	out := make([]*backend.Issue, 0, len(rows))
	for _, r := range rows {
		issue := r.Issue
		out = append(out, &issue)
	}
	return out
}

func (s *Store) GetDependencyTree(ctx context.Context, id string, maxDepth int, showAllPaths, reverse bool) ([]*backend.TreeNode, error) {
	if showAllPaths {
		return nil, unsupportedField("GetDependencyTree", "showAllPaths")
	}
	dir := issueops.TreeDown
	if reverse {
		dir = issueops.TreeUp
	}
	if maxDepth <= 0 {
		maxDepth = 50
	}
	out, err := (treeRole{s}).WalkTree(ctx, issueops.WalkTreeRequest{RootID: id, Direction: dir, MaxDepth: maxDepth})
	return out.Nodes, err
}

// DetectCycles reports each cycle as the issues on it.
func (s *Store) DetectCycles(ctx context.Context) ([][]*backend.Issue, error) {
	report, err := (cycleRole{s}).DetectCycles(ctx, issueops.DetectCyclesRequest{})
	if err != nil {
		return nil, err
	}
	out := make([][]*backend.Issue, 0, len(report.Cycles))
	for _, cycle := range report.Cycles {
		row := make([]*backend.Issue, 0, len(cycle.Members))
		for _, m := range cycle.Members {
			if m.Issue != nil {
				row = append(row, m.Issue)
			} else {
				row = append(row, &backend.Issue{ID: m.ID})
			}
		}
		out = append(out, row)
	}
	return out, nil
}

func (s *Store) GetEpicsEligibleForClosure(ctx context.Context) ([]*backend.EpicStatus, error) {
	epic := backend.TypeEpic
	items, err := s.search(ctx, "", backend.IssueFilter{IssueType: &epic, ExcludeStatus: []backend.Status{backend.StatusClosed}})
	if err != nil {
		return nil, err
	}
	var out []*backend.EpicStatus
	for _, item := range items {
		children, err := s.search(ctx, "", backend.IssueFilter{ParentID: &item.Issue.ID})
		if err != nil {
			return nil, err
		}
		if len(children) == 0 {
			// Upstream lists only the epics that have children.
			continue
		}
		closed := 0
		for _, c := range children {
			if c.Status == backend.StatusClosed {
				closed++
			}
		}
		status := &backend.EpicStatus{Epic: item.Issue, TotalChildren: len(children), ClosedChildren: closed,
			EligibleForClose: len(children) > 0 && closed == len(children)}
		out = append(out, status)
	}
	return out, nil
}

// GetNextChildID names the next child of a parent: the parent id, a dot and one
// more than the highest numeric child suffix in use.
func (s *Store) GetNextChildID(ctx context.Context, parentID string) (string, error) {
	children, err := s.search(ctx, "", backend.IssueFilter{ParentID: &parentID})
	if err != nil {
		return "", err
	}
	highest := 0
	for _, c := range children {
		suffix := strings.TrimPrefix(c.ID, parentID+".")
		if suffix == c.ID {
			continue
		}
		if n, err := strconv.Atoi(strings.SplitN(suffix, ".", 2)[0]); err == nil && n > highest {
			highest = n
		}
	}
	return fmt.Sprintf("%s.%d", parentID, highest+1), nil
}

// GetStaleIssues lists open and in-progress issues untouched for the filter's days,
// oldest first, as upstream does: the filter's own status narrows it to that one
// status, an issue whose lease heartbeat is newer than the cutoff is not stale, and
// the limit applies after the order, so it keeps the most neglected.
func (s *Store) GetStaleIssues(ctx context.Context, f backend.StaleFilter) ([]*backend.Issue, error) {
	if f.Limit < 0 {
		return nil, invalidf("limit %d is negative", f.Limit)
	}
	cutoff := time.Now().UTC().AddDate(0, 0, -f.Days)
	filter := backend.IssueFilter{UpdatedBefore: &cutoff, Labels: f.Labels, LabelsAny: f.LabelsAny, ExcludeLabels: f.ExcludeLabels}
	if f.Status != "" {
		st := backend.Status(f.Status)
		filter.Status = &st
	} else {
		filter.Statuses = []backend.Status{backend.StatusOpen, backend.StatusInProgress}
	}
	notEphemeral := false
	filter.Ephemeral = &notEphemeral
	items, err := s.search(ctx, "", filter)
	if err != nil {
		return nil, err
	}
	out := make([]*backend.Issue, 0, len(items))
	for _, item := range items {
		if h := item.HeartbeatAt; h != nil && !h.Before(cutoff) {
			continue
		}
		out = append(out, item.Issue)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].UpdatedAt.Before(out[j].UpdatedAt) })
	if f.Limit > 0 && len(out) > f.Limit {
		out = out[:f.Limit]
	}
	return out, nil
}

// -------------------------------------------------------------------- comments

func (s *Store) GetIssueCommentsPage(ctx context.Context, issueID string, after backend.CommentPageCursor, limit int) ([]*backend.Comment, error) {
	all, err := s.GetIssueComments(ctx, issueID)
	if err != nil {
		return nil, err
	}
	if limit <= 0 {
		limit = 100
	}
	var out []*backend.Comment
	for _, c := range all {
		if !after.CreatedAt.IsZero() {
			if c.CreatedAt.Before(after.CreatedAt) || (c.CreatedAt.Equal(after.CreatedAt) && c.ID <= after.ID) {
				continue
			}
		}
		out = append(out, c)
		if len(out) >= limit {
			break
		}
	}
	return out, nil
}

func (s *Store) IterIssueComments(ctx context.Context, issueID string) (backend.Iter[backend.Comment], error) {
	all, err := s.GetIssueComments(ctx, issueID)
	if err != nil {
		return nil, err
	}
	return backend.NewSliceIter(all), nil
}

func (s *Store) IterEvents(ctx context.Context, issueID string, limit int) (backend.Iter[backend.Event], error) {
	events, err := s.GetEvents(ctx, issueID, limit)
	if err != nil {
		return nil, err
	}
	return backend.NewSliceIter(events), nil
}

func (s *Store) IterAllEventsSince(ctx context.Context, since time.Time) (backend.Iter[backend.Event], error) {
	events, err := s.GetAllEventsSince(ctx, since)
	if err != nil {
		return nil, err
	}
	return backend.NewSliceIter(events), nil
}

// ------------------------------------------------------------ guarded writes

func (s *Store) UpdateIssue(ctx context.Context, id string, updates map[string]interface{}, actor string) error {
	return s.UpdateIssueChecked(ctx, id, updates, actor, backend.UpdateIssueOptions{})
}

func (s *Store) UpdateIssueChecked(ctx context.Context, id string, updates map[string]interface{}, actor string, options backend.UpdateIssueOptions) error {
	patch, force, err := issuePatchFromMap(updates)
	if err != nil {
		return err
	}
	_, err = (lifecycleRole{s}).Update(ctx, issueops.UpdateRequest{
		Actor: actor, IssueID: id, Patch: patch, ForceClosePolicy: force, ExpectedVersion: options.ExpectedVersion,
		ExpectedAssignee: options.ExpectedAssignee, ExpectedStatus: expectedStatus(options.ExpectedStatus),
	})
	return err
}

// DeleteIssue erases one issue. The raw method has no cascade or guard, so the
// request forces past the dependents check the way the in-tree store does.
func (s *Store) DeleteIssue(ctx context.Context, id string) error {
	_, err := (deleterRole{s}).Delete(ctx, issueops.DeleteRequest{IDs: []string{id}, Force: true})
	return err
}

// GetDependentRecords lists the edges that point at a target, read from the
// server's neighbor query.
func (s *Store) GetDependentRecords(ctx context.Context, targetID, depType string, limit int, afterID string) ([]*backend.Dependency, error) {
	if afterID != "" {
		// Upstream pages by the dependency row id, which the profile never emits.
		return nil, unsupportedField("GetDependentRecords", "afterID")
	}
	rows, err := s.relatedWithMetadata(ctx, targetID, issueops.RelationIn)
	if err != nil {
		return nil, err
	}
	var out []*backend.Dependency
	for _, r := range rows {
		if depType != "" && string(r.DependencyType) != depType {
			continue
		}
		if afterID != "" && r.ID <= afterID {
			continue
		}
		out = append(out, &backend.Dependency{IssueID: r.ID, DependsOnID: targetID, Type: r.DependencyType})
		if limit > 0 && len(out) >= limit {
			break
		}
	}
	return out, nil
}

func (s *Store) GetDependentRecordsForIssues(ctx context.Context, ids []string) (map[string][]*backend.Dependency, error) {
	out := map[string][]*backend.Dependency{}
	for _, id := range ids {
		records, err := s.GetDependentRecords(ctx, id, "", 0, "")
		if err != nil {
			if isNotFound(err) {
				continue
			}
			return nil, err
		}
		if len(records) > 0 {
			out[id] = records
		}
	}
	return out, nil
}

// ------------------------------------------------------- batched per-id reads

// manyIDs is where reading ids one by one stops paying: past it, one paged pass
// over the tracker is cheaper than a request per id.
const manyIDs = 25

// rowsByID returns the issue rows for ids: from the rows the command already read
// in bulk, else from the export route a hundred ids to a request. A server without
// the export reads a few ids directly and answers a long list by one listing of the
// whole tracker.
func (s *Store) rowsByID(ctx context.Context, ids []string) (map[string]*backend.IssueWithCounts, error) {
	out := make(map[string]*backend.IssueWithCounts, len(ids))
	if len(ids) == 0 {
		return out, nil
	}
	if rows, _, ok, err := s.rowsWithRelations(ctx, ids); err != nil {
		return nil, err
	} else if ok {
		return rows, nil
	}
	filter := backend.IssueFilter{}
	if len(ids) <= manyIDs {
		filter.IDs = ids
	}
	items, err := s.search(ctx, "", filter)
	if err != nil {
		return nil, err
	}
	want := make(map[string]bool, len(ids))
	for _, id := range ids {
		want[id] = true
	}
	for _, item := range items {
		if want[item.ID] {
			out[item.ID] = item
		}
	}
	return out, nil
}

func (s *Store) GetDependencyCounts(ctx context.Context, ids []string) (map[string]*backend.DependencyCounts, error) {
	rows, err := s.rowsByID(ctx, ids)
	if err != nil {
		return nil, err
	}
	out := make(map[string]*backend.DependencyCounts, len(rows))
	for id, row := range rows {
		out[id] = &backend.DependencyCounts{DependencyCount: row.DependencyCount, DependentCount: row.DependentCount}
	}
	return out, nil
}

func (s *Store) CountDependencies(ctx context.Context, id string) (int64, error) {
	counts, err := s.GetDependencyCounts(ctx, []string{id})
	if c, ok := counts[id]; ok {
		return int64(c.DependencyCount), err
	}
	return 0, err
}

func (s *Store) CountDependents(ctx context.Context, id string) (int64, error) {
	counts, err := s.GetDependencyCounts(ctx, []string{id})
	if c, ok := counts[id]; ok {
		return int64(c.DependentCount), err
	}
	return 0, err
}

func (s *Store) GetCommentCounts(ctx context.Context, ids []string) (map[string]int, error) {
	rows, err := s.rowsByID(ctx, ids)
	if err != nil {
		return nil, err
	}
	out := make(map[string]int, len(rows))
	for id, row := range rows {
		out[id] = row.CommentCount
	}
	return out, nil
}

func (s *Store) CountIssueComments(ctx context.Context, id string) (int64, error) {
	counts, err := s.GetCommentCounts(ctx, []string{id})
	return int64(counts[id]), err
}

func (s *Store) GetLabelsForIssues(ctx context.Context, ids []string) (map[string][]string, error) {
	rows, err := s.rowsByID(ctx, ids)
	if err != nil {
		return nil, err
	}
	out := make(map[string][]string, len(rows))
	for id, row := range rows {
		out[id] = row.Labels
	}
	return out, nil
}

// GetCommentsForIssues reads the threads of many issues with the export route, a
// hundred issues to a request (none for issues a bulk read already returned). A
// server without it is read one issue at a time.
func (s *Store) GetCommentsForIssues(ctx context.Context, ids []string) (map[string][]*backend.Comment, error) {
	if _, comments, ok, err := s.rowsWithRelations(ctx, ids); err != nil {
		return nil, err
	} else if ok {
		return comments, nil
	}
	out := map[string][]*backend.Comment{}
	for _, id := range ids {
		comments, err := s.GetIssueComments(ctx, id)
		if err != nil {
			if isNotFound(err) {
				continue
			}
			return nil, err
		}
		if len(comments) > 0 {
			out[id] = comments
		}
	}
	return out, nil
}

// GetDependencyRecordsForIssues reads the stored edges of many issues, a hundred
// anchors to a request.
func (s *Store) GetDependencyRecordsForIssues(ctx context.Context, ids []string) (map[string][]*backend.Dependency, error) {
	out := map[string][]*backend.Dependency{}
	// Rows a bulk read already returned carry their edges.
	if rows, _, missing := s.cache.lookup(s.client.writes.Load(), ids); len(missing) == 0 {
		for id, row := range rows {
			if len(row.Dependencies) > 0 {
				out[id] = row.Dependencies
			}
		}
		return out, nil
	}
	for start := 0; start < len(ids); start += 100 {
		end := min(start+100, len(ids))
		res, err := (edgeReaderRole{s}).ReadEdges(ctx, issueops.EdgeReadRequest{IDs: ids[start:end]})
		if err != nil {
			return nil, err
		}
		for _, anchor := range res.Anchors {
			if len(anchor.Edges) > 0 {
				out[anchor.ID] = anchor.Edges
			}
		}
	}
	return out, nil
}

func (s *Store) GetDependencyRecords(ctx context.Context, id string) ([]*backend.Dependency, error) {
	res, err := (edgeReaderRole{s}).ReadEdges(ctx, issueops.EdgeReadRequest{IDs: []string{id}})
	if err != nil {
		return nil, err
	}
	for _, anchor := range res.Anchors {
		if anchor.Missing {
			return nil, fmt.Errorf("issue %s: %w", id, backend.ErrNotFound)
		}
		return anchor.Edges, nil
	}
	return nil, nil
}

// GetAllDependencyRecords reads every stored edge: the edge export, a few
// thousand edges to a request. A server without it needs one paged pass for the
// ids, then the edge read in blocks of a hundred anchors.
func (s *Store) GetAllDependencyRecords(ctx context.Context) (map[string][]*backend.Dependency, error) {
	if err := s.checkOpen("GetAllDependencyRecords"); err != nil {
		return nil, err
	}
	if edges, ok, err := s.allEdges(ctx); err != nil {
		return nil, err
	} else if ok {
		return edges, nil
	}
	items, err := s.search(ctx, "", backend.IssueFilter{})
	if err != nil {
		return nil, err
	}
	ids := make([]string, 0, len(items))
	for _, item := range items {
		ids = append(ids, item.ID)
	}
	return s.GetDependencyRecordsForIssues(ctx, ids)
}

// ----------------------------------------------------------------- dependencies

func (s *Store) AddDependency(ctx context.Context, dep *backend.Dependency, actor string) error {
	if dep.ThreadID != "" {
		return unsupportedField("AddDependency", "thread_id")
	}
	if dep.Metadata != "" {
		// The edge route has no member for edge metadata (a waits-for gate lives
		// there); a one-item plan does, and applies it as the same single write.
		if err := s.writeRefused("AddDependency"); err != nil {
			return err
		}
		item := map[string]any{"kind": "dep_add", "dep_add": map[string]any{
			"source": wireRef{ID: dep.IssueID}, "target": wireRef{ID: dep.DependsOnID},
			"type": string(dep.Type), "metadata": json.RawMessage(dep.Metadata),
		}}
		_, err := s.postBatch(WithActor(ctx, actor), issueops.ApplyBatchRequest{Actor: actor}, []map[string]any{item})
		return err
	}
	_, err := (dependencyEditorRole{s}).AddDependencies(ctx, issueops.AddDependenciesRequest{
		Actor: actor, Edges: []issueops.DependencyEdge{{IssueID: dep.IssueID, DependsOnID: dep.DependsOnID, Type: dep.Type}},
	})
	return err
}

// AddDependencyWithOptions refuses what the server cannot honor: its cycle check
// always runs, so a request to skip it is declined rather than ignored.
func (s *Store) AddDependencyWithOptions(ctx context.Context, dep *backend.Dependency, actor string, options backend.DependencyAddOptions) error {
	if options.SkipCycleCheck {
		return unsupportedField("AddDependencyWithOptions", "SkipCycleCheck")
	}
	return s.AddDependency(ctx, dep, actor)
}

func (s *Store) RemoveDependency(ctx context.Context, issueID, dependsOnID, actor string) error {
	_, err := (dependencyEditorRole{s}).RemoveDependency(ctx, issueops.RemoveDependencyRequest{Actor: actor, IssueID: issueID, DependsOnID: dependsOnID})
	return err
}

func (s *Store) RemoveDependencyWithOptions(ctx context.Context, issueID, dependsOnID, actor string, _ backend.DependencyRemoveOptions) error {
	return s.RemoveDependency(ctx, issueID, dependsOnID, actor)
}

func expectedStatus(s *string) *issueops.Status {
	if s == nil {
		return nil
	}
	st := issueops.Status(*s)
	return &st
}

// readyStatusSet turns a status selector into the statuses a ready read keeps.
// Upstream gives a singular open the meaning of the ready-eligible set: open plus
// every custom status of category active (`status.custom=triaged:active`); any
// other selector is exact, a list stays exact, and "all" or nothing keeps what the
// ready routes return.
func (s *Store) readyStatusSet(ctx context.Context, parts []string) (map[string]bool, error) {
	set := map[string]bool{}
	for _, p := range parts {
		if p == "all" {
			return map[string]bool{}, nil
		}
		set[p] = true
	}
	if len(parts) == 1 && parts[0] == string(backend.StatusOpen) {
		custom, err := s.GetCustomStatusesDetailed(ctx)
		if err != nil {
			return nil, err
		}
		for _, c := range custom {
			if string(c.Category) == "active" {
				set[c.Name] = true
			}
		}
	}
	return set, nil
}
