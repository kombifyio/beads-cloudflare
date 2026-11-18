package cloudflare

import (
	"context"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync"
)

// Version is the version of this backend: the contents of the VERSION file at the
// repository root, stamped by scripts/build-bd.sh. A build that was not stamped
// (go test, go run) is a development build and skips the connect check below.
var Version = devVersion

const devVersion = "0.0.0-dev"

// MinStoreVersion is the oldest store this backend works with. It moves only when a
// release of this backend starts to rely on something older stores do not do, and
// it never moves above that release's own MAJOR.MINOR.0 (docs/compatibility.md).
const MinStoreVersion = "0.1.0"

// requiredCapabilities are the capability tokens every command of this backend
// relies on. A store that lacks one cannot carry the everyday commands faithfully.
// Everything else (the bulk export routes, import merge, x_extra) is optional here:
// it is checked where it is used and refused or worked around there.
var requiredCapabilities = []string{
	"profile.beads-cloudflare",
	"profile.idempotency_key",
	"issues.batchApply",
	"issues.close",
	"issues.create",
	"issues.get",
	"issues.list",
	"issues.update",
	"ready.list",
}

// setupPackage is the public repository the setup CLI runs from.
const setupPackage = "github:kombifyio/beads-cloudflare"

// npxCommand is the command that moves either side to a matching version. Pinning the
// tag makes it deterministic: npx does not reuse an older cached checkout for a
// different tag.
func npxCommand(version, command string) string {
	spec := setupPackage
	if v := parseVersion(version); v.ok {
		spec += "#v" + v.String()
	}
	return "npx --yes " + spec + " " + command
}

// storeContext is the part of the store's context document the connect check reads.
type storeContext struct {
	StoreVersion string   `json:"x_store_version"`
	MinClient    string   `json:"x_min_client_version"`
	Capabilities []string `json:"capabilities"`
}

type semver struct {
	major, minor, patch int
	ok                  bool
}

func (v semver) String() string { return fmt.Sprintf("%d.%d.%d", v.major, v.minor, v.patch) }

func (v semver) less(o semver) bool {
	if v.major != o.major {
		return v.major < o.major
	}
	if v.minor != o.minor {
		return v.minor < o.minor
	}
	return v.patch < o.patch
}

// parseVersion reads MAJOR.MINOR.PATCH, ignoring a leading v and any pre-release or
// build suffix.
func parseVersion(s string) semver {
	s = strings.TrimPrefix(strings.TrimSpace(s), "v")
	if i := strings.IndexAny(s, "-+"); i >= 0 {
		s = s[:i]
	}
	parts := strings.Split(s, ".")
	if len(parts) != 3 {
		return semver{}
	}
	var n [3]int
	for i, p := range parts {
		v, err := strconv.Atoi(p)
		if err != nil || v < 0 {
			return semver{}
		}
		n[i] = v
	}
	return semver{n[0], n[1], n[2], true}
}

// checkCompatible applies the rule in docs/compatibility.md to one store. It returns
// nil when the store is usable and otherwise ONE line that names both versions and
// the command that fixes it.
func checkCompatible(base, clientVersion string, doc storeContext) error {
	if clientVersion == devVersion {
		return nil
	}
	client := parseVersion(clientVersion)
	if !client.ok {
		return nil
	}
	store := parseVersion(doc.StoreVersion)
	storeLabel := doc.StoreVersion
	if !store.ok {
		store = semver{ok: true}
		storeLabel = "unknown (it reports no version, so it predates 0.1.0)"
	}
	head := fmt.Sprintf("beads-cloudflare: this bd is %s and the store %s is %s", client, base, storeLabel)

	if floor := parseVersion(MinStoreVersion); store.less(floor) {
		return fmt.Errorf("%s, but this bd needs a store of at least %s; update the store with: %s", head, floor, npxCommand(client.String(), "setup"))
	}
	have := make(map[string]bool, len(doc.Capabilities))
	for _, c := range doc.Capabilities {
		have[c] = true
	}
	for _, need := range requiredCapabilities {
		if !have[need] {
			return fmt.Errorf("%s, and it lacks the capability %q this bd requires; update the store with: %s", head, need, npxCommand(client.String(), "setup"))
		}
	}
	if min := parseVersion(doc.MinClient); min.ok && client.less(min) {
		return fmt.Errorf("%s, and the store requires a bd of at least %s; update bd with: %s", head, min, npxCommand(store.String(), "join "+base))
	}
	return nil
}

// connectCheck runs the compatibility check once per process.
type connectCheck struct {
	mu   sync.Mutex
	done bool
	err  error
}

// ensureCompatible reads the store's context on the first request of the process and
// compares versions. The verdict, good or bad, is kept for the life of the process,
// so every command of a mismatched pair fails at once with the same line.
//
// A handshake that cannot be completed never lets the request through: a store whose
// version is unknown may be one this bd must not write to. Failures that can pass (a
// network error, a 5xx, a 429) are retried with the transport's backoff; if the
// handshake still fails, the command fails before it sends its operation, with one
// line saying that the store could not be checked. The failure is not remembered, so
// the next request tries the handshake again.
func (c *Client) ensureCompatible(ctx context.Context) error {
	c.connect.mu.Lock()
	defer c.connect.mu.Unlock()
	if c.connect.done {
		return c.connect.err
	}
	if Version == devVersion {
		c.connect.done = true
		return nil
	}
	var doc storeContext
	var last error
	for attempt := 0; attempt < maxAttempts; attempt++ {
		if attempt > 0 {
			if err := sleepBackoff(ctx, attempt, last); err != nil {
				break
			}
		}
		retry, err := c.once(ctx, http.MethodGet, "/context", nil, nil, "", "", &doc)
		if err == nil {
			c.connect.done = true
			c.connect.err = checkCompatible(c.base, Version, doc)
			return c.connect.err
		}
		last = err
		if !retry {
			break
		}
	}
	reason := strings.Join(strings.Fields(fmt.Sprint(last)), " ")
	return fmt.Errorf("beads-cloudflare: the store %s (tracker %s) could not be reached for the version check, so nothing was sent: %s", c.base, c.tracker, reason)
}
