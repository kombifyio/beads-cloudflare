// Package cloudflare implements the Beads storage engine interface over a
// kombifyio/beads-cloudflare Worker.
//
// The Worker serves the upstream `bd serve` /v0 contract as a declared profile,
// so this client is a thin, faithful translation of that contract rather than a
// second implementation of Beads semantics. Anything the profile does not serve
// is reported as unsupported rather than approximated.
package cloudflare

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync/atomic"
	"time"
)

// Client speaks the Worker profile of the upstream /v0 contract.
type Client struct {
	base    string
	tracker string
	token   string
	http    *http.Client
	// actor is the principal every write asserts. The Worker does not trust it
	// for authorization — it records the verified principal — but upstream
	// requires the member and keeps it as event provenance.
	actor string
	// writes counts the writes this client issued; a bulk read is only trusted
	// for the reads that follow it while no write happened in between.
	writes atomic.Uint64
	// connect holds the once-per-process version check against the store.
	connect connectCheck
}

// NewClient builds a client for one tracker. base is the Worker origin without
// a trailing slash; token is an OAuth access token or an agent API key.
func NewClient(base, tracker, token, actor string) *Client {
	return &Client{
		base:    strings.TrimRight(base, "/"),
		tracker: tracker,
		token:   token,
		actor:   actor,
		http:    &http.Client{Timeout: 60 * time.Second},
	}
}

func (c *Client) url(path string, query url.Values) string {
	u := fmt.Sprintf("%s/t/%s/v0/beads%s", c.base, url.PathEscape(c.tracker), path)
	if len(query) > 0 {
		u += "?" + query.Encode()
	}
	return u
}

// do issues one request and decodes a successful JSON body into out.
// doGet reads one resource into a map.
func (c *Client) doGet(ctx context.Context, path string) (map[string]any, error) {
	out := map[string]any{}
	if err := c.do(ctx, http.MethodGet, path, nil, nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// Delete removes one resource.
func (c *Client) Delete(ctx context.Context, path string) error {
	return c.do(ctx, http.MethodDelete, path, nil, nil, nil)
}

// do is defined in transport.go.

// ---------------------------------------------------------------- operations

type createRequest struct {
	Actor              string             `json:"actor"`
	Title              string             `json:"title"`
	ID                 string             `json:"id,omitempty"`
	ForceIDPrefix      bool               `json:"force_id_prefix,omitempty"`
	Description        string             `json:"description,omitempty"`
	Design             string             `json:"design,omitempty"`
	AcceptanceCriteria string             `json:"acceptance_criteria,omitempty"`
	Notes              string             `json:"notes,omitempty"`
	IssueType          string             `json:"issue_type"`
	Status             string             `json:"status,omitempty"`
	Priority           int                `json:"priority"`
	Assignee           string             `json:"assignee,omitempty"`
	Owner              string             `json:"owner,omitempty"`
	Labels             []string           `json:"labels,omitempty"`
	EstimatedMinutes   *int               `json:"estimated_minutes,omitempty"`
	ExternalRef        string             `json:"external_ref,omitempty"`
	DueAt              *time.Time         `json:"due_at,omitempty"`
	DeferUntil         *time.Time         `json:"defer_until,omitempty"`
	Metadata           json.RawMessage    `json:"metadata,omitempty"`
	Dependencies       []createDependency `json:"dependencies,omitempty"`
	ParentID           string             `json:"parent_id,omitempty"`
	InheritLabels      bool               `json:"inherit_labels_from_parent,omitempty"`
	Sender             string             `json:"sender,omitempty"`
	WaitsFor           *createWaitsFor    `json:"waits_for,omitempty"`
	NoHistory          bool               `json:"no_history,omitempty"`
	Ephemeral          bool               `json:"ephemeral,omitempty"`
	// Migration-safe creation: the profile stamps created_at and created_by from
	// the server clock and the verified principal unless these are set.
	PreserveTimestamps bool `json:"preserve_timestamps,omitempty"`
	// A pointer, not a time.Time: encoding/json does not apply omitempty to a
	// struct, so a zero time would still be sent and the store would record
	// year one as the issue's age.
	CreatedAt         *time.Time `json:"created_at,omitempty"`
	StartedAt         *time.Time `json:"started_at,omitempty"`
	ClosedAt          *time.Time `json:"closed_at,omitempty"`
	OriginalCreatedBy string     `json:"original_created_by,omitempty"`
	// XExtra carries the core Issue members the upstream create body has no member
	// for (profile.x_extra).
	XExtra map[string]any `json:"x_extra,omitempty"`
}

type createDependency struct {
	TargetID string          `json:"target_id"`
	Type     string          `json:"type"`
	Reverse  bool            `json:"reverse,omitempty"`
	Metadata json.RawMessage `json:"metadata,omitempty"`
}

type createWaitsFor struct {
	SpawnerID string `json:"spawner_id"`
	Gate      string `json:"gate,omitempty"`
}

// CustomOp invokes one of the custom issue verbs (claim, release, close, reopen).
func (c *Client) CustomOp(ctx context.Context, id, verb string, body map[string]any) (map[string]any, error) {
	out := map[string]any{}
	path := "/issues/" + url.PathEscape(id) + ":" + verb
	if err := c.do(ctx, http.MethodPost, path, nil, body, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// Memories reads and writes the store's key/value memories.
func (c *Client) Memory(ctx context.Context, key string) (map[string]any, error) {
	out := map[string]any{}
	if err := c.do(ctx, http.MethodGet, "/memories/"+url.PathEscape(key), nil, nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

func (c *Client) Remember(ctx context.Context, key, value string) error {
	// The operation's body is the content and the key and nothing else: a member
	// named value or actor is refused.
	return c.do(ctx, http.MethodPost, "/memories", nil, map[string]any{
		"key":     key,
		"content": value,
	}, nil)
}

func (c *Client) Forget(ctx context.Context, key string) error {
	return c.do(ctx, http.MethodDelete, "/memories/"+url.PathEscape(key), nil, nil, nil)
}

func (c *Client) ListMemories(ctx context.Context) (map[string]any, error) {
	out := map[string]any{}
	if err := c.do(ctx, http.MethodGet, "/memories", nil, nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}
