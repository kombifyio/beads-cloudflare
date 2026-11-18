package cloudflare

import (
	"context"
	"fmt"
	"net/http"
	"sync"

	"github.com/steveyegge/beads/backend"
)

// Capability tokens of the profile extensions this client relies on. A server that
// does not advertise one cannot carry the members that depend on it, and the
// request is refused before anything is written.
const (
	capImportMerge     = "profile.import_merge"
	capXExtra          = "profile.x_extra"
	capApplyExtensions = "profile.apply_batch_extensions"
)

type capabilityBook struct {
	mu   sync.Mutex
	have map[string]bool
}

// capabilities reads the server's capability document once per process. It is a
// property of the deployment, not of a row, so one read serves every later check.
func (s *Store) capabilities(ctx context.Context) (map[string]bool, error) {
	s.caps.mu.Lock()
	defer s.caps.mu.Unlock()
	if s.caps.have != nil {
		return s.caps.have, nil
	}
	var doc struct {
		Capabilities []string `json:"capabilities"`
	}
	if err := s.client.do(ctx, http.MethodGet, "/context", nil, nil, &doc); err != nil {
		return nil, fmt.Errorf("read the server's capabilities: %w", err)
	}
	have := make(map[string]bool, len(doc.Capabilities))
	for _, c := range doc.Capabilities {
		have[c] = true
	}
	s.caps.have = have
	return have, nil
}

// requireCapability refuses, with a typed error naming the missing capability,
// an operation the server cannot carry faithfully.
func (s *Store) requireCapability(ctx context.Context, op, token string) error {
	have, err := s.capabilities(ctx)
	if err != nil {
		return err
	}
	if !have[token] {
		return unsupportedField(op, "the server does not advertise the capability "+token)
	}
	return nil
}

// issueExtra is the x_extra object of an issue: the core Issue members the upstream
// create body has no member for, under their core names and types. Empty when the
// issue sets none.
func issueExtra(i *backend.Issue) map[string]any {
	m := map[string]any{}
	str := func(name, v string) {
		if v != "" {
			m[name] = v
		}
	}
	str("spec_id", i.SpecID)
	str("source_system", i.SourceSystem)
	str("wisp_type", string(i.WispType))
	str("storage_class", string(i.StorageClass))
	str("await_type", i.AwaitType)
	str("await_id", i.AwaitID)
	str("source_formula", i.SourceFormula)
	str("source_location", i.SourceLocation)
	str("mol_type", string(i.MolType))
	str("work_type", string(i.WorkType))
	str("event_kind", i.EventKind)
	str("actor", i.Actor)
	str("target", i.Target)
	str("payload", i.Payload)
	if i.IsTemplate {
		m["is_template"] = true
	}
	if i.Pinned {
		m["pinned"] = true
	}
	if i.Timeout != 0 {
		m["timeout"] = int64(i.Timeout)
	}
	if len(i.Waiters) > 0 {
		m["waiters"] = i.Waiters
	}
	if len(i.BondedFrom) > 0 {
		bonds := make([]map[string]any, 0, len(i.BondedFrom))
		for _, b := range i.BondedFrom {
			bond := map[string]any{"source_id": b.SourceID, "bond_type": b.BondType}
			if b.BondPoint != "" {
				bond["bond_point"] = b.BondPoint
			}
			bonds = append(bonds, bond)
		}
		m["bonded_from"] = bonds
	}
	if len(m) == 0 {
		return nil
	}
	return m
}
