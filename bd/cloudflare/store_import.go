package cloudflare

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/steveyegge/beads/backend"
	"github.com/steveyegge/beads/issueops"
)

// CreateIssuesWithFullOptions is the import write: it keeps each record's id,
// age and author, and lands the call in the server's merge import
// (issues:import with mode "merge"), which has upstream's ImportBatch semantics
// inside one transaction: a new id is created, an existing id is conditionally
// rewritten, and labels, comments and edges only ever add. A stored row that is
// newer than the record is kept whole when stale rejection is asked for, and a
// tie keeps the stored columns.
//
// There is no other route. The server's whole-record replace import deletes what
// a record does not carry and overwrites on ties, which is not what `bd import`
// means, and a copy built from the ordinary create and update routes cannot carry
// every member of a record. A server that lacks the merge import is refused here,
// before anything is written, with an error naming the capability.

const (
	importRecordsPerRequest = 200
	// importBytesPerRequest keeps a request inside the 4 MiB a merge request may
	// carry without the import scope.
	importBytesPerRequest = 3 << 20
	importEdgesPerRequest = 4500
	importCommentsPerReq  = 4500
)

// mergeResult is the part of the merge import's answer the adapter reports back
// through upstream's callbacks.
type mergeResult struct {
	Issues struct {
		Created      int `json:"created"`
		Updated      int `json:"updated"`
		Unchanged    int `json:"unchanged"`
		SkippedStale int `json:"skipped_stale"`
	} `json:"issues"`
	SkippedStaleIDs     []string `json:"skipped_stale_ids"`
	SkippedDependencies []struct {
		IssueID     string `json:"issue_id"`
		DependsOnID string `json:"depends_on_id"`
		Reason      string `json:"reason"`
	} `json:"skipped_dependencies"`
	// ClaimConflicts are records whose status or assignee was left as stored because
	// another principal holds a live claim on the row.
	ClaimConflicts []struct {
		IssueID   string `json:"issue_id"`
		Assignee  string `json:"assignee"`
		ClaimedBy string `json:"claimed_by"`
	} `json:"claim_conflicts"`
}

func (s *Store) CreateIssuesWithFullOptions(ctx context.Context, issues []*backend.Issue, actor string, opts backend.BatchCreateOptions) error {
	const op = "CreateIssuesWithFullOptions"
	if err := s.writeRefused(op); err != nil {
		return err
	}
	if err := s.checkOpen(op); err != nil {
		return err
	}
	if !opts.SkipDependencyValidationErrors {
		// The merge import drops and reports an edge it cannot store, as upstream
		// does when this is set; it cannot fail the batch for one, and the batch
		// would already be committed when the report arrived.
		return unsupportedField(op, "SkipDependencyValidationErrors=false")
	}
	if err := s.requireCapability(ctx, op, capImportMerge); err != nil {
		return err
	}

	records := make([]*backend.Issue, 0, len(issues))
	for _, issue := range issues {
		if issue == nil {
			continue
		}
		if issue.ID == "" {
			return invalidf("%s: an imported record has no id", op)
		}
		records = append(records, issue)
	}

	// The create-only and conflict-skip modes are decided against the tracker as
	// it is now: a fresh read (never the bulk-read cache), made before the first
	// write. The stale guard below runs inside the import's own transaction and
	// is what stops a record from overwriting a row written in between.
	rejectStale := opts.RejectStaleUpserts
	if opts.CreateOnly || opts.ConflictSkip {
		existing, err := s.existingIDs(ctx, records)
		if err != nil {
			return err
		}
		if opts.CreateOnly {
			for _, issue := range records {
				if existing[issue.ID] {
					return fmt.Errorf("import %s: %w", issue.ID, backend.ErrAlreadyExists)
				}
			}
		} else {
			kept := records[:0:0]
			for _, issue := range records {
				if !existing[issue.ID] {
					kept = append(kept, issue)
				}
			}
			records = kept
			rejectStale = true
		}
	}

	var conflicts []string
	for len(records) > 0 {
		chunk, wire, rest, err := nextImportChunk(records)
		if err != nil {
			return err
		}
		records = rest
		body := map[string]any{"actor": pickActor(actor, s.client.actor), "mode": "merge", "issues": wire}
		if rejectStale {
			body["reject_stale"] = true
		}
		if opts.SkipPrefixValidation {
			body["skip_prefix_validation"] = true
		}
		var out mergeResult
		if err := s.client.do(WithActor(ctx, actor), http.MethodPost, "/issues:import", nil, body, &out); err != nil {
			return fmt.Errorf("import %s..%s: %w", chunk[0].ID, chunk[len(chunk)-1].ID, err)
		}
		if opts.OnStaleRejected != nil {
			for _, id := range out.SkippedStaleIDs {
				opts.OnStaleRejected(id)
			}
		}
		if opts.OnSkippedDependency != nil {
			for _, d := range out.SkippedDependencies {
				opts.OnSkippedDependency(d.IssueID, d.DependsOnID, d.Reason)
			}
		}
		for _, c := range out.ClaimConflicts {
			conflicts = append(conflicts, fmt.Sprintf("%s (held by %s)", c.IssueID, c.Assignee))
		}
	}
	if len(conflicts) > 0 {
		// A merge never takes a live claim from its holder; the rest of every record
		// (labels, comments, edges, the other columns) was imported. Say so.
		return fmt.Errorf("import: %d record(s) kept their status and assignee because another principal holds a live claim on them: %s: %w",
			len(conflicts), strings.Join(conflicts, ", "), issueops.ErrAlreadyClaimed)
	}
	return nil
}

// nextImportChunk takes the records one request carries: as many as the record,
// byte, edge and comment bounds allow, always at least one.
func nextImportChunk(records []*backend.Issue) (chunk []*backend.Issue, wire []json.RawMessage, rest []*backend.Issue, err error) {
	bytes, edges, comments := 0, 0, 0
	for i, issue := range records {
		raw, err := importRecord(issue)
		if err != nil {
			return nil, nil, nil, err
		}
		if i > 0 && (i >= importRecordsPerRequest || bytes+len(raw) > importBytesPerRequest ||
			edges+len(issue.Dependencies) > importEdgesPerRequest || comments+len(issue.Comments) > importCommentsPerReq) {
			return chunk, wire, records[i:], nil
		}
		chunk = append(chunk, issue)
		wire = append(wire, raw)
		bytes += len(raw)
		edges += len(issue.Dependencies)
		comments += len(issue.Comments)
	}
	return chunk, wire, nil, nil
}

// importRecord encodes one issue as an import record. A timestamp the issue does
// not have is left out rather than sent as year one, which the stale guard would
// read as a real, ancient time.
func importRecord(issue *backend.Issue) (json.RawMessage, error) {
	raw, err := json.Marshal(issue)
	if err != nil {
		return nil, fmt.Errorf("import %s: %w", issue.ID, err)
	}
	var doc map[string]json.RawMessage
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, fmt.Errorf("import %s: %w", issue.ID, err)
	}
	for _, name := range []string{"created_at", "updated_at"} {
		if v, ok := doc[name]; ok && strings.HasPrefix(string(v), `"0001-01-01`) {
			delete(doc, name)
		}
	}
	// A comment's id is its own or none (an empty one would be taken as an id), and
	// its issue is the record it sits in.
	if rawComments, ok := doc["comments"]; ok {
		var comments []map[string]json.RawMessage
		if err := json.Unmarshal(rawComments, &comments); err == nil {
			for _, c := range comments {
				delete(c, "issue_id")
				if v, ok := c["id"]; ok && string(v) == `""` {
					delete(c, "id")
				}
			}
			if enc, err := json.Marshal(comments); err == nil {
				doc["comments"] = enc
			}
		}
	}
	// A new row needs an age: as upstream stamps one on a record that has none, the
	// moment of the import is its created_at (the server writes it only on create).
	if _, ok := doc["created_at"]; !ok {
		stamp, _ := json.Marshal(time.Now().UTC().Format(time.RFC3339Nano))
		doc["created_at"] = stamp
	}
	return json.Marshal(doc)
}

// existingIDs reads, fresh, which of the records' ids the tracker holds. It does
// not touch the bulk-read cache: a cached row must never feed a write decision.
func (s *Store) existingIDs(ctx context.Context, records []*backend.Issue) (map[string]bool, error) {
	have := map[string]bool{}
	for start := 0; start < len(records); start += exportIDsPerCall {
		ids := make([]string, 0, exportIDsPerCall)
		for _, issue := range records[start:min(start+exportIDsPerCall, len(records))] {
			ids = append(ids, issue.ID)
		}
		q := allIssueValues()
		q.Set("ids", strings.Join(ids, ","))
		q.Set("limit", itoa(exportIDsPerCall))
		if err := s.eachExportPage(ctx, q, func(page exportRecords) {
			for _, item := range page.Items {
				have[item.ID] = true
			}
		}); err != nil {
			return nil, err
		}
	}
	return have, nil
}

// errNoExport says the server has no issues:export route.
var errNoExport = unsupportedField("export", "the server has no issues:export route")

// eachExportPage reads every page of an export selection, uncached.
func (s *Store) eachExportPage(ctx context.Context, q url.Values, fn func(exportRecords)) error {
	q = cloneValues(q)
	for {
		page, _, err := s.exportPage(ctx, q)
		if err != nil {
			if exportUnsupported(err) {
				s.noExport.Store(true)
				return errNoExport
			}
			return err
		}
		fn(page)
		if !page.HasMore {
			return nil
		}
		if page.NextCursor == "" {
			return fmt.Errorf("issues:export said more rows follow but gave no cursor to read them with: %w", backend.ErrValidation)
		}
		q.Set("cursor", page.NextCursor)
	}
}
