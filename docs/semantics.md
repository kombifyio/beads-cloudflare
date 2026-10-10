# Semantics ported from upstream Beads

Every rule below was read from the Go code of upstream Beads `v1.3.1`
(`c1c4b642ac1c08d8c828007a1c2f96e47e43ef7c`), not from the spec prose. Paths are relative to the
upstream repository root; where the Go code and the spec disagree, the Go code is followed and the
disagreement is noted. Our implementation lives in `src/tracker/`.

## Ready work (`listReadyWork`, `countReadyWork`, and the scan of `claimNext`)

HTTP path: `internal/httpapi/reads.go:54-94` (list) and `:140-161` (count) ->
`internal/workapi/ready.go:42-105` -> `internal/storage/sqlbuild/ready.go:93-223`
(`BuildReadyWorkWhere`). Count is the length of the unbounded listing, never a separate query.
Ours: `src/tracker/ready.ts`.

A row is ready when all of these hold:

1. **Status** is `open` (`sqlbuild/ready.go:96-114`; the HTTP layer always pins `open`,
   `workapi/ready.go:47`). `in_progress`, `blocked`, `deferred`, `hooked`, `closed` and `pinned`
   are never candidates. Custom statuses of category `active` also qualify upstream; this server has
   no custom statuses.
2. **Not pinned**: the `pinned` flag is 0 (`:117`).
3. **Not blocked**: `is_blocked = 0` (`:118`), the stored result of the blocking rule below.
4. **Not ephemeral** unless `include_ephemeral` (`:120-122`). This server rejects that parameter.
5. **Type**: `issue_type = type` when `type` is given (aliases `mr`, `feat`, `mol`, `enhancement`,
   `dec`, `adr` expand; `internal/utils/strings.go:6-23`), otherwise `issue_type` is not one of
   `merge-request, gate, molecule, rig, agent, role, message` plus `exclude_type` (`:16-38`, `:128-135`).
6. **Assignee**: `unassigned=true` means empty assignee and ignores `assignee`; otherwise
   `assignee = ?` when given; with neither, assigned and unassigned open rows are both ready
   (`:136-141`). There is no claim or lease predicate: a claim makes a row `in_progress`, which fails
   rule 1.
7. **Deferral** unless `include_deferred` (`:143-154`): `defer_until` is null or not in the future,
   and the row is not a direct child (one hop, `parent-child` edge) of a parent whose `defer_until`
   is in the future (`internal/storage/domain/db/ready_work.go:65-122`). Rows with status `deferred`
   fail rule 1 regardless.
8. **Labels, priority, parent, metadata**: `label` (all), `label_any`, `exclude_label`, `priority`,
   `parent` (recursive descendants over `parent-child` edges, plus dotted-id children without an
   edge; `:192-209`, `ready_work.go:136-212`), `metadata_field k=v` (string equality of the
   top-level key; `filter.go:348-371`), `has_metadata_key`.

### What blocks (`internal/storage/issueops/blocked_state.go:206-294`)

A row that is not `closed` or `pinned` is blocked when any of these holds:

- It has an outgoing edge of type **`blocks` or `conditional-blocks`** to a target whose status is
  not `closed` and not `pinned` (`:213-226`). The two types behave identically; no failure or close
  reason logic exists. Targets that do not exist (dangling or `external:`) never block.
- It has a **`parent-child`** edge (it is the child) to a parent that is itself blocked (`:227-240`).
  The parent's raw status does not matter, only its blocked state, and the rule is transitive.
  A child never blocks its parent.
- It has a **`waits-for`** edge to a spawner and the gate is closed (`waitsForGateBlockedSQL`,
  `:22-94`): the spawner has an open (not closed/pinned) `parent-child` child, unless the edge
  metadata says `gate: any-children` and some child is closed; or the edge metadata says
  `also_blocks: true` and the spawner itself is not closed/pinned.

No other dependency type (`related`, `discovered-from`, `replies-to`, `relates-to`, `duplicates`,
`supersedes`, ...) affects readiness. Upstream stores the result in `is_blocked` and recomputes it on
writes; this server computes the same least fixpoint on read, so it can never be stale. The rule is a
fixed point, not a path walk: a row is blocked when it has a live direct blocker or a parent-child edge to a
blocked row, so every row of a parent-child cycle that holds a blocked row is blocked. A page of rows is
evaluated over its own ancestor subgraph (the rows reached by climbing parent-child edges through rows that
exist and are not closed or pinned): the live direct blockers seed an iterative breadth-first pass down the
gathered edges. The verdict is independent of candidate order and equals the whole-graph closure
(`BLOCKED_CTES`) for every graph, cyclic ones included, with no recursion depth of its own.

### Ordering, limit, response

- `sort=priority` (HTTP default): `priority ASC, created_at ASC, id ASC`; `oldest`:
  `created_at ASC, id ASC`; `hybrid`: rows created in the last 48 hours first, by priority, then older
  rows by age (`sqlbuild/ready.go:51-69`).
- `limit` absent means 100; the page fetches `limit+1` rows and sets `has_more` (`workapi/ready.go:16-28`,
  `domain/db/issue_search.go:807-839`). There is no cursor on the ready listing.
- `limit=0` (unlimited) is refused with `400 invalid_argument` on this server, as upstream does when
  bound beyond loopback (`reads.go:547-555`).
- Items are `IssueWithCounts` (`internal/types/types.go:1139-1145`): `dependency_count` counts the
  row's own `blocks` edges, `dependent_count` counts `blocks` edges pointing at it, `comment_count`,
  `parent` (smallest parent-child target), sorted `labels`, and all outgoing edges as `dependencies`.

Deliberate difference: upstream runs a "wake" sweep for expired `deferred` rows before the list but
not before the count (`uow/issue_reader.go:52-58`). This server has no timed status transitions, so
count and list always agree.

## claim, claimNext, release, close, reopen

Handlers `internal/httpapi/{claim,claim_next,release,close,reopen}.go`; storage
`internal/storage/issueops/{claim,unclaim,close,reopen,release_role}.go`. Ours: `src/tracker/lifecycle.ts`.

- **claim** (`claim.go:36-227`): claimable source status is `open`; an issue with a non-empty
  assignee other than the actor is refused `409 already_claimed` with `assignee` and `issue_status`
  (`claim.go:162-188`, `:295-312`); any other non-claimable status is `409 not_claimable` with
  `issue_status`. Readiness, dependencies, `defer_until` and the `pinned` flag are **not** checked.
  The holder claiming again while `in_progress` is `200` with `already_claimed: true` and no write
  (`:143-149`). A real claim sets `assignee`, `status=in_progress`, `started_at` once, and writes the
  `claimed` event.
- **claimNext** (`claim.go:248-301`): the ready scan with `Unassigned` forced and no limit, ordered
  as above, claims the first row (rows lost to a race are skipped). Nothing claimable is **`200` with
  `{}`**: the `claimed` member is simply absent (`claim_next.go:104-116`, `apigen/types.gen.go:844-847`).
  A `limit` query parameter is `400` (`claim_next.go:55-58`).
- **release** (`release_role.go`, `unclaim.go:34-110`): only `open` or `in_progress` rows can be
  released; an unassigned row is `409 not_releasable`; `expected_assignee` that does not match is
  `409 precondition_failed` with `param: expected_assignee`; an unforced release by a non-holder is
  `409 already_claimed`; `force` together with `expected_assignee` is `400`. Result: `assignee=''`,
  `status=open`, `started_at` cleared, event `unclaimed`; response `{issue, changed: true, revision}`.
- **close** (`close.go:67-171`, `:318-393`): refused `409 not_closable` while open `parent-child`
  children exist (member `open_children`) or the issue has a *live direct blocker*, unless `force`;
  closing an already closed issue is `200` with `already_closed: true` and keeps the first reason; the
  assignee is kept; `expected_version` is checked first. There is no automatic closure of parents or
  epics.
  The blocker test is **not** the readiness predicate. `enforceClosePolicyForTargetInTx`
  (`close.go:140-157`) calls `IsBlockedInTx` (`internal/storage/issueops/dependency_queries.go:906-987`),
  which reports a blocker only when the issue is blocked (the stored transitive `is_blocked`, including
  the waits-for gate and inherited parent blockedness) **and** it has a direct edge of type `blocks`,
  `waits-for` or `conditional-blocks` to an existing target whose status is neither `closed` nor
  `pinned` (`:958-984`). A waiter whose direct waits-for target is closed therefore can be closed even
  while its gate still keeps it out of the ready set, and a child blocked only through its parent has no
  direct blocker and can be closed. Ours: `hasLiveBlocker` in `src/tracker/ready.ts`.
- **reopen** (`reopen.go:25-130`): only a closed row changes (to `open`, clearing `closed_at`,
  `close_reason`, `closed_by_session` and `defer_until`; assignee and `started_at` stay); any other
  status answers `already_open: true`. A non-empty `reason` adds a `commented` event.
- **Atomicity** upstream is a compare-and-set on a random `row_lock` token inside a Dolt
  transaction (`claim.go:107-136`). Here the Durable Object is single-threaded and the whole
  mutation is one synchronous `transactionSync`, so the lost-race case cannot occur mid-statement.

## Events

`listEvents` reads the durable journal (`internal/httpapi/events.go`,
`internal/eventsjournal/record.go`): records `{seq, ts, op, issue_id, actor?, issue, dep?, comment?}`
after `seq > since`, ascending, `head` = highest sequence; `since` is required, `limit` 1..10000
(default 1000). The `op` for each mutation (`internal/storage/issueops/journal.go:55-83`): `create`;
`update` for update, label changes, claim, claimNext, release and reopen; `close`; `dep_add` /
`dep_remove`; `comment`. The upstream journal is off by default; here it is always on.

## Memories

A memory is a `{key, value}` row (`internal/storage/kvkeys/kvkeys.go:21-28`); `POST` upserts
(`replaced` reports whether the key existed), a missing key or an empty stored value is `404`, `DELETE`
returns the value it removed. A key left out is derived from the content: lower-case, runs of
`[^a-z0-9]+` become `-`, at most 8 parts, cut at 60 bytes (`internal/memoryapi/memoryapi.go`).

## Ids

Hash ids (`internal/idgen/hash.go:16-85`, `internal/storage/issueops/helpers.go:177-267`): prefix, a dash
and a base36 digest of `title|description|actor|createdAtUnixNano|nonce`, with the length chosen by the
birthday bound over the number of existing ids (3 to 8 characters, collision probability at most 0.25),
retrying nonces 0..9 then longer lengths. Children of a parent get `<parent>.<N>` with `N` one above the
highest existing child number. An explicit id must start with `<prefix>-` unless `force_id_prefix`
(`create_only_guard.go:13-34`). The prefix is the tracker's `issue_prefix` setting without one trailing dash,
as upstream `ReadConfigPrefix` reads it; a tracker without the setting uses its tracker id.

## Blocked (`is_blocked`) and what `listIssues` shows

Upstream does not populate `is_blocked` on the /v0 reads (`internal/types/types.go:34-41`, spec
`Issue.is_blocked`); it is the stored projection of the blocking rule above. This server computes the
same least fixpoint on read (`blockedIds` in `src/tracker/ready.ts`) and emits it as `true` or `false`
on `listIssues` and `queryIssues` items, so a client no longer has to guess it from the ready set.
The rule is the stored flag's, `issueops/blocked_state.go:206-294`: only a row that is not `closed` or
`pinned` can be blocked, a missing or foreign target never blocks, and the flag is independent of
type, deferral and ephemerality, which the ready listing additionally filters on
(`sqlbuild/ready.go:93-223`). A client that derives "blocked" as "open and not ready" therefore
over-counts every open row that is merely deferred, ephemeral, pinned or of an excluded type. The
other upstream notion, `bd list`'s `blocked by` decoration, is a different rule (`GetBlockingInfoForIssuesInTx`,
`issueops/dependency_queries.go:531-760`: every non-closed `blocks` target counts, existing or not, and `pinned`
counts as unfinished) and is what `listBlockingAnnotations` answers.

`listIssues` hides, unless asked or named: done and frozen statuses, pinned rows, templates, gates, the
infrastructure types and the ephemeral tier (`internal/workapi/list.go:455-520`, `applyTypeSuppressions`).

## Summaries

- `getStats`, workspace form: `issueops/statistics.go:29-77` over the durable tier. `blocked_issues`
  counts the blocked set, `ready_issues` is `max(0, open - blocked)`, `pinned_issues` counts the flag.
  `skip_blocked` is honoured (both numbers `null`, `blocked_count_skipped: true`). With `assignee` the
  four definitions change as `workapi/stats.go:41-97` states: every tier, `blocked` is the status,
  `ready` is the real ready count and `pinned_issues` is 0. Blank `assignee` is `400` (`httpapi/stats.go:55-60`).
- `countIssues`: `workapi/count.go:48-130` and `sqlbuild/filter.go:60-300`. It counts durable rows
  of every status; `include_infra` merges every tier and drops templates and gates (`applyCountIncludeInfra`).
  `status` and `type` are used as written, so an unknown name counts 0. `title` and `title_contains` are
  case-insensitive substrings. `group_by` keys: `P<n>`, `(unassigned)`, `(no labels)` (absent when 0)
  (`issueops/count.go:100-215`); `total` is computed separately, so label buckets may overlap.

## Dependency reads

- `listDependencies`, `countDependencyEdges`: `httpapi/edges.go:15-120`. At most 100 `issue_id`
  values; an unknown id is `missing`, never `404`; `status` only with `direction=in`.
- `listBlockingAnnotations`: `issueops/dependency_queries.go:531-760` (see above).
- `getDependencyTree`: `issueops/dependency_tree.go:12-80` and `tree_walk.go`. Depth-first pre-order,
  each node once at the depth and parent of the first path that reached it, every edge type except
  `relates-to`, `max_depth` counts the root as level one, `status` prunes after the walk and keeps the
  ancestor chain (`PruneTreeByStatus`). Root is depth 0 with `parent_id: ""`; `truncated` is always false.
- `listDependencyCycles`: `issueops/cycle_report.go:15-100` over `blocks` and `conditional-blocks`
  edges only (`issueops/cycles.go:131-160`), rotated to the lowest id and sorted.
- `listRelatedIssues`: `httpapi/related.go`; ascending by neighbor id then edge type, absent far ends
  contribute nothing, an unknown anchor is `404`.

## Batches

- `batchCreateIssues`: `httpapi/batch_create.go:40-250`. At most 100 items, whole batch refused for
  one bad item with `param: items[i].<member>`. An absent `issue_type` is `task`.
- `batchCloseIssues`: `httpapi/batch_close.go`. Not all-or-nothing: a refused item is a `code`
  (`not_found`, `not_closable`, here also `already_claimed` when a live foreign lease holds the issue)
  on its outcome and the others land; a duplicate id is an idempotent re-close at its own index.
- `applyBatch`: `httpapi/batch_apply.go`. Items apply in order and never reorder. A key reaches
  backward only (`declared_later: true` otherwise), except `create.metadata_refs`, spliced after every
  id exists. Guards evaluate as modified; `expected_version` on a row an earlier item wrote is `400`.
  The end gate re-validates every scheduling edge the request added, and `skip_per_edge_cycle_check`
  never skips it. `waits-for` metadata is normalized to `{"gate":"all-children"}`. One extension:
  the request also takes an `Idempotency-Key`, like every write here.
- `deleteIssues`: `issueops/delete_role.go:20-200`. Unknown id `404`; a dependent outside the set is
  `400` unless `force` (reported as `orphaned`) or `cascade` (transitive dependents, any edge type);
  references to a deleted id in survivors' text become `[deleted:<id>]` (`:319-369`); the boundaries are
  lookarounds here, so two references separated by one space are both rewritten (upstream's pattern
  consumes the separator and leaves the second one).
- `sweepIssues`: `workapi/sweep.go:20-250`. Closed rows of one tier; `pattern` is a `filepath.Match`
  glob over the id; pinned rows are never swept; `protect_referenced` (default true) keeps candidates
  cited at word boundaries in the description, notes, design, acceptance criteria or comments of any
  bead whose status is not done. An unfiltered durable sweep is `400`.
- `compareAndSetMetadata`: `issueops/metadata_cas.go:14-75`. Absent `expected`/`value` means the key
  is absent; a lost swap is `200` with `swapped: false`; equality is the canonical JSON encoding.

## Query language (`queryIssues`)

Grammar: `internal/query/lexer.go` and `parser.go`: fields compared with `= != < <= > >=`, joined by
`AND`, `OR`, `NOT` and parentheses; values are identifiers, quoted strings, numbers and durations
(`7d` means seven days ago). Fields: `id`, `title`, `description`/`desc`, `status`, `priority`,
`type`, `assignee`, `owner`, `created`, `updated`, `closed`, `started` (and `_at` aliases), `label`/`labels`,
`pinned`, `ephemeral`, `template`, `spec`/`spec_id`, `parent`, `mol_type`, `notes`, `has_metadata_key`,
`metadata.<key>` (`parser.go:300-349`). The evaluation follows the predicate builders
(`evaluator.go:540-980`): `title`, `notes` and `description` are case-insensitive containment,
`assignee`, `owner` and `label` compare case-insensitively with `none`/`null`/empty meaning unset
(`owner` too: upstream's owner predicate has no unset spelling, this server gives it the assignee's),
`id` takes a trailing `*`, a date comparison with `=` means the same UTC day, `closed` and `started`
never match a null. Upstream's filter mode differs from its predicate mode in places (it rejects
`priority != n`, `owner=` and `closed=`); this server always evaluates the predicate, which accepts
them. Default scope (`workapi/query.go:57-100`): closed rows are hidden unless `all` is set or the
expression mentions `status`; the default order is `priority ASC, created_at DESC, id ASC`; `sort`
orders the bounded rows with `CompareIssuesBy` (`workapi/sort.go:13-42`), `reverse` inverts it, and
`has_more` is exact. Evaluation reads only the small columns of every candidate; the conjuncts
that SQL can decide (id, status, type, priority, assignee, owner, label, parent and the time bounds)
narrow the candidates first, the description, notes, metadata and extra columns are fetched 50 rows
at a time and only when the expression names them, and without `sort` the scan stops at `limit + 1`
matches. Only the rows of the answer are read in full.

## Import

See `docs/profile.md`. The comparison that makes it idempotent is over the stored form of a record
(columns, `extra`, sorted labels, outgoing edges ordered by target, comments ordered by creation
time), never over the request text.

### Merge import

`mode: "merge"` is upstream's `ImportBatch` (`issueops/importer.go:10-41` request, `:58-73` result;
`internal/storage/uow/importer.go:49-114` body: issues through the batch engine, then memories, then the
`issue_prefix` sync; one transaction). Rules, from `internal/storage/issueops/create.go` unless noted:

- Stale guard: `RejectStaleUpserts` is `!AllowStale` (`importer.go:23-27`, `uow/importer.go:65`). In
  `InsertIssueIfNew` (`create.go:671-705`) a stored `updated_at` strictly newer than the record's rejects it
  inside the transaction (`:690-699`); the rejected record's labels, comments and edges are skipped
  (`create.go:135-144`, `:300-303`). `storage/batch.go:19-31` states the tie rule: an equal timestamp keeps
  every stored column but still merges labels, comments and edges.
- Rewritten columns: `issueUpsertColumns` and `issueUpsertAssignments` (`helpers.go:65-99`): title, bodies,
  status, priority, type, assignee, estimate, `started_at`, `closed_at`, `external_ref`, close fields, `metadata`
  and `updated_at`. `owner`, `due_at`, `defer_until`, `created_*`, the flags and the other members are not in
  that list, so an existing row keeps them. Without the guard each is `VALUES(col)` (`helpers.go:94-96`).
- Labels `INSERT IGNORE` (`create.go:728-779`); comments skip a matching `(author, created_at, text)`
  (`:821-833`); edges `ON DUPLICATE KEY UPDATE type = type` (`:946-950`), so an existing pair is untouched.
- Edge validation with `SkipDependencyValidationErrors` (`uow/importer.go:63-78`): missing target, hierarchy
  conflict (`dependencies.go:520-549`), self edge and cycle (`:441-456`) are dropped and reported
  (`create.go:897-931`); targets that are `external:` or of another prefix skip the existence and hierarchy checks
  (`dependencies.go:83-100`). Hierarchy edges are written first (`create.go:884-888`).
- Prefix: `ValidateIssueIDPrefix` (`create.go:566-581`) unless `SkipPrefixValidation` (`:228`).
- Defaults and leases: `closed_at` of a closed row (`create.go:547-555`); `RestoreLeaseOnImportInTx`
  (`lease.go:198-283`) never overwrites a live local lease.

Differences: timestamps are millisecond text here (upstream compares `DATETIME` at second precision); a request
cannot carry `settings` or `project_id`; the journal gets one `update` event per changed existing row where
upstream journals through its own hooks.

## Where the Go code and the spec disagree

- `issue_type` is mandatory on create; omitting it is refused (`types.go:380` validation; spec
  `createIssue` text agrees). There is no alias expansion for `issue_type` on HTTP create or list,
  contrary to the spec prose near line 1119.
- `priority` omitted on create is stored as `0`, not a workspace default.
- Edge `type` is limited to 32 bytes by `types.go:1302`, not 255 as the schema says.
- `getIssue` `dependents` are shallow objects with zero timestamps, not full issues.
- `status` membership is not validated by upstream `updateIssue`; this server validates it against the
  built-in statuses and answers `400`.
- Title length: `ValidateIssueTitle` (`internal/types/types.go:338-348`) allows 500 bytes and the column is
  `VARCHAR(500)`, while the HTTP create, update and batch handlers bound the title at 255 characters
  (`httpapi/create.go:166`, `update.go:298`, `batch_create.go:170`). This server follows the validator.
