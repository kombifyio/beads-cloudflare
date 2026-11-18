package cloudflare

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"slices"
	"strconv"
	"time"

	"github.com/steveyegge/beads/backend"
)

// The audit trail. The server's journal is one ordered stream per tracker
// (listEvents, by sequence number, at most 10000 records to a page) with no filter
// by issue, so every read here walks it from the start of the range it needs and
// follows the stream until it ends. A read that stopped at the first page would
// answer for the first thousand mutations of the tracker and call it the history.

const eventsPageSize = 10000

// eventRecord is one journal record.
type eventRecord struct {
	Seq        int             `json:"seq"`
	TS         time.Time       `json:"ts"`
	Op         string          `json:"op"`
	IssueID    string          `json:"issue_id"`
	Actor      string          `json:"actor"`
	Issue      *backend.Issue  `json:"issue"`
	Comment    json.RawMessage `json:"comment"`
	XEventType string          `json:"x_event_type"`
}

// eachEvent walks the journal from after sequence number since to its head,
// calling fn for each record in order until fn reports it has enough.
func (s *Store) eachEvent(ctx context.Context, since int, fn func(eventRecord) (stop bool)) error {
	for {
		var page struct {
			Head    int           `json:"head"`
			Records []eventRecord `json:"records"`
		}
		q := newQuery()
		q.v.Set("since", strconv.Itoa(since))
		q.v.Set("limit", strconv.Itoa(eventsPageSize))
		if err := s.client.do(ctx, http.MethodGet, "/events", q.values(), nil, &page); err != nil {
			return err
		}
		for _, rec := range page.Records {
			since = rec.Seq
			if fn(rec) {
				return nil
			}
		}
		if len(page.Records) == 0 || since >= page.Head {
			return nil
		}
	}
}

// toEvent converts a journal record into the audit event upstream reports.
func toEvent(r eventRecord) *backend.Event {
	e := &backend.Event{
		ID:        strconv.Itoa(r.Seq),
		IssueID:   r.IssueID,
		EventType: backend.EventType(r.XEventType),
		Actor:     r.Actor,
		CreatedAt: r.TS,
	}
	if len(r.Comment) > 0 && string(r.Comment) != "null" {
		var c struct {
			Text string `json:"text"`
		}
		if json.Unmarshal(r.Comment, &c) == nil && c.Text != "" {
			text := c.Text
			e.Comment = &text
		}
	}
	return e
}

// eventsAfter returns the events strictly after a (created, id) position, oldest
// first, optionally of one issue.
func (s *Store) eventsAfter(ctx context.Context, cursor backend.EventCursor, issueID string, limit int) ([]*backend.Event, error) {
	afterSeq, _ := strconv.Atoi(cursor.ID)
	var out []*backend.Event
	err := s.eachEvent(ctx, 0, func(r eventRecord) bool {
		if issueID != "" && r.IssueID != issueID {
			return false
		}
		if !cursor.CreatedAt.IsZero() {
			switch {
			case r.TS.Before(cursor.CreatedAt):
				return false
			case r.TS.Equal(cursor.CreatedAt) && (cursor.ID == "" || r.Seq <= afterSeq):
				return false
			}
		}
		out = append(out, toEvent(r))
		return limit > 0 && len(out) >= limit
	})
	return out, err
}

// EventsSince pages the durable event log after a keyset cursor, as upstream does:
// oldest first, a limit that defaults to 100 and is clamped to 500.
func (s *Store) EventsSince(ctx context.Context, cursor backend.EventCursor, issueID string, limit int) ([]*backend.Event, error) {
	if err := s.checkOpen("EventsSince"); err != nil {
		return nil, err
	}
	switch {
	case limit <= 0:
		limit = 100
	case limit > 500:
		limit = 500
	}
	return s.eventsAfter(ctx, cursor, issueID, limit)
}

// GetEvents reads one issue's audit trail, newest first, bounded by limit when
// limit is positive.
func (s *Store) GetEvents(ctx context.Context, issueID string, limit int) ([]*backend.Event, error) {
	if err := s.checkOpen("GetEvents"); err != nil {
		return nil, err
	}
	events, err := s.eventsAfter(ctx, backend.EventCursor{}, issueID, 0)
	if err != nil {
		return nil, err
	}
	slices.Reverse(events)
	if limit > 0 && len(events) > limit {
		events = events[:limit]
	}
	return events, nil
}

// GetAllEventsSince reads every event after a time, oldest first.
func (s *Store) GetAllEventsSince(ctx context.Context, since time.Time) ([]*backend.Event, error) {
	if err := s.checkOpen("GetAllEventsSince"); err != nil {
		return nil, err
	}
	return s.eventsAfter(ctx, backend.EventCursor{CreatedAt: since}, "", 0)
}

// CountEvents counts one issue's events, capped at limit when limit is positive.
func (s *Store) CountEvents(ctx context.Context, issueID string, limit int) (int64, error) {
	if err := s.checkOpen("CountEvents"); err != nil {
		return 0, err
	}
	var n int64
	err := s.eachEvent(ctx, 0, func(r eventRecord) bool {
		if r.IssueID == issueID {
			n++
		}
		return limit > 0 && n >= int64(limit)
	})
	return n, err
}

// History reads an issue's revisions from the durable events journal: every
// mutation records the issue as it stood after the change, and the sequence
// number stands where a commit hash would. Newest first, like a commit log.
func (s *Store) History(ctx context.Context, issueID string) ([]*backend.HistoryEntry, error) {
	if err := s.checkOpen("History"); err != nil {
		return nil, err
	}
	var entries []*backend.HistoryEntry
	err := s.eachEvent(ctx, 0, func(r eventRecord) bool {
		if r.IssueID == issueID && r.Issue != nil {
			entries = append(entries, &backend.HistoryEntry{
				CommitHash: fmt.Sprintf("%08x", r.Seq), Committer: r.Actor, CommitDate: r.TS, Issue: r.Issue,
			})
		}
		return false
	})
	if err != nil {
		return nil, err
	}
	slices.Reverse(entries)
	return entries, nil
}
