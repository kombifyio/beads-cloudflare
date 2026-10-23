# Proposals for upstream Beads

Three small changes to [gastownhall/beads](https://github.com/gastownhall/beads) that
would let this backend, and any other out-of-tree backend, behave like an in-tree
one. They are prepared here and **not submitted**; each patch is against the
`v1.3.1` tag, builds and vets there, and is deliberately the smallest change that
does the job. Line numbers are from `v1.3.1`.

## 1. Export a reader for the lease TTL

**Problem.** A claim or heartbeat can carry a lease duration in its context.
`issueops.WithLeaseTTL` writes it under an unexported key
(`internal/storage/issueops/lease.go:28-35`) and `leaseTTL` reads it
(`lease.go:37-43`); an exported wrapper `issueops.LeaseTTL` exists
(`lease.go:121-125`) but sits in an `internal/` package. The conformance suite sets
the value (`backend/conformance/claim.go:131`, a heartbeat with a one-hour TTL and an
assertion that the lease reaches well into the future), so a backend with a claim
path of its own cannot pass that check: it has no way to learn the TTL the caller
asked for and can only apply a default. This backend fails `HeartbeatRenewsLease`
for exactly this reason.

**Change.** Re-export the reader from the public `backend` package, next to the other
thin wrappers (`backend/backend.go:167-171`). It adds no behavior; the internal
package stays the single source of truth, as the `backend` package header says.

```diff
diff --git a/backend/backend.go b/backend/backend.go
index de2f184..e1af27e 100644
--- a/backend/backend.go
+++ b/backend/backend.go
@@ -64,9 +64,11 @@ package backend
 
 import (
 	"context"
+	"time"
 
 	"github.com/steveyegge/beads/internal/storage"
 	"github.com/steveyegge/beads/internal/storage/backends"
+	"github.com/steveyegge/beads/internal/storage/issueops"
 )
 
 // DoltStorage is the full engine interface an external backend implements:
@@ -171,6 +173,14 @@ func WorkspaceIsBeadsDir(name string) bool {
 	return backends.WorkspaceIsBeadsDir(name)
 }
 
+// LeaseTTL reports the lease duration that a claim or heartbeat issued with ctx
+// should grant: the value set with issueops.WithLeaseTTL, or the default when none
+// is set. A backend with a claim path of its own reads it here instead of
+// hard-coding the default, so a caller-supplied TTL is honoured.
+func LeaseTTL(ctx context.Context) time.Duration {
+	return issueops.LeaseTTL(ctx)
+}
+
 // Iter is the streaming-read cursor returned by the Iter* methods.
 type Iter[T any] = storage.Iter[T]
```

**Why it is safe.** One new exported function that forwards to an existing one. No
interface changes, so no in-tree or out-of-tree implementation is affected.

## 2. Let `bd doctor` read the registered backend's store

**Problem.** `bd doctor` opens a concrete Dolt store for its database check no matter
which backend the workspace selects. `CheckDatabaseVersionWithStore`
(`cmd/bd/doctor/database.go:93-126`) takes a `*SharedStore`, and `NewSharedStore`
(`cmd/bd/doctor/shared_store.go:51-66`) builds it with
`dolt.NewFromConfigWithOptions`. For a workspace with `"backend": "cloudflare"` there
is no `.beads/dolt`, so the check reports `Database: No dolt database found` as an
error and `bd doctor` exits non-zero on a healthy workspace. The version check needs
exactly one method, `GetLocalMetadata`, which every backend implements through
`DoltStorage`.

**Change.** When the workspace's configured backend is a registered one (the name
`dolt` is reserved and never registered, `internal/storage/backends/backends.go:56`),
open it through the registry, as every other command does (`cmd/bd/main.go:1853`),
and run the same version comparison against it. The shared check takes a one-method
interface instead of `*dolt.DoltStore`, and a label for the `Storage:` line.

```diff
diff --git a/cmd/bd/doctor/database.go b/cmd/bd/doctor/database.go
index 97b0c8f..2eaec3e 100644
--- a/cmd/bd/doctor/database.go
+++ b/cmd/bd/doctor/database.go
@@ -10,6 +10,7 @@ import (
 	"github.com/steveyegge/beads/cmd/bd/doctor/fix"
 	"github.com/steveyegge/beads/internal/configfile"
 	"github.com/steveyegge/beads/internal/doltserver"
+	"github.com/steveyegge/beads/internal/storage/backends"
 	"github.com/steveyegge/beads/internal/storage/dolt"
 	"gopkg.in/yaml.v3"
 )
@@ -86,12 +87,19 @@ func CheckDatabaseVersion(path string, cliVersion string) DoctorCheck {
 	}
 	defer func() { _ = store.Close() }()
 
-	return checkDatabaseVersionWithStore(store, cliVersion)
+	return checkDatabaseVersionWithStore(store, cliVersion, "Dolt")
 }
 
 // CheckDatabaseVersionWithStore checks the database version using a shared store (GH#2636).
 func CheckDatabaseVersionWithStore(ss *SharedStore, cliVersion string) DoctorCheck {
 	beadsDir := sharedStoreBeadsDir(ss)
+	// A workspace that selects a registered out-of-tree backend has no local Dolt
+	// database to look for; read the version through the backend's own store.
+	if cfg, err := configfile.Load(beadsDir); err == nil && cfg != nil {
+		if b, ok := backends.Lookup(cfg.GetBackend()); ok {
+			return checkRegisteredBackendVersion(b, cfg.GetBackend(), beadsDir, cliVersion)
+		}
+	}
 	store := ss.Store()
 	if store == nil {
 		if !sharedStoreNeedsLocalDoltDir(beadsDir) {
@@ -122,10 +130,33 @@ func CheckDatabaseVersionWithStore(ss *SharedStore, cliVersion string) DoctorChe
 			Fix:     "Run 'bd doctor --fix' to attempt repair. Check 'bd dolt status' for server configuration issues",
 		}
 	}
-	return checkDatabaseVersionWithStore(store, cliVersion)
+	return checkDatabaseVersionWithStore(store, cliVersion, "Dolt")
+}
+
+// checkRegisteredBackendVersion is the version check for a workspace whose backend
+// was registered with backends.Register.
+func checkRegisteredBackendVersion(b backends.Backend, name, beadsDir, cliVersion string) DoctorCheck {
+	store, err := b.OpenReadOnly(context.Background(), beadsDir)
+	if err != nil {
+		return DoctorCheck{
+			Name:    "Database",
+			Status:  StatusError,
+			Message: "Unable to open database",
+			Detail:  fmt.Sprintf("Storage: %s\n\nError: %v", name, err),
+			Fix:     "Check the backend configuration and credentials in " + beadsDir,
+		}
+	}
+	defer func() { _ = store.Close() }()
+	return checkDatabaseVersionWithStore(store, cliVersion, name)
+}
+
+// localMetadataReader is the one method the version check needs, so any store can
+// answer it, not only the Dolt one.
+type localMetadataReader interface {
+	GetLocalMetadata(ctx context.Context, key string) (string, error)
 }
 
-func checkDatabaseVersionWithStore(store *dolt.DoltStore, cliVersion string) DoctorCheck {
+func checkDatabaseVersionWithStore(store localMetadataReader, cliVersion, storageName string) DoctorCheck {
 	ctx := context.Background()
 	dbVersion, err := store.GetLocalMetadata(ctx, "bd_version")
 	if err != nil {
@@ -133,7 +164,7 @@ func checkDatabaseVersionWithStore(store *dolt.DoltStore, cliVersion string) Doc
 			Name:    "Database",
 			Status:  StatusError,
 			Message: "Unable to read database version",
-			Detail:  fmt.Sprintf("Storage: Dolt\n\nError: %v", err),
+			Detail:  fmt.Sprintf("Storage: %s\n\nError: %v", storageName, err),
 			Fix:     "Database may be corrupted. Run 'bd doctor --fix' to recover",
 		}
 	}
@@ -144,7 +175,7 @@ func checkDatabaseVersionWithStore(store *dolt.DoltStore, cliVersion string) Doc
 			Name:    "Database",
 			Status:  StatusOK,
 			Message: "bd_version not yet stamped (will self-heal on next startup)",
-			Detail:  "Storage: Dolt",
+			Detail:  "Storage: " + storageName,
 		}
 	}
 
@@ -153,7 +184,7 @@ func checkDatabaseVersionWithStore(store *dolt.DoltStore, cliVersion string) Doc
 			Name:    "Database",
 			Status:  StatusWarning,
 			Message: fmt.Sprintf("version %s (CLI: %s)", dbVersion, cliVersion),
-			Detail:  "Storage: Dolt",
+			Detail:  "Storage: " + storageName,
 			Fix:     "Update bd CLI and re-run (dolt metadata will be updated automatically)",
 		}
 	}
@@ -162,7 +193,7 @@ func checkDatabaseVersionWithStore(store *dolt.DoltStore, cliVersion string) Doc
 		Name:    "Database",
 		Status:  StatusOK,
 		Message: fmt.Sprintf("version %s", dbVersion),
-		Detail:  "Storage: Dolt",
+		Detail:  "Storage: " + storageName,
 	}
 }
```

**Scope.** This covers the database-version check, which is the one that fails on a
healthy workspace. The remaining Dolt-specific checks keep their current behavior; a
follow-up could skip them for registered backends, which this patch does not attempt.
Built into `bd` with this backend and run on a workspace that uses it, `bd doctor` goes
from 2 errors to 1 (the `Database` error is gone); a `Project Identity` warning, which
needs a Dolt store too, appears in its place.
A second error that `bd doctor` shows, `bd prime Command`
(`cmd/bd/doctor/claude.go:287-298`), is unrelated: the probe runs `bd prime` from
`PATH` and fails when no `bd` is installed there.

## 3. Export the row-cap error

**Problem.** A read with `MaxRows` answers `*ErrTooManyRows` when the cap fires
(`internal/storage/issueops/errors.go:51`), and the conformance suite requires that exact
type (`backend/conformance/reader_contract.go:888-900`). The type sits in an `internal/`
package, so an out-of-tree backend can enforce the cap but cannot return an error a caller
can classify with `errors.As`. This backend fails `SearchPaging` for exactly this reason.

**Change.** A type alias in the public `backend` package, next to `Iter`.

```diff
diff --git a/backend/backend.go b/backend/backend.go
index de2f184..6ee5753 100644
--- a/backend/backend.go
+++ b/backend/backend.go
@@ -67,6 +67,7 @@ import (
 
 	"github.com/steveyegge/beads/internal/storage"
 	"github.com/steveyegge/beads/internal/storage/backends"
+	"github.com/steveyegge/beads/internal/storage/issueops"
 )
 
 // DoltStorage is the full engine interface an external backend implements:
@@ -171,6 +172,11 @@ func WorkspaceIsBeadsDir(name string) bool {
 	return backends.WorkspaceIsBeadsDir(name)
 }
 
+// ErrTooManyRows is the error a read answers when its MaxRows cap fires. A
+// backend with a read path of its own returns it so callers can classify the
+// cap with errors.As, as they do for the in-tree engine.
+type ErrTooManyRows = issueops.ErrTooManyRows
+
 // Iter is the streaming-read cursor returned by the Iter* methods.
 type Iter[T any] = storage.Iter[T]
 
```

**Why it is safe.** An alias names the same type, so every existing `errors.As` against the
internal type keeps matching. Built and vetted at `v1.3.1` (`go build ./backend && go vet
./backend`). Patches 1 and 3 both add the `issueops` import; applied together it appears once.

## Note to the maintainers

A draft, to be sent when the maintainers of this backend decide to. Not sent.

> Subject: An out-of-tree Cloudflare storage backend for bd
>
> Hello,
>
> We built a storage backend for bd that keeps a tracker in a Cloudflare Worker, on
> top of the `backend` package and its conformance suite. It is registered by name
> with one blank import, so a bd build is upstream v1.3.1 plus that import and no
> patches. It is MIT licensed and pre-1.0, in one repository with the server it
> talks to (which serves the `bd serve` `/v0` contract), the client being the `bd/`
> Go module:
> https://github.com/kombifyio/beads-cloudflare
>
> Against the v1.3.1 conformance suite it passes the unsupported contract and 52 of
> 60 checks on the portable surface. Of the eight that fail, two come from what the
> public package does not expose: the lease TTL context value and the typed error for
> the row cap. We have written patches in case they are useful: one exporting a reader
> for the lease TTL, one exporting the row-cap error, and one letting `bd doctor` open the
> registered backend's store for its version check. They are small and sit in `docs/upstream-proposals.md` in the
> repository. We have not opened pull requests and will only do so if you want them.
>
> We track upstream releases and re-run the suite on every bump. Thank you for
> making the interface public. Please tell us if anything about how we use it is
> wrong.
