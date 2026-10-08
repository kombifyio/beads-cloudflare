package cloudflare

import (
	"cmp"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/steveyegge/beads/backend"
	"github.com/steveyegge/beads/issueops"
)

// This file is the client-side half of every read: the predicates, orders and
// guards that the wire list does not carry. The rule it enforces is that a filter
// field is either sent to the server, evaluated here on the rows read, or refused
// with a typed error before anything is read. A field is never accepted and
// dropped: that answers a narrower question than the one asked with no signal.

// rowTest is one client-side predicate over a row.
type rowTest func(*backend.IssueWithCounts) bool

// selection is the client-side part of one request.
type selection struct {
	tests []rowTest
	// needsText says a test reads the free-form text columns, so a brief read
	// cannot be asked of the server: the text has to be fetched, tested, and only
	// then projected away.
	needsText bool
	// needsBlocked says a test reads is_blocked.
	needsBlocked bool
}

func (s *selection) add(t rowTest) { s.tests = append(s.tests, t) }

func (s *selection) addIssue(t func(*backend.Issue) bool) {
	s.tests = append(s.tests, func(item *backend.IssueWithCounts) bool { return t(item.Issue) })
}

// local reports whether any row has to be examined here.
func (s *selection) local() bool { return s != nil && len(s.tests) > 0 }

// keep reports whether a row passes every test.
func (s *selection) keep(item *backend.IssueWithCounts) bool {
	if item == nil || item.Issue == nil {
		return false
	}
	if s == nil {
		return true
	}
	for _, t := range s.tests {
		if !t(item) {
			return false
		}
	}
	return true
}

// filter returns the rows that pass.
func (s *selection) filter(items []*backend.IssueWithCounts) []*backend.IssueWithCounts {
	if s == nil || len(s.tests) == 0 {
		return items
	}
	kept := make([]*backend.IssueWithCounts, 0, len(items))
	for _, item := range items {
		if s.keep(item) {
			kept = append(kept, item)
		}
	}
	return kept
}

func invalidf(format string, args ...any) error {
	return fmt.Errorf("%s: %w", fmt.Sprintf(format, args...), backend.ErrValidation)
}

func splitList(entries []string) []string {
	var out []string
	for _, entry := range entries {
		for _, part := range strings.Split(entry, ",") {
			if part = strings.TrimSpace(part); part != "" {
				out = append(out, part)
			}
		}
	}
	return out
}

// normalizeTypes expands the aliases upstream folds before it excludes a type.
func normalizeTypes(entries []string) []string {
	parts := splitList(entries)
	for i, p := range parts {
		parts[i] = string(issueops.IssueType(p).Normalize())
	}
	return parts
}

// listSelection builds the client-side predicates of a list request: everything
// the wire list does not carry. Wire members (status, type, assignee, the three
// label sets, parent, metadata, the created bounds, the tier switches) are not
// repeated here, and a row read by id is checked against them by
// matchesServerFilters.
func listSelection(req issueops.ListRequest) (*selection, error) {
	sel := &selection{}
	lower := strings.ToLower
	contains := func(field func(*backend.Issue) string, needle string) func(*backend.Issue) bool {
		n := lower(needle)
		return func(i *backend.Issue) bool { return strings.Contains(lower(field(i)), n) }
	}

	if req.Priority != nil {
		p := *req.Priority
		sel.addIssue(func(i *backend.Issue) bool { return i.Priority == p })
	}
	if req.PriorityMin != nil {
		p := *req.PriorityMin
		sel.addIssue(func(i *backend.Issue) bool { return i.Priority >= p })
	}
	if req.PriorityMax != nil {
		p := *req.PriorityMax
		sel.addIssue(func(i *backend.Issue) bool { return i.Priority <= p })
	}
	if req.NoAssignee {
		sel.addIssue(func(i *backend.Issue) bool { return i.Assignee == "" })
	}
	if req.EmptyDesc {
		sel.needsText = true
		sel.addIssue(func(i *backend.Issue) bool { return strings.TrimSpace(i.Description) == "" })
	}
	if req.NoLabels {
		sel.addIssue(func(i *backend.Issue) bool { return len(i.Labels) == 0 })
	}
	if req.TitleContains != "" {
		sel.addIssue(contains(func(i *backend.Issue) string { return i.Title }, req.TitleContains))
	}
	if req.DescContains != "" {
		sel.needsText = true
		sel.addIssue(contains(func(i *backend.Issue) string { return i.Description }, req.DescContains))
	}
	if req.NotesContains != "" {
		sel.needsText = true
		sel.addIssue(contains(func(i *backend.Issue) string { return i.Notes }, req.NotesContains))
	}
	if req.ExternalContains != "" {
		sel.addIssue(contains(func(i *backend.Issue) string { return derefString(i.ExternalRef) }, req.ExternalContains))
	}
	if req.ExternalRef != "" {
		want := req.ExternalRef
		sel.addIssue(func(i *backend.Issue) bool { return derefString(i.ExternalRef) == want })
	}
	if req.TitleSearch != "" {
		needle := lower(req.TitleSearch)
		id := req.TitleSearch
		sel.addIssue(func(i *backend.Issue) bool { return strings.Contains(lower(i.Title), needle) || i.ID == id })
	}
	if req.SpecPrefix != "" {
		prefix := req.SpecPrefix
		sel.addIssue(func(i *backend.Issue) bool { return strings.HasPrefix(i.SpecID, prefix) })
	}
	if req.IDFilter != "" {
		ids := map[string]bool{}
		for _, id := range splitList([]string{req.IDFilter}) {
			ids[id] = true
		}
		if len(ids) > 0 {
			sel.addIssue(func(i *backend.Issue) bool { return ids[i.ID] })
		}
	}
	timeBound := func(bound *time.Time, field func(*backend.Issue) *time.Time, after bool) {
		if bound == nil {
			return
		}
		b := *bound
		sel.addIssue(func(i *backend.Issue) bool {
			v := field(i)
			if v == nil || v.IsZero() {
				return false
			}
			if after {
				return v.After(b)
			}
			return v.Before(b)
		})
	}
	updated := func(i *backend.Issue) *time.Time { return &i.UpdatedAt }
	timeBound(req.UpdatedAfter, updated, true)
	timeBound(req.UpdatedBefore, updated, false)
	timeBound(req.ClosedAfter, func(i *backend.Issue) *time.Time { return i.ClosedAt }, true)
	timeBound(req.ClosedBefore, func(i *backend.Issue) *time.Time { return i.ClosedAt }, false)
	timeBound(req.DeferAfter, func(i *backend.Issue) *time.Time { return i.DeferUntil }, true)
	timeBound(req.DeferBefore, func(i *backend.Issue) *time.Time { return i.DeferUntil }, false)
	timeBound(req.DueAfter, func(i *backend.Issue) *time.Time { return i.DueAt }, true)
	timeBound(req.DueBefore, func(i *backend.Issue) *time.Time { return i.DueAt }, false)

	// Pinned: the flag is its own predicate, separate from the pinned status.
	if req.PinnedFlag {
		sel.addIssue(func(i *backend.Issue) bool { return i.Pinned })
	}
	if req.NoPinnedFlag {
		sel.addIssue(func(i *backend.Issue) bool { return !i.Pinned })
	}
	// Upstream: defer_until set OR status deferred.
	if req.DeferredFlag {
		sel.addIssue(func(i *backend.Issue) bool { return i.DeferUntil != nil || i.Status == backend.StatusDeferred })
	}
	if req.OverdueFlag {
		now := time.Now()
		sel.addIssue(func(i *backend.Issue) bool {
			return i.DueAt != nil && i.DueAt.Before(now) && i.Status != backend.StatusClosed
		})
	}

	if req.LabelPattern != "" {
		m := globRegexp(req.LabelPattern).MatchString
		sel.addIssue(func(i *backend.Issue) bool { return anyLabel(i, m) })
	}
	if req.LabelRegex != "" {
		re, err := regexp.Compile(req.LabelRegex)
		if err != nil {
			return nil, invalidf("label regex %q does not compile: %v", req.LabelRegex, err)
		}
		sel.addIssue(func(i *backend.Issue) bool { return anyLabel(i, re.MatchString) })
	}

	if req.NoParent {
		sel.add(func(item *backend.IssueWithCounts) bool { return item.Parent == nil || *item.Parent == "" })
	}
	if req.MolType != nil {
		want := *req.MolType
		sel.addIssue(func(i *backend.Issue) bool { return i.MolType == want })
	}
	if req.WispType != nil {
		want := *req.WispType
		sel.addIssue(func(i *backend.Issue) bool { return i.WispType == want })
	}
	if excluded := normalizeTypes(req.ExcludeTypes); len(excluded) > 0 {
		set := map[string]bool{}
		for _, t := range excluded {
			set[t] = true
		}
		sel.addIssue(func(i *backend.Issue) bool { return !set[string(i.IssueType)] })
	}
	sel.addKeyset(req.AfterCreatedAt, req.AfterID, req.AfterPriority)
	return sel, nil
}

// addKeyset restricts to the rows strictly after a keyset position: under the
// (created desc, id asc) order, or under (priority asc, created desc, id asc)
// when a priority is carried. A position without a timestamp is not a position.
func (s *selection) addKeyset(afterCreated *time.Time, afterID string, afterPriority *int) {
	if afterCreated == nil {
		return
	}
	ac := *afterCreated
	after := func(i *backend.Issue) bool {
		return i.CreatedAt.Before(ac) || (i.CreatedAt.Equal(ac) && i.ID > afterID)
	}
	if afterPriority == nil {
		s.addIssue(after)
		return
	}
	ap := *afterPriority
	s.addIssue(func(i *backend.Issue) bool { return i.Priority > ap || (i.Priority == ap && after(i)) })
}

// ------------------------------------------------------------------ raw filter

// rawSelection is the client-side part of a raw IssueFilter that no ListRequest
// member carries. A field with no meaning in this store is refused here, before
// any read.
func rawSelection(f backend.IssueFilter, query string) (*selection, error) {
	if f.SourceRepo != nil {
		return nil, unsupportedField("SearchIssues", "SourceRepo: a tracker has one source")
	}
	sel := &selection{}
	if len(f.IDs) > 0 {
		ids := map[string]bool{}
		for _, id := range f.IDs {
			ids[id] = true
		}
		sel.addIssue(func(i *backend.Issue) bool { return ids[i.ID] })
	}
	if f.IDPrefix != "" {
		prefix := f.IDPrefix
		sel.addIssue(func(i *backend.Issue) bool { return strings.HasPrefix(i.ID, prefix) })
	}
	if len(f.ExcludeStatus) > 0 {
		excluded := map[backend.Status]bool{}
		for _, s := range f.ExcludeStatus {
			excluded[s] = true
		}
		sel.addIssue(func(i *backend.Issue) bool { return !excluded[i.Status] })
	}
	if query != "" {
		sel.needsText = true
		sel.addIssue(func(i *backend.Issue) bool { return textMatches(i, query) })
	}
	if f.IsBlocked != nil {
		want := *f.IsBlocked
		sel.needsBlocked = true
		sel.addIssue(func(i *backend.Issue) bool { return i.IsBlocked == want })
	}
	timeBound := func(bound *time.Time, after bool) {
		if bound == nil {
			return
		}
		b := *bound
		sel.addIssue(func(i *backend.Issue) bool {
			if i.StartedAt == nil {
				return false
			}
			if after {
				return i.StartedAt.After(b)
			}
			return i.StartedAt.Before(b)
		})
	}
	timeBound(f.StartedAfter, true)
	timeBound(f.StartedBefore, false)
	if f.Ephemeral != nil {
		want := *f.Ephemeral
		sel.addIssue(func(i *backend.Issue) bool { return i.Ephemeral == want })
	}
	if f.EphemeralTier != nil {
		want := *f.EphemeralTier
		sel.addIssue(func(i *backend.Issue) bool { return (i.Ephemeral || i.WispType != "") == want })
	}
	if f.IsTemplate != nil {
		want := *f.IsTemplate
		sel.addIssue(func(i *backend.Issue) bool { return i.IsTemplate == want })
	}
	return sel, nil
}

// merge returns the union of two selections' tests.
func (s *selection) merge(o *selection) *selection {
	out := &selection{
		tests:        append(append([]rowTest(nil), s.tests...), o.tests...),
		needsText:    s.needsText || o.needsText,
		needsBlocked: s.needsBlocked || o.needsBlocked,
	}
	return out
}

// ---------------------------------------------------------------------- orders

// compareBy orders two issues by one of the list sorts, with upstream's
// directions: created, updated and closed newest first, id in natural order.
func compareBy(a, b *backend.Issue, sortBy string) int {
	switch sortBy {
	case "priority":
		return cmp.Compare(a.Priority, b.Priority)
	case "created":
		return b.CreatedAt.Compare(a.CreatedAt)
	case "updated":
		return b.UpdatedAt.Compare(a.UpdatedAt)
	case "closed":
		switch {
		case a.ClosedAt == nil && b.ClosedAt == nil:
			return 0
		case a.ClosedAt == nil:
			return 1
		case b.ClosedAt == nil:
			return -1
		}
		return b.ClosedAt.Compare(*a.ClosedAt)
	case "status":
		return cmp.Compare(a.Status, b.Status)
	case "id":
		return naturalCompareIDs(a.ID, b.ID)
	case "title":
		return cmp.Compare(strings.ToLower(a.Title), strings.ToLower(b.Title))
	case "type":
		return cmp.Compare(a.IssueType, b.IssueType)
	case "assignee":
		return cmp.Compare(a.Assignee, b.Assignee)
	}
	return 0
}

// knownSort reports whether a sort name is one the list understands.
func knownSort(sortBy string) bool {
	switch sortBy {
	case "", "priority", "created", "updated", "closed", "status", "id", "title", "type", "assignee":
		return true
	}
	return false
}

// sortRows orders rows already in the database's order (priority, created
// newest first, id) by a display sort. The sort is stable, so ties keep it.
func sortRows(items []*backend.IssueWithCounts, sortBy string) {
	sort.SliceStable(items, func(i, j int) bool {
		a, b := items[i], items[j]
		if a == nil || a.Issue == nil || b == nil || b.Issue == nil {
			return false
		}
		return compareBy(a.Issue, b.Issue, sortBy) < 0
	})
}

// naturalCompareIDs orders ids by their dot- and dash-separated segments, numeric
// segments by value.
func naturalCompareIDs(a, b string) int {
	sa, sb := idSegments(a), idSegments(b)
	for i := 0; i < len(sa) && i < len(sb); i++ {
		if sa[i] == sb[i] {
			continue
		}
		na, aErr := atoi(sa[i])
		nb, bErr := atoi(sb[i])
		if aErr == nil && bErr == nil {
			if na != nb {
				return na - nb
			}
			continue
		}
		if sa[i] < sb[i] {
			return -1
		}
		return 1
	}
	return len(sa) - len(sb)
}

func idSegments(id string) []string {
	var out []string
	start := 0
	for i, r := range id {
		if r == '.' || r == '-' {
			if i > start {
				out = append(out, id[start:i])
			}
			start = i + 1
		}
	}
	if start < len(id) {
		out = append(out, id[start:])
	}
	return out
}

func atoi(s string) (int, error) {
	n := 0
	if s == "" {
		return 0, errors.New("empty")
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return 0, errors.New("not a number")
		}
		n = n*10 + int(r-'0')
	}
	return n, nil
}

// --------------------------------------------------------------------- guards

// checkMaxRows is the defensive cap: a request that matched more rows than the
// cap allows, where the window it asked for could exceed it, is refused rather
// than answered. The upstream error type is internal to Beads, so the refusal is
// a validation error carrying the same three facts.
func checkMaxRows(matched, maxRows, limit, offset int, source string) error {
	if maxRows <= 0 || matched <= maxRows {
		return nil
	}
	if limit > 0 && limit+offset <= maxRows {
		return nil
	}
	if source == "" {
		source = "max rows"
	}
	return invalidf("the query matched %d rows, over the cap of %d (%s); narrow it or raise the cap", matched, maxRows, source)
}

// briefProject drops the free-form text of rows, as a brief read returns them.
func briefProject(items []*backend.IssueWithCounts) {
	for _, item := range items {
		if item == nil || item.Issue == nil {
			continue
		}
		i := item.Issue
		i.Description, i.Design, i.AcceptanceCriteria, i.Notes, i.Payload, i.Waiters = "", "", "", "", "", nil
		i.IsLitePartial = true
	}
}

// wireSelection evaluates here the members the server evaluates on a listing, for
// rows read one by one by id.
func wireSelection(req issueops.ListRequest) *selection {
	sel := &selection{}
	if statuses := splitList([]string{req.Status}); len(statuses) > 0 && !(len(statuses) == 1 && statuses[0] == "all") {
		want := map[string]bool{}
		for _, s := range statuses {
			want[s] = true
		}
		sel.addIssue(func(i *backend.Issue) bool { return want[string(i.Status)] })
	}
	if req.IssueType != "" {
		t := req.IssueType
		sel.addIssue(func(i *backend.Issue) bool { return string(i.IssueType) == t })
	}
	if req.Assignee != "" {
		a := req.Assignee
		sel.addIssue(func(i *backend.Issue) bool { return i.Assignee == a })
	}
	has := func(i *backend.Issue) map[string]bool {
		set := make(map[string]bool, len(i.Labels))
		for _, l := range i.Labels {
			set[l] = true
		}
		return set
	}
	if len(req.Labels) > 0 {
		sel.addIssue(func(i *backend.Issue) bool {
			set := has(i)
			for _, l := range req.Labels {
				if !set[l] {
					return false
				}
			}
			return true
		})
	}
	if len(req.LabelsAny) > 0 {
		sel.addIssue(func(i *backend.Issue) bool {
			set := has(i)
			for _, l := range req.LabelsAny {
				if set[l] {
					return true
				}
			}
			return false
		})
	}
	if len(req.ExcludeLabels) > 0 {
		sel.addIssue(func(i *backend.Issue) bool {
			set := has(i)
			for _, l := range req.ExcludeLabels {
				if set[l] {
					return false
				}
			}
			return true
		})
	}
	if req.ParentID != "" {
		parent := req.ParentID
		sel.add(func(item *backend.IssueWithCounts) bool {
			if item.Parent != nil && *item.Parent != "" {
				return *item.Parent == parent
			}
			// A dotted id names its parent when no parent-child edge says otherwise.
			return strings.HasPrefix(item.ID, parent+".")
		})
	}
	if req.CreatedAfter != nil {
		b := *req.CreatedAfter
		sel.addIssue(func(i *backend.Issue) bool { return i.CreatedAt.After(b) })
	}
	if req.CreatedBefore != nil {
		b := *req.CreatedBefore
		sel.addIssue(func(i *backend.Issue) bool { return i.CreatedAt.Before(b) })
	}
	if req.HasMetadataKey != "" || len(req.MetadataFields) > 0 {
		key, fields := req.HasMetadataKey, req.MetadataFields
		sel.addIssue(func(i *backend.Issue) bool {
			var doc map[string]json.RawMessage
			if len(i.Metadata) == 0 || json.Unmarshal(i.Metadata, &doc) != nil {
				return key == "" && len(fields) == 0
			}
			if key != "" {
				if v, ok := doc[key]; !ok || string(v) == "null" {
					return false
				}
			}
			for k, want := range fields {
				v, ok := doc[k]
				if !ok {
					return false
				}
				var text string
				if json.Unmarshal(v, &text) != nil {
					text = string(v)
				}
				if text != want {
					return false
				}
			}
			return true
		})
	}
	return sel
}

// orderRows puts rows in the order a listing returns them: priority ascending,
// created newest first, id ascending, then the display sort when one is named.
func orderRows(items []*backend.IssueWithCounts, sortBy string) {
	sort.SliceStable(items, func(i, j int) bool {
		a, b := items[i].Issue, items[j].Issue
		if sortBy != "created" && a.Priority != b.Priority {
			return a.Priority < b.Priority
		}
		if !a.CreatedAt.Equal(b.CreatedAt) {
			return a.CreatedAt.After(b.CreatedAt)
		}
		return a.ID < b.ID
	})
	if sortBy != "" && sortBy != "priority" && sortBy != "created" {
		sortRows(items, sortBy)
	}
}
