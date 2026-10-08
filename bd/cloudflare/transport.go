package cloudflare

import (
	"bytes"
	"context"
	cryptorand "crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"math/rand/v2"
	"net/http"
	"net/url"
	"strconv"
	"time"
)

// Transport policy. Every write carries an Idempotency-Key that is minted once
// per logical operation and reused across this client's own retries, so a retry
// after a lost response replays the stored answer instead of writing twice.
const (
	maxAttempts    = 4
	baseBackoff    = 250 * time.Millisecond
	maxBackoff     = 4 * time.Second
	agentHeader    = "X-Beads-Agent"
	idempotencyKey = "Idempotency-Key"
)

type actorKey struct{}

// WithActor names the principal a call acts for. The server ignores the asserted
// actor for authorization and records it as provenance, so it is sent both in
// the request body (where the contract requires it) and as X-Beads-Agent.
func WithActor(ctx context.Context, actor string) context.Context {
	if actor == "" {
		return ctx
	}
	return context.WithValue(ctx, actorKey{}, actor)
}

func (c *Client) actorFor(ctx context.Context) string {
	if a, ok := ctx.Value(actorKey{}).(string); ok && a != "" {
		return a
	}
	return c.actor
}

// newIdempotencyKey mints the key of one logical write. It is random and fixed for
// the transport's own retries of that write, so a retry after a lost response
// replays the stored answer instead of writing twice.
func newIdempotencyKey() string {
	var b [16]byte
	if _, err := cryptorand.Read(b[:]); err != nil {
		return "bd-" + strconv.FormatInt(time.Now().UnixNano(), 36)
	}
	return "bd-" + hex.EncodeToString(b[:])
}

func isWrite(method string) bool {
	return method != http.MethodGet && method != http.MethodHead
}

// do issues one logical request and decodes a successful JSON body into out.
// Network errors and 5xx answers are retried with backoff; a 4xx is the server's
// answer and is never retried.
func (c *Client) do(ctx context.Context, method, path string, query url.Values, body any, out any) error {
	if err := c.ensureCompatible(ctx); err != nil {
		return err
	}
	var encoded []byte
	if body != nil {
		var err error
		encoded, err = json.Marshal(body)
		if err != nil {
			return err
		}
	}
	key := ""
	if isWrite(method) {
		key = newIdempotencyKey()
		c.writes.Add(1)
		defer c.writes.Add(1)
	}
	actor := c.actorFor(ctx)

	var lastErr error
	for attempt := 0; attempt < maxAttempts; attempt++ {
		if attempt > 0 {
			if err := sleepBackoff(ctx, attempt, lastErr); err != nil {
				return lastErr
			}
		}
		retry, err := c.once(ctx, method, path, query, encoded, key, actor, out)
		if err == nil {
			return nil
		}
		lastErr = err
		if !retry {
			return err
		}
	}
	return lastErr
}

// once performs one attempt and reports whether a failure is worth retrying.
func (c *Client) once(ctx context.Context, method, path string, query url.Values, encoded []byte, key, actor string, out any) (retry bool, err error) {
	var reader io.Reader
	if encoded != nil {
		reader = bytes.NewReader(encoded)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.url(path, query), reader)
	if err != nil {
		return false, err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Accept", "application/json")
	if encoded != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if actor != "" {
		req.Header.Set(agentHeader, actor)
	}
	if key != "" {
		req.Header.Set(idempotencyKey, key)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		// A cancelled or expired context is the caller's decision, not a fault.
		if ctx.Err() != nil {
			return false, err
		}
		return true, err
	}
	defer func() { _ = resp.Body.Close() }()
	payload, err := io.ReadAll(resp.Body)
	if err != nil {
		return ctx.Err() == nil, err
	}
	if resp.StatusCode >= 400 {
		perr := decodeProblem(resp.StatusCode, payload)
		if p := (*Problem)(nil); errors.As(perr, &p) && (p.Status >= 500 || p.Status == http.StatusTooManyRequests) {
			p.retryAfter = retryAfter(resp)
			return true, perr
		}
		return false, perr
	}
	if out == nil || len(bytes.TrimSpace(payload)) == 0 {
		return false, nil
	}
	return false, json.Unmarshal(payload, out)
}

func retryAfter(resp *http.Response) time.Duration {
	if v := resp.Header.Get("Retry-After"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 0 {
			return time.Duration(n) * time.Second
		}
	}
	return 0
}

func sleepBackoff(ctx context.Context, attempt int, last error) error {
	d := baseBackoff << (attempt - 1)
	if d > maxBackoff {
		d = maxBackoff
	}
	var p *Problem
	if errors.As(last, &p) && p.retryAfter > d {
		d = p.retryAfter
		if d > 10*time.Second {
			d = 10 * time.Second
		}
	}
	// Jitter keeps a fleet of agents from retrying in lockstep.
	d += time.Duration(rand.Int64N(int64(d/2) + 1))
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}
