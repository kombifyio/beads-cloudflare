# Compatibility between bd and the store

The store (the Worker in `src/`) and bd (upstream Beads plus the backend in `bd/`) are
released together and carry **one version**, the number in the `VERSION` file at the
repository root. `bd --version` ends in `+cloudflare.<VERSION>`, and the store reports the
same number in its context document. A person still installs them separately, at different
times, so every `bd` command checks the pair on its first request and refuses a pair that
cannot work, instead of producing a subtly wrong result later.

## What the store publishes

`GET /t/{tracker}/v0/beads/context` carries, next to the upstream members, two extension
members:

| Member | Meaning |
|---|---|
| `x_store_version` | The store's version, `MAJOR.MINOR.PATCH`. |
| `x_min_client_version` | The oldest bd (backend) version this store still serves, `MAJOR.MINOR.0`. |

and the existing `capabilities` list.

## What bd requires

On connect (the first request of a process; the verdict is kept for the process) bd reads
that document and applies these rules, in order. Any failure stops every command at once
with **one line** that names both versions and the exact command that fixes it.

1. **The store is not older than the oldest store this bd supports.** Each bd declares a
   minimum store version (`MinStoreVersion` in `bd/cloudflare/compat.go`). A store that
   reports no version predates versions and counts as older than every minimum. Fix: update
   the store, `npx --yes github:kombifyio/beads-cloudflare#v<bd version> setup`.
2. **The store advertises every capability this bd needs.** The list of required tokens
   (`requiredCapabilities` in the same file) covers the everyday commands; optional
   extensions such as the bulk export routes or import merge are checked where they are
   used. Fix: the same store update.
3. **bd is not older than the store's `x_min_client_version`.** Fix: update bd,
   `npx --yes github:kombifyio/beads-cloudflare#v<store version> join <store url>`.

Everything else is fine. In particular a store that is merely **newer** is fine: a newer
patch, a newer minor, even a newer major, as long as it still advertises the capabilities
this bd needs and does not raise `x_min_client_version` above this bd.

**A handshake that cannot be completed never lets a command through.** Network errors, `429` and `5xx`
answers are retried with backoff; if the context still cannot be read, the command fails before it
sends its operation (reads and writes alike) with one line saying that the store could not be reached
for the version check. The failure is not remembered, so the next command tries again.

A bd that was not built from this repository's `VERSION` (a development build, `go test`)
is not stamped and skips rules 1 and 3; the capability rule is applied by the code that
needs the capability.

## What the store promises

So that upgrading a store never breaks an installed bd of the same minor line:

- `x_min_client_version` changes only in a **minor or major** release, never in a patch
  release, and is never above that release's own `MAJOR.MINOR.0`. A bd `0.1.x` therefore
  works with every store `0.1.y`, whichever of the two is newer.
- The capability list only grows within a major version. A capability a released bd
  requires is never removed.
- A store never raises `x_min_client_version` above the version of the newest bd that has
  been released.

A minor release that really needs a newer bd says so by raising the floor; bd users then get
the update line above instead of failing in some later request.

## Maintaining the numbers

- Canonical release preparation updates `VERSION` and its projections in `src/version.ts` and
  `package.json`; `pnpm version:sync --check` verifies they match without changing them.
- `MIN_CLIENT_VERSION` in `src/tracker/context.ts` and `MinStoreVersion` in
  `bd/cloudflare/compat.go` are edited by hand, and only under the promises above.
- The pair proof (`scripts/pair-proof.sh`) fails when the built bd's stamp or the running
  store's `x_store_version` differ from `VERSION`.

## The setup tool

`npx --yes beads-cloudflare doctor` checks the actual first `bd` on PATH,
reads authenticated tracker context and runs `bd --readonly ready --json`. The binary
performs its full compatibility handshake, including required capabilities; a failed
read fails readiness. Default doctor does not write tracker records. `--scratch`
explicitly opts into a create, read, close and delete round trip with a credential
authorized for scratch trackers. See [`SETUP.md`](../SETUP.md).

## Compatibility with upstream Beads

This project builds on a pinned upstream release; it does not fork upstream.

| | Version |
|---|---|
| Upstream Beads | `v1.3.4` (`bd/go.mod`, [`spec/upstream/SOURCE.md`](../spec/upstream/SOURCE.md) with its commit) |
| This project (store, backend, setup tool) | the `VERSION` file; `bd --version` prints `<upstream>+cloudflare.<VERSION>` |

**What the `bd` binary is.** `scripts/build-bd.sh` checks out upstream at the pinned tag and commit, leaves its source
unchanged, adds one blank import of this repository's Go module (`bd/`) to register the `cloudflare` backend, applies
the declared dependency overlay of `spec/upstream/build-overlay.json` and builds the CGO-free flavour upstream ships
(`-tags gms_pure_go`). Every `bd` command keeps its upstream behaviour; the backend decides only where the data lives.
The store implements upstream's `bd serve` `/v0` HTTP contract as a declared [profile](profile.md); the contract file
is vendored unchanged.

**What the profile does not implement.** The backend refuses, with an error that names the reason, what has no
meaning against a remote store or no route in the profile: the version-control and sync surfaces of Dolt (44
methods: history, branches, remotes, push and pull, federation, compaction, fast statistics), 21 methods outside `/v0` (merge slots, molecule progress, wisp listing and promotion, provenance events,
bulk delete variants, dependent counts by status, re-keying an issue id, so `bd rename`), and `bd import` against a
store without merge import. [bd-backend.md](bd-backend.md#what-is-refused-and-why) lists every refusal.

**Known differences you will see.**

- `bd doctor` reports `Database: No dolt database found`. Upstream's doctor opens a Dolt store for that check whatever
  backend the workspace selects, so it cannot see this one; the rest of its report is real. Use the setup tool's
  `doctor` (`npx --yes beads-cloudflare doctor`, above) to check a workspace that uses this backend. A fix
  is proposed upstream ([upstream proposals](upstream-proposals.md)).
- A tracker is one Beads project with one issue prefix. `bd create --parent <id>` with a parent from another prefix
  (another tracker) is refused before anything is created: a parent must be an issue of the same tracker. Dependencies
  on other prefixes and `external:` references are kept, as upstream keeps them, but never block.
- Closing an issue that still has open `parent-child` children is refused (`409 not_closable`, member
  `open_children`), as upstream refuses it; a forced close (`force`) closes it anyway. Parents and epics are never closed
  automatically. This is upstream's rule, kept on purpose, not a missing feature.

[semantics.md](semantics.md) states every upstream rule the store reproduces, with its upstream source location.
