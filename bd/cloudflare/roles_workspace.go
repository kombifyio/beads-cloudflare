package cloudflare

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/steveyegge/beads/backend"
	"github.com/steveyegge/beads/issueops"
	"github.com/steveyegge/beads/memoryops"
)

// The workspace roles: settings, memories, identity and version markers.

func (s *Store) WorkspaceConfig() (issueops.WorkspaceConfig, error) {
	return workspaceConfigRole{s}, s.checkOpen("WorkspaceConfig")
}
func (s *Store) Memories() (memoryops.Memories, error) {
	return memoriesRole{s}, s.checkOpen("Memories")
}
func (s *Store) InitVerifier() (issueops.InitVerifier, error) {
	return initVerifierRole{s}, s.checkOpen("InitVerifier")
}
func (s *Store) VersionReconciler() (issueops.VersionReconciler, error) {
	return versionRole{s}, s.checkOpen("VersionReconciler")
}

// -------------------------------------------------------------------- settings

type workspaceConfigRole struct{ s *Store }

func settingPath(key string) string { return "/config/" + url.PathEscape(key) }

// noSuchRoute reports the Worker's answer for a path it does not serve, which is
// how a deployment that predates the spec's settings plane answers a PUT.
func noSuchRoute(err error) bool {
	var p *Problem
	return errors.As(err, &p) && p.Status == 404 && strings.Contains(p.Detail, "no such route")
}

func (r workspaceConfigRole) GetSetting(ctx context.Context, req issueops.GetSettingRequest) (issueops.SettingResult, error) {
	var out struct {
		Key      string  `json:"key"`
		Value    *string `json:"value"`
		Redacted bool    `json:"redacted"`
	}
	if err := r.s.client.do(ctx, http.MethodGet, settingPath(req.Key), nil, nil, &out); err != nil {
		return issueops.SettingResult{}, err
	}
	if out.Redacted {
		// The server holds the value back; an empty answer would read as unset.
		return issueops.SettingResult{}, unsupportedField("GetSetting", "the value of "+req.Key+" is redacted by the server")
	}
	return issueops.SettingResult{Key: req.Key, Value: str(out.Value)}, nil
}

func (r workspaceConfigRole) ListSettings(ctx context.Context, _ issueops.ListSettingsRequest) (issueops.ListSettingsResult, error) {
	var out struct {
		Items json.RawMessage `json:"items"`
	}
	if err := r.s.client.do(ctx, http.MethodGet, "/config", nil, nil, &out); err != nil {
		return issueops.ListSettingsResult{}, err
	}
	settings := map[string]string{}
	var rows []struct {
		Key      string  `json:"key"`
		Value    *string `json:"value"`
		Redacted bool    `json:"redacted"`
	}
	if err := json.Unmarshal(out.Items, &rows); err == nil {
		for _, row := range rows {
			if !row.Redacted {
				settings[row.Key] = str(row.Value)
			}
		}
		return issueops.ListSettingsResult{Settings: settings}, nil
	}
	// A deployment that predates the spec's plane answers a key/value object.
	var legacy map[string]string
	if err := json.Unmarshal(out.Items, &legacy); err != nil {
		return issueops.ListSettingsResult{}, fmt.Errorf("the settings list is in neither known shape: %w", err)
	}
	return issueops.ListSettingsResult{Settings: legacy}, nil
}

func (r workspaceConfigRole) SetSetting(ctx context.Context, req issueops.SetSettingRequest) (issueops.SetSettingResult, error) {
	if err := r.s.writeRefused("WorkspaceConfig.SetSetting"); err != nil {
		return issueops.SetSettingResult{}, err
	}
	err := r.s.client.do(ctx, http.MethodPut, settingPath(req.Key), nil, map[string]string{"value": req.Value}, nil)
	if noSuchRoute(err) {
		err = r.s.client.do(ctx, http.MethodPost, "/config", nil, map[string]string{"key": req.Key, "value": req.Value}, nil)
	}
	if err != nil {
		return issueops.SetSettingResult{}, err
	}
	return issueops.SetSettingResult{Key: req.Key, Value: req.Value}, nil
}

func (r workspaceConfigRole) UnsetSetting(ctx context.Context, req issueops.UnsetSettingRequest) (issueops.UnsetSettingResult, error) {
	if err := r.s.writeRefused("WorkspaceConfig.UnsetSetting"); err != nil {
		return issueops.UnsetSettingResult{}, err
	}
	if err := r.s.client.do(ctx, http.MethodDelete, settingPath(req.Key), nil, nil, nil); err != nil {
		return issueops.UnsetSettingResult{}, err
	}
	return issueops.UnsetSettingResult{Key: req.Key}, nil
}

// -------------------------------------------------------------------- memories

type memoriesRole struct{ s *Store }

func (r memoriesRole) Remember(ctx context.Context, req memoryops.RememberRequest) (memoryops.RememberResult, error) {
	if err := r.s.writeRefused("Memories.Remember"); err != nil {
		return memoryops.RememberResult{}, err
	}
	body := map[string]any{"content": req.Content}
	if req.Key != "" {
		body["key"] = req.Key
	}
	var out struct {
		Key      string `json:"key"`
		Value    string `json:"value"`
		Replaced bool   `json:"replaced"`
	}
	if err := r.s.client.do(ctx, http.MethodPost, "/memories", nil, body, &out); err != nil {
		return memoryops.RememberResult{}, err
	}
	return memoryops.RememberResult{Key: out.Key, Value: out.Value, Replaced: out.Replaced}, nil
}

func (r memoriesRole) Recall(ctx context.Context, req memoryops.RecallRequest) (memoryops.RecallResult, error) {
	var out struct {
		Value string `json:"value"`
	}
	err := r.s.client.do(ctx, http.MethodGet, "/memories/"+url.PathEscape(req.Key), nil, nil, &out)
	if isNotFound(err) {
		return memoryops.RecallResult{Key: req.Key}, nil
	}
	if err != nil {
		return memoryops.RecallResult{}, err
	}
	return memoryops.RecallResult{Key: req.Key, Value: out.Value, Found: true}, nil
}

func (r memoriesRole) Forget(ctx context.Context, req memoryops.ForgetRequest) (memoryops.ForgetResult, error) {
	if err := r.s.writeRefused("Memories.Forget"); err != nil {
		return memoryops.ForgetResult{}, err
	}
	var out struct {
		Value string `json:"value"`
	}
	err := r.s.client.do(ctx, http.MethodDelete, "/memories/"+url.PathEscape(req.Key), nil, nil, &out)
	if isNotFound(err) {
		return memoryops.ForgetResult{Key: req.Key}, nil
	}
	if err != nil {
		return memoryops.ForgetResult{}, err
	}
	return memoryops.ForgetResult{Key: req.Key, Value: out.Value, Found: true}, nil
}

func (r memoriesRole) List(ctx context.Context, req memoryops.ListRequest) (memoryops.ListResult, error) {
	var out struct {
		Items []struct {
			Key   string `json:"key"`
			Value string `json:"value"`
		} `json:"items"`
	}
	q := newQuery().str("search", req.Search)
	if err := r.s.client.do(ctx, http.MethodGet, "/memories", q.values(), nil, &out); err != nil {
		return memoryops.ListResult{}, err
	}
	memories := make(map[string]string, len(out.Items))
	for _, m := range out.Items {
		memories[m.Key] = m.Value
	}
	return memoryops.ListResult{Memories: memories}, nil
}

// -------------------------------------------------------------------- identity

type initVerifierRole struct{ s *Store }

// VerifyIdentity reads the workspace identity the server publishes: the tracker
// is the project, and the issue prefix is the stored setting when there is one.
func (r initVerifierRole) VerifyIdentity(ctx context.Context, _ issueops.VerifyIdentityRequest) (issueops.VerifyIdentityResult, error) {
	var info struct {
		ProjectID string `json:"project_id"`
	}
	if err := r.s.client.do(ctx, http.MethodGet, "/context", nil, nil, &info); err != nil {
		return issueops.VerifyIdentityResult{}, err
	}
	prefix, err := (workspaceConfigRole{r.s}).GetSetting(ctx, issueops.GetSettingRequest{Key: issueops.SettingKeyIssuePrefix})
	if err != nil {
		return issueops.VerifyIdentityResult{}, err
	}
	return issueops.VerifyIdentityResult{Prefix: prefix.Value, ProjectID: info.ProjectID}, nil
}

// ------------------------------------------------------------- version markers

type versionRole struct{ s *Store }

const (
	versionKey   = "bd_version"
	highWaterKey = "bd_version_high_water"
)

func (r versionRole) RecordedVersion(ctx context.Context, _ issueops.RecordedVersionRequest) (issueops.RecordedVersionResult, error) {
	recorded, err := r.s.GetLocalMetadata(ctx, versionKey)
	if err != nil {
		return issueops.RecordedVersionResult{}, err
	}
	high, err := r.s.GetLocalMetadata(ctx, highWaterKey)
	if err != nil {
		return issueops.RecordedVersionResult{}, err
	}
	return issueops.RecordedVersionResult{Recorded: recorded, HighWaterMark: high}, nil
}

func (r versionRole) ReconcileVersion(ctx context.Context, req issueops.VersionReconcileRequest) (issueops.VersionReconcileResult, error) {
	if strings.TrimSpace(req.CLIVersion) == "" {
		return issueops.VersionReconcileResult{}, backend.ErrValidation
	}
	state, err := r.RecordedVersion(ctx, issueops.RecordedVersionRequest{})
	if err != nil {
		return issueops.VersionReconcileResult{}, err
	}
	result := issueops.VersionReconcileResult{Previous: state.Recorded, Current: state.Recorded}
	if state.Recorded == req.CLIVersion {
		return result, nil
	}
	if (state.Recorded != "" && compareDotted(req.CLIVersion, state.Recorded) < 0) ||
		(state.HighWaterMark != "" && compareDotted(req.CLIVersion, state.HighWaterMark) < 0) {
		result.Downgrade = true
		return result, nil
	}
	if err := r.s.SetLocalMetadata(ctx, versionKey, req.CLIVersion); err != nil {
		return issueops.VersionReconcileResult{}, err
	}
	if state.HighWaterMark == "" || compareDotted(req.CLIVersion, state.HighWaterMark) > 0 {
		if err := r.s.SetLocalMetadata(ctx, highWaterKey, req.CLIVersion); err != nil {
			return issueops.VersionReconcileResult{}, err
		}
	}
	result.Current = req.CLIVersion
	result.Migrated = true
	return result, nil
}

// compareDotted compares dotted decimal versions component by component, a
// non-numeric component reading as zero: the comparison the role documents.
func compareDotted(a, b string) int {
	pa, pb := strings.Split(strings.TrimPrefix(a, "v"), "."), strings.Split(strings.TrimPrefix(b, "v"), ".")
	for i := 0; i < len(pa) || i < len(pb); i++ {
		var x, y int
		if i < len(pa) {
			x = leadingInt(pa[i])
		}
		if i < len(pb) {
			y = leadingInt(pb[i])
		}
		switch {
		case x < y:
			return -1
		case x > y:
			return 1
		}
	}
	return 0
}

func leadingInt(s string) int {
	end := 0
	for end < len(s) && s[end] >= '0' && s[end] <= '9' {
		end++
	}
	n, _ := strconv.Atoi(s[:end])
	return n
}
