package cloudflare

import (
	"encoding/json"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
)

// The role methods in this package are each the inverse of one upstream bd serve
// handler: they encode a role request as that handler's wire request, call the
// route, and decode the wire response into the role result. This file holds the
// small encoders those methods share.

// query builds a query string the way the upstream decoders read it: lists are
// repeated parameters, booleans are the words true and false, and an unset
// value is omitted rather than sent empty.
type query struct{ v url.Values }

func newQuery() *query { return &query{v: url.Values{}} }

func (q *query) str(name, value string) *query {
	if value != "" {
		q.v.Set(name, value)
	}
	return q
}

func (q *query) list(name string, values []string) *query {
	for _, value := range values {
		if value != "" {
			q.v.Add(name, value)
		}
	}
	return q
}

func (q *query) csv(name string, values ...string) *query {
	var kept []string
	for _, value := range values {
		if value != "" {
			kept = append(kept, value)
		}
	}
	if len(kept) > 0 {
		q.v.Set(name, strings.Join(kept, ","))
	}
	return q
}

func (q *query) flag(name string, on bool) *query {
	if on {
		q.v.Set(name, "true")
	}
	return q
}

func (q *query) integer(name string, value *int) *query {
	if value != nil {
		q.v.Set(name, strconv.Itoa(*value))
	}
	return q
}

func (q *query) stamp(name string, value *time.Time) *query {
	if value != nil && !value.IsZero() {
		q.v.Set(name, value.UTC().Format(time.RFC3339Nano))
	}
	return q
}

func (q *query) pairs(name string, fields map[string]string) *query {
	// Sorted, so the same request is the same bytes every time.
	keys := make([]string, 0, len(fields))
	for key := range fields {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		q.v.Add(name, key+"="+fields[key])
	}
	return q
}

func (q *query) values() url.Values {
	if len(q.v) == 0 {
		return nil
	}
	return q.v
}

// revisionToken renders a row version the way the wire spells it: a decimal
// string, so the full int64 range survives a JSON consumer.
func revisionToken(v int64) string { return strconv.FormatInt(v, 10) }

func parseRevision(token string) int64 {
	v, err := strconv.ParseInt(strings.TrimSpace(token), 10, 64)
	if err != nil {
		return 0
	}
	return v
}

func versionGuard(v *int64) *string {
	if v == nil {
		return nil
	}
	s := revisionToken(*v)
	return &s
}

// rawOrNil drops an empty raw message so omitempty keeps the member off the wire.
func rawOrNil(raw json.RawMessage) json.RawMessage {
	if len(raw) == 0 {
		return nil
	}
	return raw
}

func ptrIf(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func boolPtr(b bool) *bool {
	if !b {
		return nil
	}
	return &b
}

func itoa(n int) string { return strconv.Itoa(n) }
