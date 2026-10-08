package cloudflare

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

// localMetaFile is the clone-local metadata plane: tip timestamps, the version
// markers and tracker sync cursors. In the Dolt backends it is a dolt-ignored
// table; for a store that lives in a Worker it has no remote meaning at all, so
// it is a small JSON file in the workspace .beads directory. Absence is the
// normal answer ("", nil), exactly as the interface documents.
const localMetaFile = "cloudflare-local.json"

type localMeta struct {
	mu   sync.Mutex
	path string
}

func newLocalMeta(beadsDir string) *localMeta {
	if beadsDir == "" {
		return &localMeta{}
	}
	return &localMeta{path: filepath.Join(beadsDir, localMetaFile)}
}

func (l *localMeta) read() (map[string]string, error) {
	out := map[string]string{}
	if l.path == "" {
		return out, nil
	}
	raw, err := os.ReadFile(l.path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return out, nil
		}
		return nil, err
	}
	if len(raw) == 0 {
		return out, nil
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		// Starting over would also forget the version high-water mark, which is what
		// stops a downgraded bd from writing. Say so and let the owner decide.
		return nil, fmt.Errorf("%s is not valid JSON (%v); delete it to start over, which also resets the recorded bd version", l.path, err)
	}
	return out, nil
}

func (l *localMeta) get(key string) (string, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	values, err := l.read()
	if err != nil {
		return "", err
	}
	return values[key], nil
}

func (l *localMeta) set(key, value string) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.path == "" {
		return nil
	}
	values, err := l.read()
	if err != nil {
		return err
	}
	if values[key] == value {
		return nil
	}
	values[key] = value
	encoded, err := json.MarshalIndent(values, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(l.path), 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(l.path), localMetaFile+".*")
	if err != nil {
		return err
	}
	if _, err := tmp.Write(append(encoded, '\n')); err != nil {
		_ = tmp.Close()
		_ = os.Remove(tmp.Name())
		return err
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmp.Name())
		return err
	}
	return os.Rename(tmp.Name(), l.path)
}

// SetWorkspace tells the store which .beads directory it serves, which is where
// the clone-local metadata file lives. A store opened without one keeps no local
// state: every read answers "" and every write succeeds.
func (s *Store) SetWorkspace(beadsDir string) {
	s.local = newLocalMeta(beadsDir)
}

func (s *Store) SetLocalMetadata(ctx context.Context, key, value string) error {
	if err := s.checkOpen("SetLocalMetadata"); err != nil {
		return err
	}
	return s.localMeta().set(key, value)
}

func (s *Store) GetLocalMetadata(ctx context.Context, key string) (string, error) {
	if err := s.checkOpen("GetLocalMetadata"); err != nil {
		return "", err
	}
	return s.localMeta().get(key)
}

func (s *Store) localMeta() *localMeta {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.local == nil {
		s.local = newLocalMeta("")
	}
	return s.local
}
