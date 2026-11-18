package cloudflare

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"

	"github.com/steveyegge/beads/backend"
	"github.com/steveyegge/beads/issueops"
)

// Clone-local and version-control surfaces. None of these has a remote meaning
// for a store that lives in a Worker, so each is either kept in the workspace's
// local file or answered so that the ordinary commands that call it carry on.

func (s *Store) GetMetadata(ctx context.Context, key string) (string, error) {
	return s.GetLocalMetadata(ctx, "meta:"+key)
}

func (s *Store) SetMetadata(ctx context.Context, key, value string) error {
	return s.SetLocalMetadata(ctx, "meta:"+key, value)
}

func (s *Store) GetRepoMtime(ctx context.Context, repoPath string) (int64, error) {
	v, err := s.GetLocalMetadata(ctx, "repo_mtime:"+repoPath)
	if err != nil || v == "" {
		return 0, err
	}
	n, _ := strconv.ParseInt(v, 10, 64)
	return n, nil
}

func (s *Store) SetRepoMtime(ctx context.Context, repoPath, _ string, mtimeNs int64) error {
	return s.SetLocalMetadata(ctx, "repo_mtime:"+repoPath, strconv.FormatInt(mtimeNs, 10))
}

func (s *Store) ClearRepoMtime(ctx context.Context, repoPath string) error {
	return s.SetLocalMetadata(ctx, "repo_mtime:"+repoPath, "")
}

// Commit has no working set to commit: the Worker applies every write as it is
// made. The message says so in the words the post-command auto-commit already
// treats as "nothing to do", while the error still is the typed refusal.
func (s *Store) Commit(ctx context.Context, message string) error {
	_ = message
	return fmt.Errorf("nothing to commit: the cloudflare store has no working set (%w)",
		&backend.ErrUnsupported{Op: "Commit", Backend: backendName})
}

// --------------------------------------------------------------- metadata slots

// MergeMetadata merges one key into an issue's metadata document. It is the
// metadata edit the wire patch already expresses, so it goes through the same
// route as any other update.
func (s *Store) MergeMetadata(ctx context.Context, issueID, key string, value json.RawMessage, actor string) error {
	_, err := lifecycleRole{s}.Update(ctx, issueops.UpdateRequest{
		Actor: actor, IssueID: issueID,
		Patch: issueops.IssuePatch{Metadata: issueops.MetadataPatch{Set: map[string]json.RawMessage{key: value}}},
	})
	return err
}

func (s *Store) SlotSet(ctx context.Context, issueID, key, value, actor string) error {
	encoded, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return s.MergeMetadata(ctx, issueID, key, encoded, actor)
}

func (s *Store) SlotGet(ctx context.Context, issueID, key string) (string, error) {
	issue, err := s.readIssue(ctx, issueID)
	if err != nil {
		return "", err
	}
	notSet := fmt.Errorf("slot %q is not set on %s: %w", key, issueID, backend.ErrNotFound)
	var doc map[string]json.RawMessage
	if len(issue.Metadata) == 0 {
		return "", notSet
	}
	if err := json.Unmarshal(issue.Metadata, &doc); err != nil {
		return "", fmt.Errorf("the metadata of %s is not a JSON object: %w", issueID, err)
	}
	raw, ok := doc[key]
	if !ok {
		return "", notSet
	}
	var text string
	if json.Unmarshal(raw, &text) == nil {
		return text, nil
	}
	return string(raw), nil
}

func (s *Store) SlotClear(ctx context.Context, issueID, key, actor string) error {
	_, err := lifecycleRole{s}.Update(ctx, issueops.UpdateRequest{
		Actor: actor, IssueID: issueID,
		Patch: issueops.IssuePatch{Metadata: issueops.MetadataPatch{Unset: []string{key}}},
	})
	return err
}

// SetEventsJournalEnabled accepts the workspace's journal activation. The Worker
// journals every mutation unconditionally, so there is nothing to switch: a
// workspace that sets `events-journal: true` opens normally instead of failing
// on a plumbing that "cannot journal".
func (s *Store) SetEventsJournalEnabled(bool) {}

// IsClosed reports whether Close has been called.
func (s *Store) IsClosed() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.closed
}
