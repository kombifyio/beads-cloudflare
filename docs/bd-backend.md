# The bd backend

A [Beads](https://github.com/gastownhall/beads) storage backend that keeps a tracker in a Cloudflare Worker
instead of a Dolt Git remote. The `bd` commands, the work item model and the JSONL interchange stay as they are;
only the store underneath changes. It is the `bd/` directory of this repository, a Go module named
`github.com/kombifyio/beads-cloudflare/bd`, and it is released together with the store (the Worker in `src/`) under
one version. The setup tool installs it for you: see [`SETUP.md`](../SETUP.md). This page is the reference.

The store implements the upstream `bd serve` `/v0` contract as a declared profile on Cloudflare Workers and SQLite
Durable Objects. This module is the client: it plugs into `bd` and translates every store call into that contract.

Status: pre-1.0. The backend works for everyday use (see
[Fidelity](#fidelity-carried-tested-here-or-refused) and [Conformance](#conformance)); it is not a complete
replacement for the Dolt store, and the list of what it refuses is below.

## What this module is

An **out-of-tree backend**, registered with Beads by name through the public `backend` package Beads exports for this
purpose. It is not a fork: a bd build with this backend is upstream `bd` plus one blank import.

```go
import _ "github.com/kombifyio/beads-cloudflare/bd/backend"
```

The `backend` package registers `cloudflare` at init time. Registration is the only wiring; a workspace selects the
backend by name. Because the module lives in a subdirectory of the repository, its Go version tags are `bd/vX.Y.Z`;
every release also carries the plain tag `vX.Y.Z` on the same commit.

## Getting bd with the backend

`join` (see [`SETUP.md`](../SETUP.md)) downloads the binary of the release that matches the store, checks it against
the release's `SHA256SUMS` and installs it. The release carries `bd_<os>_<arch>.tar.gz` (linux and macOS on amd64 and
arm64) and `bd_windows_amd64.zip`. To build one yourself, with one script:

```sh
bash scripts/build-bd.sh v1.3.1 ./bd
```

The script clones the given upstream Beads tag, adds one file (`cmd/bd/zz_backend_cloudflare.go`, the blank import
above), wires the `bd/` module in and builds with `CGO_ENABLED=0 -tags gms_pure_go`. The binary is stamped
`1.3.1+cloudflare.<VERSION>`, where `VERSION` is the file at the repository root, which is also the version the store
reports. No upstream source is patched. By default the module is replaced with the `bd/` directory of the checkout the
script lives in, so a build needs no published version; set `ADAPTER_VERSION=v0.1.0` to require a published version of
the module instead. `UPSTREAM_REPO` points the script at another clone or mirror of upstream. The module builds with
the Go version upstream pins; the go directive is only raised when a newer adapter needs more than upstream pins.

On connect, `bd` compares its version with the store's; see [`compatibility.md`](compatibility.md).

## Selecting the backend in a workspace

`join` writes the files below for you (and `bd init` must not be run: upstream refuses registered backends there), so this
section is the reference for what they hold.

`.beads/metadata.json` only needs the backend name. bd rewrites that file from its
own typed struct (`bd upgrade ack`, doctor fixes) and drops keys it does not know,
so the connection settings live in a sibling tracked file this backend owns:

```json
// .beads/metadata.json
{ "backend": "cloudflare" }

// .beads/cloudflare.json
{ "tracker": "my-project", "base": "https://beads.example.com", "token_env": "BEADS_CLOUDFLARE_TOKEN" }
```

Precedence for `base`, `tracker` and the token variable name: environment
(`BEADS_CLOUDFLARE_BASE`, `BEADS_CLOUDFLARE_TRACKER`), then `cloudflare.json`, then
`metadata.json` (kept as a fallback). The tracker is never derived from the folder
name: it is arbitrary in a git worktree. A configured tracker is folded to
`[a-z0-9]+(-[a-z0-9]+)*`.

The credential is looked up in this order, and the error names all three:

1. the environment: `BEADS_CLOUDFLARE_TOKEN`, or the variable `token_env` names;
2. `.beads/.env`, which bd loads into the environment;
3. a per-user file, `<user config dir>/beads-cloudflare/credentials.json`, shaped
   `{"<base url>": {"token": "..."}}` (refused when other accounts can read or modify it);
4. when `github_repository` is configured, an unexpired repository/tracker-scoped GitHub exchange cache, then
   automatic exchange using the host's existing GitHub user identity or Actions OIDC identity.

For the fourth path, `.beads/cloudflare.json` additionally holds `"github_repository": "owner/repository"`.
The server's `GITHUB_REPOSITORIES` binding maps that exact GitHub repository to allowed trackers. The host must
separately trust the store origin through `BEADS_CLOUDFLARE_TRUSTED_ORIGINS` or the owner-only trust record installed
by `join --trust-store`. A tracked repository config alone never authorizes transmitting GitHub credentials.

Developer identity precedence is `GH_TOKEN`, `GITHUB_TOKEN`, then a shell-free, deadline-bound
`gh auth token --hostname github.com`. Actions request variables select OIDC first; the request URL must be HTTPS
on `actions.githubusercontent.com` or a subdomain, redirects are refused and the audience is the store origin.
The server verifies the immutable repository ID, exact admitted main workflow and event. Installation tokens
and pull-request jobs do not establish a developer's push authority.

`POST <origin>/auth/github` receives `{repository, tracker}` with the GitHub bearer and returns `{token, expires_at}`.
The credential's tracker and scopes are set by server policy, never client choices. Credentials never appear in
errors, and redirects and oversized responses are refused. The backend uses a 10-second identity deadline and
a 15-second exchange deadline. A missing or malformed expiry forces refresh; cached keys from another repository
or tracker are never reused. Static agent-key custody stays supported and takes precedence. The native backend
captures host identity, trusted origins, config location, gh executable/environment and HTTPS trust before upstream
loads checkout `.beads/.env`. That checkout file can supply its own static key, but cannot grant host trust or redirect
the host's GitHub credential custody. `token_env` only accepts `BEADS_CLOUDFLARE_TOKEN` or
`BEADS_CLOUDFLARE_*_TOKEN`, and an ambient Beads key needs a host-trusted origin or startup
`BEADS_CLOUDFLARE_BASE` pairing. Repository configuration cannot alias another host credential such as `GH_TOKEN`.

The setup CLI's scoped cache is shaped as follows (values shown are placeholders):

```json
{
  "https://beads.example.com": {
    "github_trusted": true,
    "github": {
      "owner/repository#project": { "token": "<scoped credential>", "expires_at": "<RFC3339 timestamp>" }
    }
  }
}
```

Cache updates lock a fully written PID/nonce record and atomically replace the file while preserving other bindings;
a crashed holder is reclaimed only when its PID is proven dead. Unix permissions and Windows DACLs protect both
credential confidentiality and host trust integrity. `bootstrap` acquires credentials and installs the matching
binary without rewriting repository files. `credentials` is the auth-only interface for migration callers;
`credentials --json` returns secret material for a capturing custody process and must never be logged.
`doctor` defaults to read-only authenticated context; its optional scratch probe needs a separate credential
authorized for scratch trackers. See [the complete setup flow](../SETUP.md#portable-github-authorization).

The actor is bd's resolved actor (`--actor`, `BEADS_ACTOR`, git user). It is sent in
the `actor` member and as `X-Beads-Agent`; the server records it as
`x_client_actor` and authorizes on the verified principal.

Every write carries an `Idempotency-Key`, minted once per logical operation and
reused across the client's own retries (network errors and 5xx, with backoff).

Leftovers of a former Dolt workspace that matter: a `.beads/dolt` directory with no
`.beads/.local_version` makes bd refuse ("legacy Dolt workspace"); delete it or
write the current version into `.local_version`. A non-empty `.beads/issues.jsonl`
is auto-imported by the first write command against an empty tracker (once, then
stamped). No `config.yaml` is needed.

## How it reaches the store

The CLI reaches a store through role accessors (`IssueLifecycle()`, `IssueReader()`,
`Counter()`, ...). Each role method here is the inverse of one upstream `bd serve`
handler: it encodes the role request as that handler's wire request, calls the
route, decodes the answer, and maps `Problem` codes back to the `issueops` and
`backend` sentinels and typed errors. The raw Storage methods the CLI still calls
directly are thin projections onto the roles; the server filters and pages.

Local-only surfaces have no remote meaning and are kept in
`.beads/cloudflare-local.json`: local metadata (tip timestamps, version markers),
repo mtimes. `Commit` answers "nothing to commit", which both the post-command
auto-commit and the importer treat as nothing to do. `RunInTransaction` records every
write of the closure (create, update, close, dependency add and remove, comment,
setting) as one `issues:batchApply` plan, using the profile's `x_dep_remove`,
`x_comment` and `x_set_config` items, so a closure that returns an error has changed
nothing: no request is sent, and the clone-local writes run only after the plan has
landed. What no item expresses (deleting an issue, a memory write) is refused at the
call that asks for it. Reads inside the closure do not see the closure's own writes.
An issue created without an id carries a placeholder id until the plan lands, and
later items that name it are sent as references to its item.

`backend.DoltStorage` has 194 methods; 65 remain refusals (44 version-control
families, 21 outside the profile) and answer a typed `*backend.ErrUnsupported`.
`stubs.go` is **generated** by `cmd/genstubs` from the real interface minus what is
written by hand, and the two allowlists are `go:embed`-ed so the refusal set and the
checked set cannot drift apart.

```sh
(cd bd && go run ./cmd/genstubs ./cloudflare/stubs.go)   # after a Beads version bump
```

Two methods have no `error` return, so a refusal cannot be returned normally; those
**panic** with the typed error and are excluded from the allowlist.

### Bulk reads

A command that reads many issues costs requests per page, not per issue. Every bulk
path (`SearchIssues` and `IterIssues` over a whole selection, `GetLabelsForIssues`,
`GetCommentsForIssues`, `GetDependencyRecordsForIssues`, the comment and dependency
counts, `GetAllDependencyRecords`) uses the Worker's `issues:export` and
`dependencies:export` extensions: 500 whole records (labels, edges and comments
included) or 5,000 edges to a request. Rows read in bulk answer the per-id relation
reads that follow in the same command (for twenty seconds, and never after a write
through the same client), so `bd export --all` on 5,651 issues is about a dozen
requests. A server without the extensions answers 404 and the previous routes are
used. A page stops at the server's 4 MiB bound however few rows it holds, so a short
page is never taken for the end: every continuation cursor is followed wherever a
paged route is read, and an unlimited read has no row cap. Config calls that name
`kv.memory.<key>` are routed to the memories plane, which is how `bd export` finds memories and `bd import` writes them.

## Fidelity: carried, tested here, or refused

A field, filter or operation is either **carried** to the server, **evaluated in the
client** on the rows read, or **refused** with a typed error before any write. It is
never accepted and dropped. The reads below are exact because the client-side tests
run before the caller's limit and offset, over every page of the selection.

Orders: a list's default is priority ascending, then created newest first, then id; an
empty sort is sent as `priority`, never left to the server's own default. `created`
and `priority` are server sorts; `updated`, `closed`, `status`, `id` (natural order),
`title`, `type` and `assignee` are applied here with upstream's directions. Ready work
uses an explicit policy, `hybrid` when the request names none (upstream's resolved
default). A request with no limit gets upstream's shared default (50 for list and
query, 100 for ready); 0 is unlimited and reads every page. The ready and query routes
have no cursor, so an unlimited read asks for a bound no tracker reaches and fails
loudly if the answer still says it was truncated.

`brief` is a projection, applied last: a brief read that carries a text predicate
(`--desc-contains`, `--notes-contains`, `--empty-description`, a search query) fetches
the text, filters, and only then drops it.

| Request | Field | Where |
|---|---|---|
| `ListRequest` (62 fields) | status, type, assignee, labels, labels-any, exclude-labels, created bounds, parent, metadata fields and key, `all`, include templates/gates/infra/ephemeral/all-types, priority and created sort, limit, brief | server |
| | title search, spec prefix, id filter, label pattern and regex (a regex that does not compile is refused), title/description/notes/external contains, external ref, updated/closed/defer/due bounds, empty description, no assignee, no labels, priority and its range, pinned and no-pinned flags (`--pinned` also lifts the server's default hiding), exclude types (aliases normalized), no parent, mol type, wisp type, deferred (defer date set or status deferred), overdue, the keyset position (after created/id/priority), every other sort, reverse, offset, max rows (a validation error when exceeded) | client |
| | skip labels, skip counts | ignored by design: the rows come back with more than asked, never less |
| | ready flag | upstream's own `ValidateReadyFlagScope` refuses the fields the ready query cannot carry; an explicit status is intersected with the ready set; include gates/infra/all-types are refused (the ready routes always hold them back) |
| `ReadyRequest` (20) | type, exclude types, assignee, unassigned, the five label forms, priority, parent, metadata, include deferred/ephemeral, sort, limit, brief | server |
| | mol type, offset | client (mol type makes a claim-next refuse) |
| `QueryRequest` (6) | expression, include closed, sort, reverse, limit | server |
| | offset (read with `limit + offset`) | client; an offset with a sort is refused, as upstream refuses it |
| `IssueFilter` (70) | status(es), type, assignee, the label sets, created bounds, parent, metadata, include-ephemeral (from `SkipWisps`), brief (`Lite`) | server |
| | everything else with a row-level meaning, including `StartedAfter/Before`, `IsTemplate`, `Ephemeral`, `EphemeralTier`, `Pinned`, `IsBlocked`, `MolType`, `WispType`, `ExcludeStatus`, `IDs`, `IDPrefix`, the keyset position, `MaxRows` | client |
| | `IncludeDependencies` | edges are read and attached |
| | `SourceRepo` | refused (a tracker has one source) |
| | `SkipLabels`, `SkipCounts`, `NoIDShrink` | ignored by design |
| `WorkFilter` (26) | type, priority, assignee, unassigned, the label sets, parent, sort policy, limit, include deferred/ephemeral, exclude types, metadata, lite | server |
| | status, statuses, mol type, wisp type, offset, max rows | client |
| | molecule id | refused |

Writes follow the same rule. A create carries every member of upstream's request on
its wire member or in `x_extra` (the core `Issue` members the spec has no member for:
`spec_id`, the event members, `wisp_type`, `mol_type`, `is_template`, `pinned`,
`storage_class`, `source_*`, `await_*`, `timeout`, `waiters`, `bonded_from`);
`started_at` and `closed_at` travel with the preserved timestamps. `close_reason`,
`closed_by_session` and `updated_at` have no wire member on a create and refuse the
request; so do an issue's own comments and dependencies (the request carries edges).
An update's patch carries `spec_id` and `await_id` in `x_extra`; `owner`,
`closed_by_session` and `persistence` have no member on the single-issue patch and are
refused. An `update --claim` validates everything it can first, checks a version guard
against a fresh read (the claim route has no member for one), and if the patch still
fails after a claim this command took, releases that claim and returns the original
error. `bd import` is the server's merge import (`profile.import_merge`) and nothing
else: a server without that capability is refused before the first write.

## Acceptance

`scripts/smoke.sh` drives a built `bd` through the everyday commands against a
fresh tracker and fails on the first non-zero exit or missing effect. It needs
`BD` (the binary), `BEADS_CLOUDFLARE_BASE` and `BEADS_CLOUDFLARE_TOKEN`. It
writes, so it only runs against a local base such as a `wrangler dev` instance
unless `SMOKE_ALLOW_REMOTE=1` names a scratch store on purpose.

## What is refused, and why

A refusal is a typed error (`*backend.ErrUnsupported`, or a validation error naming
the field) raised before anything is written. Nothing is accepted and silently
dropped.

- **Version-control and sync surfaces** (44 methods): history, branches, remotes,
  push and pull, federation, compaction, fast statistics. The tracker is one
  authoritative remote store, not a Dolt repository, so these have no meaning.
- **Operations outside the server's `/v0` profile** (21 methods): merge slots,
  molecule progress and last activity, wisp listing and promotion, provenance
  events, bulk delete variants, dependent counts by status, and re-keying an issue
  id. `bd rename` has no route, so it is refused for that reason.
- **Fields a request cannot carry.** A create refuses `close_reason`,
  `closed_by_session` and `updated_at` (no wire member), and an issue's own comments
  and dependencies (the request carries edges). A patch refuses `owner`,
  `closed_by_session` and `persistence`. `SourceRepo` filters are refused: a tracker
  has one source.
- **Writes a transaction cannot express.** `RunInTransaction` is a write plan, so
  deleting an issue or writing a memory inside a closure is refused at the call that
  asks for it.
- **`bd import` against a server without merge import.** It is refused before the
  first write rather than half applied.

`bd doctor` reports `Database: No dolt database found` on a workspace that uses this
backend. Upstream opens a concrete Dolt store for that check, whatever backend the
workspace selects, so the check cannot see this one. A second error,
`bd prime Command`, appears when no `bd` is on `PATH` (the probe runs `bd prime`
from `PATH`, not the binary doing the check). Everything else doctor reports is real.
The proposal to fix the first one upstream is in
[docs/upstream-proposals.md](docs/upstream-proposals.md).

## Conformance

Beads ships a conformance suite for out-of-tree backends. Measured against a local
store (`wrangler dev`) with Beads `v1.3.1`:

- **Unsupported contract: every declared refusal passes.**
- **Portable raw surface (`RunAll`): 52 pass, 8 fail** of 60 checks (it was 49 / 11
  before, and 35 / 25 before that).

The 8 checks that fail, and why each is not a defect in the translation:

- **Four transaction checks** (`TransactionReadYourWrites`,
  `TransactionSnapshotReads`, `TransactionSearchIncludeDependencies`,
  `TransactionSearchFilterParity`). A transaction here is a write plan sent as one
  `issues:batchApply`; it cannot read its own writes, because nothing has been
  written until the plan lands.
- **`HeartbeatRenewsLease`.** A caller-supplied lease TTL cannot be honoured: the
  context key that carries it is unexported upstream, so an out-of-tree backend
  cannot read it. The proposal to export a reader is in
  [docs/upstream-proposals.md](docs/upstream-proposals.md).
- **`SearchPaging`.** The row cap is enforced, but the typed error the check
  expects (`*issueops.ErrTooManyRows`) lives in an internal package an out-of-tree
  backend cannot construct, so the error is a validation error with the same text.
- **`Portable`.** Operations the server's profile does not serve: molecule progress
  and last activity, wisp operations and ephemeral promotion, comment import,
  changing an issue id (`bd rename`), delete by source repository, dependent counts
  by status, and the all-edges iterator; plus a comment-count expectation that
  differs from how the server stores comments.
- **`Audit`.** The same missing operations (cascade and bulk delete), cases that
  need `bd import` with `SkipDependencyValidationErrors=false` (the merge import
  drops and reports an edge it cannot store and cannot fail the batch for one, so
  it is refused), and the server's readiness rules where they differ from the
  reference: blocking inherited through a parent chain, dependent counts across
  edge types, an ancestor-cycle error, and one closed-at timestamp comparison.

## Bugs the live suite caught that reading the code did not

Each of these looked correct and was not:

- **`PATCH` needs a nested `patch` object.** The editable fields go inside
  `{"patch": {...}}` with the guards beside it; sending them flat is refused with
  `unknown_parameter`. Every update was malformed.
- **`getIssue` omits comments and dependents unless asked.** They are opt-in
  query members, and a read that does not ask comes back with `comments_omitted`
  set, so comment and dependent reads were silently empty.
- **`omitempty` does not apply to `time.Time`.** With `preserve_timestamps` on
  and no caller-supplied time, the zero time was still serialised and the store
  recorded **year one** as the issue's age.
- **`ready:count` answers `{"total": n}`, not `{"count": n}`.** Every ready count
  was zero.
- **The events envelope is `{head, records}` with `seq`/`ts`/`x_event_type`**, not
  a generic item list, so the event read returned nothing.
- **Error translation broke `isNotFound`.** Mapping the Worker `Problem` onto
  Beads sentinels wrapped it, and the type assertion that had been checking for
  a missing issue stopped matching, so a batch read failed on the one absent id
  it was supposed to skip.

## Running the tests

```sh
cd bd && go vet ./... && go test ./...            # declarations only, no network

bash scripts/pair-proof.sh                        # the whole pair: build bd, run the Worker locally, smoke, conformance
```

`pair-proof.sh` is what CI runs on every pull request. It starts the Worker with `wrangler dev` on a free port with
fresh state, mints an agent key, runs `scripts/smoke.sh` and the upstream live suite (`TestLiveConformance`) against
it, and holds the conformance numbers to the baseline below. To run the suite by hand against a store you started
yourself:

```sh
cd bd
BEADS_CLOUDFLARE_LIVE=1 BEADS_CLOUDFLARE_BASE=http://127.0.0.1:8787 BEADS_CLOUDFLARE_TOKEN=...        BEADS_CLOUDFLARE_TRACKER=scratch  go test ./cloudflare/ -run TestLiveConformance
```

The live suite writes to the tracker it is given, so point it at a scratch name. It is skipped unless
`BEADS_CLOUDFLARE_LIVE=1`.

Use a **fresh tracker per run**. The upstream suite creates fixed fixture ids (`c-1`, `g-1`, ...) and never removes
them, so a shared tracker makes every check after the first run fail on `id already exists`, which looks like an adapter
fault and is not one.

The live suite is a **regression measure**, not a completion claim: 8 checks still fail, so a gate that demanded zero
failures would be red forever. The pair proof asserts the recorded baseline (52 pass / 8 fail of 60 checks) and fails when
the numbers get worse or when fewer than 60 checks ran. Raising the baseline is the visible signal that a remaining gap
was closed.

## Pinned version

The interface is experimental upstream: *"adding a required method to the engine
interface is a breaking change for out-of-tree implementations"*. `go.mod` pins an
exact Beads version and the conformance suite is re-run on every bump. The generated
stubs and the `var _ backend.DoltStorage = (*Store)(nil)` assertion are what make
that bump loud instead of silent.

## Contributing and releases

Issues and pull requests are welcome. Changes land in a maintainer-owned development repository and are published here
as versioned releases, so a pull request is applied there and appears in the next release rather than being merged in
place. Release history is in [`CHANGELOG.md`](../CHANGELOG.md).

## License

MIT, like the repository; Beads is MIT licensed too. See `LICENSE` and the upstream project.
