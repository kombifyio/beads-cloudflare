package cloudflare

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/steveyegge/beads/backend"
)

// The bulk reads. A command that touches many issues (export, a full listing, the
// relations of a page) must not pay one request per issue: the profile's
// issues:export route returns whole records, comments, labels and edges included,
// keyset paged, and dependencies:export returns every edge. A server that predates
// them answers 404 and the callers fall back to the routes they used before.

const (
	exportPageSize     = 500
	exportIDsPerCall   = 100
	edgeExportPageSize = 5000

	// snapshotTTL bounds how long rows read in bulk may answer later per-id reads of
	// the same command. A command runs for seconds; any write through this client
	// drops the snapshot at once.
	snapshotTTL = 20 * time.Second
)

// exportRecords is the page envelope of issues:export.
type exportRecords struct {
	Items      []*backend.IssueWithCounts `json:"items"`
	HasMore    bool                       `json:"has_more"`
	NextCursor string                     `json:"next_cursor"`
}

// snapshot holds rows read in bulk, complete with their comments, so the relation
// reads that follow a listing (labels, edges, comments, counts of those ids) are
// answered without another request.
type snapshot struct {
	gen      uint64
	at       time.Time
	rows     map[string]*backend.IssueWithCounts
	comments map[string][]*backend.Comment
}

type snapshotCache struct {
	mu   sync.Mutex
	snap *snapshot
}

func (c *snapshotCache) fresh(gen uint64) bool {
	return c.snap != nil && c.snap.gen == gen && time.Since(c.snap.at) <= snapshotTTL
}

func (c *snapshotCache) lookup(gen uint64, ids []string) (found map[string]*backend.IssueWithCounts, comments map[string][]*backend.Comment, missing []string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	found = map[string]*backend.IssueWithCounts{}
	comments = map[string][]*backend.Comment{}
	if !c.fresh(gen) {
		return found, comments, ids
	}
	for _, id := range ids {
		if row, ok := c.snap.rows[id]; ok {
			found[id] = row
			if cs := c.snap.comments[id]; len(cs) > 0 {
				comments[id] = cs
			}
		} else {
			missing = append(missing, id)
		}
	}
	return found, comments, missing
}

func (c *snapshotCache) add(gen uint64, rows []*backend.IssueWithCounts, comments map[string][]*backend.Comment) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.fresh(gen) {
		c.snap = &snapshot{gen: gen, at: time.Now(), rows: map[string]*backend.IssueWithCounts{}, comments: map[string][]*backend.Comment{}}
	}
	for _, r := range rows {
		if r != nil && r.Issue != nil {
			c.snap.rows[r.ID] = r
		}
	}
	for id, cs := range comments {
		c.snap.comments[id] = cs
	}
}

// exportUnsupported reports whether the server answered "no such route" to an
// export read, which means it predates the extension.
func exportUnsupported(err error) bool {
	var p *Problem
	return errors.As(err, &p) && (p.Status == http.StatusNotFound || p.Status == http.StatusMethodNotAllowed)
}

// exportPage reads one page. Comments are split off the rows and returned apart:
// the Issue a caller receives carries no comment thread, as it never did from the
// listing.
func (s *Store) exportPage(ctx context.Context, q url.Values) (exportRecords, map[string][]*backend.Comment, error) {
	var raw struct {
		Items      []json.RawMessage `json:"items"`
		HasMore    bool              `json:"has_more"`
		NextCursor string            `json:"next_cursor"`
	}
	if err := s.client.do(ctx, http.MethodGet, "/issues:export", q, nil, &raw); err != nil {
		return exportRecords{}, nil, err
	}
	page := exportRecords{HasMore: raw.HasMore, NextCursor: raw.NextCursor}
	comments := map[string][]*backend.Comment{}
	for _, one := range raw.Items {
		item := &backend.IssueWithCounts{}
		if err := json.Unmarshal(one, item); err != nil {
			return exportRecords{}, nil, err
		}
		if item.Issue == nil {
			continue
		}
		if q.Get("revision") != "" {
			var rev struct {
				Revision string `json:"revision"`
			}
			if err := json.Unmarshal(one, &rev); err == nil {
				item.Issue.RowVersion = parseRevision(rev.Revision)
			}
		}
		page.Items = append(page.Items, item)
		if len(item.Issue.Comments) > 0 {
			for _, c := range item.Issue.Comments {
				c.IssueID = item.ID
			}
			comments[item.ID] = item.Issue.Comments
			item.Issue.Comments = nil
		}
	}
	return page, comments, nil
}

// exportEvery reads every page of an export selection and remembers the rows.
func (s *Store) exportEvery(ctx context.Context, q url.Values) ([]*backend.IssueWithCounts, error) {
	q = cloneValues(q)
	q.Set("limit", itoa(exportPageSize))
	q.Del("cursor")
	gen := s.client.writes.Load()
	var all []*backend.IssueWithCounts
	for {
		page, comments, err := s.exportPage(ctx, q)
		if err != nil {
			return nil, err
		}
		s.cache.add(gen, page.Items, comments)
		all = append(all, page.Items...)
		if !page.HasMore {
			return all, nil
		}
		if page.NextCursor == "" {
			return nil, fmt.Errorf("issues:export said more rows follow but gave no cursor to read them with: %w", backend.ErrValidation)
		}
		q.Set("cursor", page.NextCursor)
	}
}

func cloneValues(q url.Values) url.Values {
	out := make(url.Values, len(q))
	for k, v := range q {
		out[k] = append([]string(nil), v...)
	}
	return out
}

// exportListValues turns the parameters of a list request into the export's: the
// same filters, minus the ones that only shape a page (all, brief, sort, limit,
// cursor).
func exportListValues(list url.Values, blocked bool) url.Values {
	q := cloneValues(list)
	for _, name := range []string{"all", "brief", "sort", "limit", "cursor"} {
		q.Del(name)
	}
	q.Set("revision", "true")
	if blocked {
		q.Set("blocked", "true")
	}
	return q
}

// sortAsList orders rows the way the wire list does, which is how a listing read
// through the export keeps the order every caller already relies on.
func sortAsList(items []*backend.IssueWithCounts, bySort string) {
	sort.SliceStable(items, func(i, j int) bool {
		a, b := items[i].Issue, items[j].Issue
		if bySort == "priority" && a.Priority != b.Priority {
			return a.Priority < b.Priority
		}
		if !a.CreatedAt.Equal(b.CreatedAt) {
			return a.CreatedAt.After(b.CreatedAt)
		}
		return a.ID < b.ID
	})
}

// allIssueValues selects every row, whatever its type, tier or status.
func allIssueValues() url.Values {
	return newQuery().flag("include_templates", true).flag("include_gates", true).flag("include_infra", true).flag("include_ephemeral", true).values()
}

// rowsWithRelations returns the rows of ids with their labels, edges, counts and
// comments, from the snapshot of the current command or a bounded number of export
// calls. ok is false when the server has no export route; the caller then reads
// the old way.
func (s *Store) rowsWithRelations(ctx context.Context, ids []string) (rows map[string]*backend.IssueWithCounts, comments map[string][]*backend.Comment, ok bool, err error) {
	gen := s.client.writes.Load()
	rows, comments, missing := s.cache.lookup(gen, ids)
	if len(missing) == 0 {
		return rows, comments, true, nil
	}
	if s.noExport.Load() {
		return nil, nil, false, nil
	}
	for start := 0; start < len(missing); start += exportIDsPerCall {
		part := missing[start:min(start+exportIDsPerCall, len(missing))]
		q := allIssueValues()
		q.Set("ids", strings.Join(part, ","))
		q.Set("revision", "true")
		q.Set("limit", itoa(exportIDsPerCall))
		// A page stops at the server's size bound (4 MiB of text) however few rows
		// it holds, so a short page is not the end: an issue with a long comment
		// thread would otherwise be taken for absent. Every continuation is read.
		for {
			page, fetched, err := s.exportPage(ctx, q)
			if err != nil {
				if exportUnsupported(err) {
					s.noExport.Store(true)
					return nil, nil, false, nil
				}
				return nil, nil, false, err
			}
			s.cache.add(gen, page.Items, fetched)
			for _, item := range page.Items {
				rows[item.ID] = item
				if cs := fetched[item.ID]; len(cs) > 0 {
					comments[item.ID] = cs
				}
			}
			if !page.HasMore {
				break
			}
			if page.NextCursor == "" {
				return nil, nil, false, fmt.Errorf("issues:export said more rows follow but gave no cursor to read them with: %w", backend.ErrValidation)
			}
			q.Set("cursor", page.NextCursor)
		}
	}
	return rows, comments, true, nil
}

// allEdges reads every stored edge of the tracker, a few thousand to a request.
func (s *Store) allEdges(ctx context.Context) (map[string][]*backend.Dependency, bool, error) {
	if s.noExport.Load() {
		return nil, false, nil
	}
	out := map[string][]*backend.Dependency{}
	q := url.Values{"limit": {itoa(edgeExportPageSize)}}
	for {
		var page struct {
			Items      []*backend.Dependency `json:"items"`
			HasMore    bool                  `json:"has_more"`
			NextCursor string                `json:"next_cursor"`
		}
		if err := s.client.do(ctx, http.MethodGet, "/dependencies:export", q, nil, &page); err != nil {
			if exportUnsupported(err) {
				s.noExport.Store(true)
				return nil, false, nil
			}
			return nil, false, err
		}
		for _, e := range page.Items {
			out[e.IssueID] = append(out[e.IssueID], e)
		}
		if !page.HasMore {
			return out, true, nil
		}
		if page.NextCursor == "" {
			return nil, false, fmt.Errorf("dependencies:export said more edges follow but gave no cursor to read them with: %w", backend.ErrValidation)
		}
		q.Set("cursor", page.NextCursor)
	}
}
