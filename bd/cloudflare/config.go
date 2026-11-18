package cloudflare

import (
	"context"
	"net/http"
	"net/url"
	"strings"

	"github.com/steveyegge/beads/backend"
	"github.com/steveyegge/beads/issueops"
)

// The durable workspace settings plane, over the profile's config endpoints.
//
// Keys are case-sensitive and the server keeps them that way: "MyKey" and
//"mykey" are two settings. Folding them here would silently drop one.

// memoryKeyPrefix is where Beads keeps a persistent memory in the config table
// (kv.memory.<key>). Here memories are their own plane in the store, so every
// config call that names such a key is routed to it: that is how the importer
// writes a memory line, how an export reads them (GetAllConfig) and how the
// config readers see them.
const memoryKeyPrefix = "kv.memory."

// SetConfig writes one setting.
//
// The server validates before it writes, so an invalid custom vocabulary leaves
// nothing behind and answers a typed validation error. That ordering matters:
// a store that stored first and validated after would need a rollback to be
// honest about what a caller sees.
func (s *Store) SetConfig(ctx context.Context, key, value string) error {
	if err := s.writeRefused("SetConfig"); err != nil {
		return err
	}
	if memory, ok := strings.CutPrefix(key, memoryKeyPrefix); ok {
		return s.client.Remember(ctx, memory, value)
	}
	out := map[string]any{}
	body := map[string]any{"key": key, "value": value}
	if err := s.client.do(ctx, http.MethodPost, "/config", nil, body, &out); err != nil {
		return err
	}
	return nil
}

// GetConfig reads one setting. A key that was never set reads empty rather than
// failing: an absent setting is an ordinary answer, not an error.
func (s *Store) GetConfig(ctx context.Context, key string) (string, error) {
	if err := s.checkOpen("GetConfig"); err != nil {
		return "", err
	}
	if memory, ok := strings.CutPrefix(key, memoryKeyPrefix); ok {
		value, err := s.GetMemory(ctx, memory)
		if isNotFound(err) {
			return "", nil
		}
		return value, err
	}
	out, err := (workspaceConfigRole{s}).GetSetting(ctx, issueops.GetSettingRequest{Key: key})
	return out.Value, err
}

// GetAllConfig reads every setting in the workspace.
func (s *Store) GetAllConfig(ctx context.Context) (map[string]string, error) {
	if err := s.checkOpen("GetAllConfig"); err != nil {
		return nil, err
	}
	listed, err := (workspaceConfigRole{s}).ListSettings(ctx, issueops.ListSettingsRequest{})
	if err != nil {
		return nil, err
	}
	out := make(map[string]string, len(listed.Settings))
	for k, v := range listed.Settings {
		out[k] = v
	}
	// The memories, under the keys Beads stores them by, so an export (which
	// reads them from here) carries them.
	memories, err := s.GetMemories(ctx)
	if err != nil {
		return nil, err
	}
	for k, v := range memories {
		out[memoryKeyPrefix+k] = v
	}
	return out, nil
}

// DeleteConfig removes one setting.
//
// The normalized vocabulary projections survive on purpose, matching upstream:
// the setting and the statuses it declared are two different things, and a
// caller that just removed `status.custom` still reads the statuses it had.
func (s *Store) DeleteConfig(ctx context.Context, key string) error {
	if err := s.writeRefused("DeleteConfig"); err != nil {
		return err
	}
	if memory, ok := strings.CutPrefix(key, memoryKeyPrefix); ok {
		return s.client.Forget(ctx, memory)
	}
	return s.client.Delete(ctx, "/config/"+url.PathEscape(key))
}

// GetCustomStatuses returns the configured custom status names, alphabetically.
func (s *Store) GetCustomStatuses(ctx context.Context) ([]string, error) {
	if err := s.checkOpen("GetCustomStatuses"); err != nil {
		return nil, err
	}
	raw, err := s.client.doGet(ctx, "/config:statuses")
	if err != nil {
		return nil, err
	}
	return strList(raw["statuses"]), nil
}

// GetCustomStatusesDetailed pairs each custom status with its category, in the
// same alphabetical order as the names.
func (s *Store) GetCustomStatusesDetailed(ctx context.Context) ([]backend.CustomStatus, error) {
	if err := s.checkOpen("GetCustomStatusesDetailed"); err != nil {
		return nil, err
	}
	raw, err := s.client.doGet(ctx, "/config:statuses:detailed")
	if err != nil {
		return nil, err
	}
	items, _ := raw["statuses"].([]any)
	out := make([]backend.CustomStatus, 0, len(items))
	for _, item := range items {
		m, ok := item.(map[string]any)
		if !ok {
			continue
		}
		out = append(out, backend.CustomStatus{Name: strOf(m["name"]), Category: backend.StatusCategory(strOf(m["category"]))})
	}
	return out, nil
}

// GetCustomTypes returns the configured custom issue types, in declared order.
func (s *Store) GetCustomTypes(ctx context.Context) ([]string, error) {
	if err := s.checkOpen("GetCustomTypes"); err != nil {
		return nil, err
	}
	raw, err := s.client.doGet(ctx, "/config:types")
	if err != nil {
		return nil, err
	}
	return strList(raw["types"]), nil
}

// strList projects a wire array of strings.
func strList(v any) []string {
	items, _ := v.([]any)
	out := make([]string, 0, len(items))
	for _, item := range items {
		if s, ok := item.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

// GetInfraTypes returns the issue types that route to the wisps table.
//
// These two had no error return, so the stub generator had nowhere to put a
// refusal and emitted a panic. That is defensible in isolation and disastrous
// in practice: the conformance suite calls GetInfraTypes, so the panic aborted
// the test binary and every check after it went unmeasured — the second time in
// this suite that a single failure hid the rest of the run.
//
// The answer is the workspace's `types.infra` vocabulary, or the default
// agent/role/message set. An empty set would not degrade, it would misfile:
// rows the workspace meant to keep ephemeral get versioned like ordinary issues.
func (s *Store) GetInfraTypes(ctx context.Context) map[string]bool {
	out := map[string]bool{}
	if err := s.checkOpen("GetInfraTypes"); err != nil {
		return out
	}
	raw, err := s.client.doGet(ctx, "/config:types:infra")
	if err != nil {
		// The signature has no error return, so a failed read answers with the last
		// good answer of this process before it falls back to the defaults.
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.lastInfra != nil {
			return s.lastInfra
		}
		return defaultInfraTypes()
	}
	types, _ := raw["types"].(map[string]any)
	if len(types) == 0 {
		return defaultInfraTypes()
	}
	for name, flag := range types {
		if on, ok := flag.(bool); ok && on {
			out[name] = true
		}
	}
	if len(out) == 0 {
		return defaultInfraTypes()
	}
	s.mu.Lock()
	s.lastInfra = out
	s.mu.Unlock()
	return out
}

// IsInfraTypeCtx is GetInfraTypes for one type.
func (s *Store) IsInfraTypeCtx(ctx context.Context, issueType backend.IssueType) bool {
	return s.GetInfraTypes(ctx)[string(issueType)]
}

func defaultInfraTypes() map[string]bool {
	return map[string]bool{"agent": true, "role": true, "message": true}
}
