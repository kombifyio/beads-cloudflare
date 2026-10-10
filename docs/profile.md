# Profile declaration

This server is a **profile** of the upstream `bd serve` `/v0` contract
(`spec/upstream/openapi.v0.yaml`, Beads v1.3.1; see the "Profiles" section of that document). This
page is the declaration the profile rules require: what is implemented, what is omitted, and every
deviation and extension. Conformance is checkable against wire JSON: every member emitted under a core
name carries the core type and semantics or is absent.

## Surface

- **Base path.** Every upstream path is served under `/t/{tracker}`, for example
  `POST /t/{tracker}/v0/beads/issues`. A tracker is a Beads project; its id is the issue-id prefix.
  Trackers are created implicitly by their first write. Tracker ids match `[a-z0-9]+(-[a-z0-9]+)*`,
  at most 40 characters.
- **Project stamp.** `Bd-Project-Id`, when present, must equal `{tracker}`; otherwise `400`,
  `reason: project_mismatch`, `server_project_id: {tracker}`. `project_id` in `getContext` is the
  tracker id. Capability token `project.enforce` is advertised.
- **Implemented operations** (all others answer the undefined-path `404`, and have no capability
  token): `getContext`, `health`, `listReadyWork`, `countReadyWork`, `listIssues`, `getIssue`,
  `createIssue`, `updateIssue`, `closeIssue`, `reopenIssue`, `claimIssue`, `releaseIssue`,
  `claimNextIssue`, `addComment`, `addDependencies`, `removeDependency`, `listMemories`,
  `rememberMemory`, `getMemory`, `forgetMemory`, `listEvents`, `getStats`, `countIssues` (with
  `group_by`), `queryIssues`, `listDependencies`, `countDependencyEdges`, `listBlockingAnnotations`,
  `getDependencyTree`, `listDependencyCycles`, `listRelatedIssues`, `batchCreateIssues`,
  `batchCloseIssues`, `applyBatch`, `deleteIssues`, `sweepIssues`, `compareAndSetMetadata`,
  `listSettings`, `getSetting`, `setSetting` and `unsetSetting` (the last four under
  `/v0/beads/config`, with the upstream methods `GET`, `GET`, `PUT` and `DELETE`). The extension reads
  `issues:export` and `dependencies:export` are declared under "Bulk export".
- **Not implemented**: `watchEvents` (a held-open stream does not fit one request to a Durable
  Object; `listEvents` with `since` is the supported way to follow the journal). A client probes
  `capabilities`.
- **Strict parameters.** Unknown query parameters, unknown body members (any level) and a wrong
  `Content-Type` are refused as the spec's header prose requires. Every parameter the spec declares
  for an implemented operation is implemented, including `include_templates`, `include_gates`,
  `include_infra` and `include_ephemeral` on `listIssues`, and `label_pattern`, `label_regex` and
  `include_ephemeral` on the ready operations and `claimNext`. A parameter this server cannot honour
  stays refused as unknown.
- **`label_regex` is a safe subset of RE2.** Upstream hands the pattern to Go's RE2 (linear time); the
  JavaScript engine here backtracks inside a Durable Object every tracker shares, so a pattern is
  accepted only when it is at most 128 characters, has at most 3 quantifiers, uses no backreference,
  lookaround, named group, inline flag or POSIX class, repeats no group that itself holds a quantifier
  or an alternation (`(a+)+`, `(a|b)*`), and uses only the escapes `\d \D \w \W \s \S \b \B \t \n \r
  \f \v` and escaped punctuation. Anything else is `400 invalid_argument`, `param: label_regex`.
  Labels are bounded at 255 characters, so a match is polynomial of degree at most 3.
- **Media types and codes.** Successes are `200` `application/json`, errors
  `application/problem+json` with the upstream `Problem` schema and its code vocabulary. `Cache-Control:
  no-store` is sent on every answer.

## Declared deviations from the core

| Area | Deviation | Why |
|---|---|---|
| Authentication | A bearer credential on every route under `/t/`: an OAuth 2.1 access token or an agent API key (see "Agent API keys"), including `health` and undefined paths; a request without a valid token gets the provider's `401` challenge, not the core's `unauthenticated` Problem body. A token lacking `beads:write` gets the provider's `403` `insufficient_scope` challenge on writes. `GET /healthz` at the root is unauthenticated. | One Worker is the resource and the authorization server. |
| `actor` | Required and validated exactly as upstream (it is a required request member), but **never trusted**: the actor of every mutation and event, `created_by`, and a comment's `author` are the verified principal's email. The asserted value is kept only as the event extension `x_client_actor`. Ownership checks (claim, release) compare against the principal. | Identity comes from the token. |
| `limit=0` | Refused on `listIssues`, `queryIssues` and `listReadyWork` (`invalid_argument`, `param: limit`), as upstream does when bound beyond loopback. | Not a loopback server. |
| `getContext` | `backend: "cloudflare"`, `dolt_mode: ""`, `database: ""`, `bd_version` is the upstream release this profile follows (`1.3.1`); `beads_dir` and `repo_root` are omitted (allowed by the schema). | No filesystem or Dolt. |
| Members not stored | Issue members for features this server does not have are absent, never re-spelled: `lease_granted_node` and `comments` inside list items. The members a record only carries when it was imported (`spec_id`, compaction fields, wisp, molecule and gate fields, `is_template`, ...) are emitted verbatim when the import stored them and are absent otherwise; a consumer cannot tell "unset" from "not supported" for them. `is_blocked` is emitted, as `true` or `false`, on `listIssues` and `queryIssues` items (upstream leaves it out of these reads and documents it as a journal member; see "Blocked" in `docs/semantics.md`) and is absent everywhere else. | Subset. |
| Edge records | `Dependency.id` and `thread_id` are never emitted. | Not stored. |
| `getIssue` | `revision` is the decimal string of the issue's version counter (starts at 1, increments on every change to the issue row, labels included, not on edge or comment writes). `dependents` and `brief_deps` entries are shallow with zero timestamps, as upstream emits. | See `docs/semantics.md`. |
| Titles | `title` is bounded at 500 BYTES, which is `ValidateIssueTitle` and the `VARCHAR(500)` column. The HTTP handlers upstream additionally refuse more than 255 characters; this server does not, because stores in the wild hold longer titles. This widens a bound the spec states (`maxLength`), so it is a declared deviation, not a tightening. Every other bounded text member keeps 255 characters (`CheckFieldLen`). | A real 258-character title was refused. |
| Vocabularies | A status is valid when it is built in or named by `status.custom`; an issue type when it is built in, `event`, or named by `types.custom` (`agent`, `role`, `rig` and `merge-request` are not built in upstream either). `types.custom` is a comma list or a JSON array; `status.custom` entries are `name[:category]` with category `active`, `wip`, `done` or `frozen`. | Align with `IsValidWithCustom`. |
| Tiers | One table holds both tiers. The default listing hides rows with `ephemeral` or `no_history`, `gate` rows, the configured infrastructure types (default `agent`, `role`, `message`) and `is_template` rows until `include_ephemeral`, `include_gates`, `include_infra` or `include_templates` asks, or the `type` filter names the type. Naming an infrastructure type admits both tiers (upstream routes it to the ephemeral tier only, because it has two tables). | `workapi/list.go:455-520`. |
| Events and delete | The journal is append-only, so `deleteIssues` and `sweepIssues` record a `delete` event per bead, remove the bead, its labels, comments and edges, and never remove earlier events: `events` in their results is always `0`. | Upstream deletes the event rows of a deleted bead. |
| `casMetadata` numbers | Numbers are compared after JSON parsing, so `1` and `1.0` are equal here; upstream compares the source literal. Compose `expected` from a previous `current`, or use strings. | The Worker parses JSON before it can see a literal. |
| `queryIssues` | Every expression is evaluated as a predicate over the candidate rows (upstream's predicate mode), so none is refused for being "filter-incompatible". Natural-language dates beyond `now`, `today`, `yesterday`, `tomorrow`, compact durations, dates and RFC 3339 are refused with `invalid_value`. | See `docs/semantics.md`. |
| Ready work | The ready listing has no cursor: the spec says so and its `has_more` only means the limit truncated it. | Spec. |
| `getIssue.dependencies` | An edge whose target names no issue here (an `external:` reference, another prefix) is not a neighbor and is absent, as upstream; `listDependencies` returns every stored edge row. | Spec: rows are not neighbors. |
| Ids | The final id of a create, however produced, must be 1 to 255 characters without control characters; a child id that would exceed that is `400` (`param: parent_id`). Tracker ids are the same on every surface: `[a-z0-9]+(-[a-z0-9]+)*`, at most 40. Memory keys follow one rule on remember, get and forget: non-blank, no control characters, at most 245 characters. | Addressability. |
| `status` on update | Validated against `open, in_progress, blocked, deferred, closed, pinned, hooked`; upstream stores any value. | Safer; tightening. |
| Events | The journal is always on, `seq` is strictly increasing across the whole team and `listEvents` filters by tracker, so a tracker's sequence numbers can skip. Nothing is pruned, so `events_journal_truncated` and `events_journal_disabled` are never answered. `issue` snapshots omit `is_blocked`. Memories write no events. | One store per team. |
| Timestamps | RFC 3339 UTC with millisecond precision. | |
| Lease expiry | `lease_expires_at` is emitted on a live claim with its core meaning. Upstream's default lease is 5 minutes; this server's is 30. | See the lease extension. |

## Extensions

Names are prefixed `x_` or are HTTP headers, so they cannot collide with a core name; a later core
revision that defines one is reconciled by renaming the extension.

### Idempotency (`Idempotency-Key`)

Every mutating route accepts the request header `Idempotency-Key` (1 to 255 printable ASCII
characters). Receipts are kept for 7 days per `(principal, key)` together with a SHA-256 of the
canonical request (method, path, query, `If-Match`, body with sorted keys) and the full successful
response. The same key with the same request returns the stored status and body without writing again
and sets `Idempotency-Replayed: true`. The same key with a different request is `409
precondition_failed` with `param: Idempotency-Key` and `reason: idempotency_key_reused`. Failures are
not stored, so a refused request can be retried after the cause is fixed. Capability token
`profile.idempotency_key`. MCP write tools take the same guarantee as `mutation_id`.

### Optimistic concurrency (`ETag`, `If-Match`, `expected_version`)

Responses that carry an issue set `ETag: "<version>"`. `PATCH /issues/{id}` accepts `If-Match` with
that value; a mismatch is `409 precondition_failed`, `param: If-Match`, `reason: version_conflict`.
The upstream `expected_version` (equal to `revision`) is accepted on update, close and reopen and
answers the same way with `param: expected_version`. Capability token
`profile.optimistic_concurrency`.

### Lease and fencing (`profile.lease`)

- `claimIssue` and `claimNextIssue` accept `x_lease_seconds` (integer 1..86400, default 1800) and
  answer an extra response member `x_fencing_token` (integer, incremented on every real claim); for
  `claimNext` it sits beside `claimed`.
- A claim stores `lease_expires_at`. The holder claiming again before expiry renews the lease and
  answers `already_claimed: true` with the unchanged token; the renewal bumps `revision` and
  `updated_at` and appends an `update` event with `x_event_type: lease_renewed`.
- An `in_progress` issue whose lease has expired is claimable again by anyone, through `claimIssue` and
  through `claimNextIssue` (its scan is the ready set plus expired in-progress rows), and the new claim
  gets a higher token. Nothing reverts a lapsed claim on its own; it stays `in_progress` until claimed
  again, released or closed.

#### The claim rule

A claim is *held* while the issue is `in_progress`, has an assignee and has a lease; it is *live* until
`lease_expires_at`. Claim-sensitive changes are: a `status` or `assignee` change through `updateIssue`,
`closeIssue`, and `releaseIssue`. They go through one guard, in this order:

1. A presented `x_fencing_token` (accepted on `updateIssue`, `closeIssue` and `releaseIssue`) that is not
   the issue's current number is `409 precondition_failed`, `param: x_fencing_token`,
   `reason: stale_claim`, with the members `x_fencing_token` (presented) and
   `x_current_fencing_token`.
2. While the claim is live and held by another principal, the change is `409 already_claimed` with
   `reason: claimed_by_other`, `assignee` and `issue_status`. The overrides are the ones upstream
   already has: `force` on release and `force_assignee_transfer` on update.
3. Once the lease has expired anyone may act (claims are advisory in upstream Beads, and closing an
   abandoned item is normal), and the change raises the fencing number by one, as does an override of a
   live claim. The previous holder's number is then stale, so it cannot act on the item afterwards.

The claimant is the principal that took the claim. It may change `assignee` and `status` on its own
live claim through `updateIssue` without `force_assignee_transfer`, as upstream lets the holder move its
own assignment (`AuthorizeAssigneeTransferWithPools`: the holder matches the actor). A second fence on
`patch.assignee` that upstream also has (an `in_progress` row assigned to someone else is not reassigned
without `expected_assignee` or `force_assignee_transfer`) therefore applies to every other principal, and
not once the lease has lapsed; an assignment that never had a lease is held to it as upstream holds it.

Without a token and without a live foreign claim, upstream behavior applies unchanged. Closing an
already closed issue is idempotent and raises nothing.

### Import (`profile.import`, scope `beads:import`)

`POST /t/{tracker}/v0/beads/issues:import` (agent API keys with the `beads:import` scope only; it
implies `beads:write`, and OAuth tokens never carry it; `scripts/keys.mjs create <label> --import`)
moves a tracker here without losing its history. It is a declared extension because no upstream
operation can carry the timestamps, creators, close reasons, comments and edge provenance of an
existing record. The body is `{actor, issues?, memories?, settings?, project_id?}` with at most 200
records and a 16 MiB body; `actor` is attributed only as `x_client_actor`, the verified principal is
still the actor of the events.

- A record is the JSONL export shape: the `Issue` members, plus `labels`, `dependencies` (each
  `depends_on_id`, `type`, `metadata` as text or object, `created_at`, `created_by`) and `comments`
  (`author`, `text`, `created_at`, optional `id`). Derived members of an exported row
  (`dependency_count`, `is_blocked`, ...) are accepted and ignored; any other unknown member is
  refused. Core members the server stores without querying (`spec_id`, `is_template`, `wisp_type`,
  `mol_type`, compaction fields, ...) are kept as given and emitted verbatim.
- Records upsert by id inside one transaction. A record whose stored form already equals the given one
  changes nothing and appends no event; a changed record replaces the stored one, including its label,
  comment and outgoing edge sets, and bumps `revision`. Edges whose target is missing are stored; the
  order of batches does not matter. Timestamps are normalized to UTC with millisecond precision.
- It bypasses close policy and the ancestor and cycle refusals. The response states what was let
  through: `bypassed.{dangling_edges, cycle_edges, hierarchy_edges, closed_with_open_children}`,
  counted for the records that changed, from one snapshot of the graph. Nothing is dropped.
- Edge `metadata` is stored exactly as given, valid JSON or not (it is a string on the wire). Every
  reader that looks inside it (the `waits-for` gate, `also_blocks`) treats text that does not parse
  as having no members, so a legacy row cannot break a read of other rows. The same holds for every
  stored JSON column: a malformed `metadata`, `extra`, event body, receipt or key row degrades that
  row only.
- `settings` are written as `PUT /config/{key}` would, except that `issue_prefix` is allowed, and
  project `status.custom` and `types.custom`; they are applied first, so a record may use a status the
  same request configures. `memories` are `{key, value}` rows. `project_id` stores the project id the
  tracker answers to (`getContext.project_id`, and the `Bd-Project-Id` stamp is accepted when it equals
  either that or the tracker id).

#### Import modes (`profile.import_merge`)

**Guarded migration (`profile.import_migration_guard_v1`).** A caller must first find this token in the
authenticated context's `capabilities` array. Opt in with `migration_guard: {schema_version: 1,
expected_event_head: N}`, where `N` is the tracker-scoped `head` returned by `/events` around its stable
destination snapshot. This requires `mode: "merge"`, `reject_stale: true`, `beads:import` and a nonempty
issue batch; claim overrides, prefix-validation bypass, memories and prefix synchronization are refused.
Without the guard, existing import semantics are unchanged.
Guarded recovery may retain a historical id already present in the same tracker
even when its configured prefix changed. A new id still needs an admitted
prefix; this does not authorize a rename or relax any migration precondition.

Inside the existing write transaction, before any import effect, the entire batch is refused with
`409 precondition_failed` if the tracker head changed (`migration_event_head_changed`), an existing issue
is assigned and in progress/hooked or holds a live lease (`migration_claimed_issue`), an absent identity
has any prior delete event (`migration_tombstoned_issue`, irrespective of the incoming timestamp), or an
existing record is not strictly older than the incoming record (`migration_record_not_newer`). These
checks protect all columns, labels, comments and outgoing edges, including the claimant's own rows.
Success echoes `migration_guard: {schema_version: 1, expected_event_head: N, event_head: M}` with the new
tracker head. A migration client requires that echo; an uncertain response is inspected, never blindly
replayed. This is not a replacement for verifying the imported records and dependency results.

The body takes an optional `mode`, `"replace"` or `"merge"`; any other value is `400`.

- **`"replace"`** (the default) is everything above: records replace what is stored, nothing is dropped, and
  the scope is `beads:import`. Its response gains `mode: "replace"` and `issues.skipped_stale` (always `0`).
- **`"merge"`** is the semantics of upstream's `issueops.Importer.ImportBatch`, with the file and line of each
  rule in `docs/semantics.md` ("Merge import"). It cannot delete anything and cannot rewrite a record that is
  newer here, so it needs only `beads:write`; an OAuth user can send it. Without `beads:import` the body is
  limited to 4 MiB (16 MiB with it).

A merge request is `{actor, mode: "merge", issues?, memories?, reject_stale?, skip_prefix_validation?,
sync_issue_prefix?, override_claims?, migration_guard?}`. Records are the same JSONL records, with the same limits (200 records, 5,000 edges, 5,000
comments) and the same validation; `settings` and `project_id` are refused (`unknown_parameter`), because a
merge carries only what upstream's batch carries. The whole request is one transaction, and the stale
comparison reads the stored row inside it.

| Member | Meaning (upstream) |
|---|---|
| `reject_stale` (boolean, default `false`) | Upstream `RejectStaleUpserts`, which `bd import` sets unless `--allow-stale`. `true`: a stored row whose `updated_at` is strictly later than the record's is kept whole and reported, and the record's labels, comments and edges are not merged either; an equal `updated_at` keeps the stored columns but still merges labels, comments and edges; a strictly later record rewrites the columns below. `false`: the columns below are rewritten whatever the timestamps say. The adapter of `bd import` sends `true`. |
| `skip_prefix_validation` (boolean, default `false`) | Upstream `SkipPrefixValidation`. `false`: every new record id must start with the tracker's `issue_prefix` or one of the comma separated `allowed_prefixes` setting, followed by `-`; a miss is `400` (`param: issues[i].id`) and the whole request is rolled back. A guarded migration may retain an existing historical id already held by this same tracker; ordinary merges still validate every id. |
| `sync_issue_prefix` (string) | Upstream `SyncIssuePrefix`: when it differs from the stored `issue_prefix` setting, the setting is rewritten (existing ids are not renamed). |
| `override_claims` (boolean, default `false`; extension) | A change of `status` or `assignee` on an existing row acts on a claim, so it goes through the same claim guard as `updateIssue`, `closeIssue` and `releaseIssue`. A **live claim of another principal** is not overridden silently: the record's columns are left as they are (labels, comments and edges still merge) and the row is listed in `claim_conflicts` (`issue_id`, `assignee`, `claimed_by`). With `override_claims: true` the claim is overridden, as `force` does on release. Either way, when the guard says an expired or overridden claim ended, the fencing number is raised, so the previous holder's `x_fencing_token` is stale. |

**Provenance.** A merge without `beads:import` (an OAuth user, or a key with `beads:write` only) cannot attribute
anything to someone else or to another time. Comments it adds are authored by the verified principal and stamped
with the request time, edges it adds carry the principal as `created_by` and the request time, and a record it
creates has the principal as `created_by` and the request time as `created_at` and `updated_at` (`started_at` and
`closed_at` are the request time when the status is `in_progress` or `closed`, otherwise unset), as `createIssue`
stamps without `preserve_timestamps`. Incoming lease fields are ignored: claims are taken through `claimIssue`. A
repeat of the same merge adds nothing: a comment is skipped when the issue already has a comment by this principal
with the same text. With `beads:import`, a merge keeps the author, `created_at`, `created_by`, lease and
timestamps of the records as given.

What a merge does, per record: an id this tracker does not hold is **created** (verbatim with `beads:import`, stamped as above without), as replace does. An
existing id has these columns rewritten when the rule above allows: `title`, `description`, `design`,
`acceptance_criteria`, `notes`, `status`, `priority`, `issue_type`, `assignee`, `estimated_minutes`, `started_at`,
`closed_at`, `external_ref`, `close_reason`, `closed_by_session`, `metadata`, `updated_at`. Every other member
(`created_at`, `created_by`, `owner`, `due_at`, `defer_until`, `sender`, the flags, and the core members this
server stores without querying, such as `spec_id`) is written only when the row is created. `labels`, `comments` and `dependencies` are merged **additively**: a label
already there is skipped; a comment whose `(author, created_at, text)` the issue already has is skipped and any
other is inserted (a comment without an `id` gets a generated one); an edge is validated as the batch engine
validates it and an edge whose pair already has one is left as it is. An edge is **dropped and reported**, never
an error, when its target is missing (unless the id starts with `external:` or has another prefix), when a
blocking edge runs against the issue's own ancestors or descendants, when it is a self-edge or when it would
close a scheduling cycle. With `beads:import`, a leased in-progress record restores its lease unless a live local
lease exists (leases are node-local); a replaced or dropped lease is a change (revision, `update` event, `updated`) and
raises the fencing number, and a row that is no longer an assigned in-progress claim loses its lease. A closed record
without `closed_at` gets one second after the later of its two timestamps, and a record without `updated_at`
gets the time of the request. A new row appends a `create` event, a changed existing row an `update` event
(`x_event_type: imported`), and an added edge a `dep_add` event. `revision` is bumped when a column, a label or
the lease changed.

The response is `{mode: "merge", issues: {created, updated, unchanged, skipped_stale}, skipped_stale_ids: [id],
skipped_dependencies: [{issue_id, depends_on_id, reason}], claim_conflicts: [{issue_id, assignee, claimed_by}], memories: {created, updated, unchanged},
prefix_synced: boolean, comments: n, edges: n}`. `updated` counts an existing record for which anything
changed (columns, labels, comments or edges), `unchanged` one for which nothing did. Timestamps have
millisecond precision here, upstream's `DATETIME` has second precision, so a tie is rarer. `memories` are
`{key, value}` rows, the later one winning, as in replace.

### Logical recovery (`profile.logical_recovery_v1`, scope `beads:import`)

`GET /config:export` returns every stored configuration row as `{items:[{key,value}],has_more,next_cursor?}`,
including `kv.*`, empty values and credential-bearing values that ordinary config reads omit or redact.
It requires `beads:read`, `beads:write` and `beads:import`; it is intended for private snapshots, never logs.
Pages use ascending keys: `limit` is 1 to 200 (default 100), `cursor` is the previous `next_cursor` key.
A page is cut after roughly 4 MiB of text, with at least one row to preserve progress.
The ordinary configuration API keeps its existing projection and redaction behavior.

HTTP context and MCP `tracker_context` include `x_mutation_revision`, a non-negative monotonic tracker
revision. Every successful write through TeamStore advances it inside the same transaction, including
memory, configuration and project-identity writes that do not append an issue event. A successful
no-op may advance it conservatively. Refused transactions and idempotency receipt replays do not.
Authentication/key housekeeping is team credential state and is not part of this tracker revision.

Replace import optionally accepts `restore_guard:{schema_version:1,expected_revision,require_empty}`.
The import checks the expected revision inside its existing transaction before writing anything.
Mismatch returns `409 precondition_failed`, reason `restore_revision_changed`. With `require_empty:true`,
the current mutation revision must be zero; successful historical writes are not an unused destination.
Any issue, relation, comment, setting, memory, retained vocabulary, journal/tombstone or stored project
identity refuses the transaction with reason `restore_destination_not_empty`. The first recovery batch
uses this guard; subsequent bounded batches use `require_empty:false` and the previous response's
`x_mutation_revision`. A race refuses that batch without overwriting the intervening writer; earlier
accepted batches remain committed. Stop and inspect on a timeout or refusal, never automatically retry
an uncertain write. The tool restores only to an explicitly selected exclusive, unused destination.

Guarded replace import also accepts `vocabulary:{statuses:[{name,category}],types:[name]}`. This restores
the exact effective projections independently of stored config rows: upstream unset can leave a custom
vocabulary present even when its declaration key is absent. Both vocabularies are validated before
either is projected and before records are validated against them. This field requires the restore
guard; existing unguarded imports and clients keep their previous behavior.

The guard does not restore source event sequence numbers, fencing tokens, verified claim principals,
idempotency receipts, API keys, OAuth grants or Worker secrets. A logical snapshot archives the source
journal separately and recovery produces new import events. See [operations.md](operations.md) for
quiescence, private custody, lease handling, batch limits and the distinction from object-wide PITR.

### Bulk export (`profile.issues_export`, `profile.dependencies_export`, scope `beads:read`)

The read twin of the import route, for a client that has to read a whole tracker (a JSONL export, a
migration check, a listing that decorates every row) without one request per issue.

`GET /t/{tracker}/v0/beads/issues:export` pages the issues of a tracker in **id order** with a keyset
cursor (`next_cursor`, opaque; `has_more` says whether another page follows). `limit` is 1 to 500,
default 200. Each item is the record `issues:import` accepts: the `Issue` members, `labels`,
`dependencies` (`issue_id`, `depends_on_id`, `type`, `metadata`, `created_at`, `created_by`) and
`comments` (`id`, `author`, `text`, `created_at`, oldest first), plus the derived members a listing
carries (`dependency_count`, `dependent_count`, `comment_count`, `parent`), which an import ignores.
`is_blocked` is emitted only with `blocked=true`, because it costs a walk of the dependency graph, and `revision` (the value `getIssue` carries) only with `revision=true`, because it differs between a source and its copy. A
comment id is the id the comment had where it was written: an id an import prefixed is returned without
the prefix, so export, import and export again yield equal records.

The record is the **stored** one, which is more than a listing shows: a lease (`lease_expires_at`) and a
`heartbeat_at` are carried whatever the row's status (the listing shows them on an in-progress row only), and an
`external_ref` that is the empty string is carried as `""` where `null` stays absent. So importing an export page
into the same tracker reports every record `unchanged`, whatever its status or lease fields. (The two members are
the only places an export differs from a listing; a lease on a row that is not in progress is a stored state
an import can create, not a claim.)

- **Filters**: every filter of `listIssues` (`status`, `type`, `assignee`, `label`, `label_any`,
  `exclude_label`, `parent`, `created_before`, `created_after`, `metadata_field`, `has_metadata_key`,
  `include_templates`, `include_gates`, `include_infra`, `include_ephemeral`) with the same meaning,
  plus `updated_after` and `updated_before` (RFC 3339) and `ids` (comma separated, at most 100).
  The one difference from the listing: with no `status` the read covers every status, closed and pinned
  rows included; naming a status narrows it exactly as the listing does.
- **Bounded**: a page holds at most `limit` rows and stops early once its weight reaches 4 MiB, so
  `has_more` can be true on a short page. The weight is the UTF-8 **bytes** (SQLite's `length` counts characters,
  and is not used) of every text the page emits: all text columns of a row (title, bodies, metadata, the
  verbatim core members, assignee, close reason, ...), every label, every edge (target, type, metadata, creator)
  and every comment (id, author, text), plus a fixed allowance for the JSON around them. A page always holds at
  least one row, so a single record larger than 4 MiB is returned alone. Only that page is read into memory.
- **No snapshot isolation across pages**: a cursor names the last id returned and the next page reads the
  tracker as it is then. A row inserted with an id before the cursor is not seen by a walk that is already
  past it, a row changed meanwhile is seen in the state of the page that carried it, and a row deleted before
  its page is simply absent. A client that needs a consistent copy reads while the tracker is quiet, or reads
  again with `updated_after` set to the time its walk began.
  A cursor stays valid while rows are added or changed.
- Strict parameters apply (unknown ones are `400`); a `limit` outside 1 to 500 is `400`.

`GET /t/{tracker}/v0/beads/dependencies:export` pages every stored edge (`items` as in
`listDependencies`, including edges whose target is not an issue here) ordered by issue and target, with
`limit` 1 to 5000 (default 1000), the optional filter `type` (comma separated) and the same cursor
envelope. It is the read for "every edge of the tracker" without naming the issues. Its pages are cut by the
same 4 MiB UTF-8 weight (edge metadata is unbounded text) and have the same lack of snapshot isolation.

### Create and patch members, and `x_extra` (`profile.x_extra`)

The members the upstream spec defines are all accepted and stored; nothing else is, except the extensions below.

- `createIssue` (`CreateIssueRequest`): `actor`, `id`, `title`, `description`, `design`, `acceptance_criteria`,
  `notes`, `issue_type`, `status`, `priority`, `assignee`, `owner`, `labels`, `estimated_minutes`, `external_ref`,
  `due_at`, `defer_until`, `sender`, `metadata`, `ephemeral`, `no_history`, `parent_id`,
  `inherit_labels_from_parent`, `dependencies` (`target_id`, `type`, `reverse`, `metadata`), `waits_for`
  (`spawner_id`, `gate`), `force_id_prefix`; extensions: `preserve_timestamps` with `created_at`, `started_at`,
  `closed_at`, `original_created_by` (see "Mirroring"), and `x_extra`.
- `batchCreateIssues` items: `title`, `description`, `design`, `acceptance_criteria`, `priority`, `issue_type`,
  `assignee`, `labels`, `dependencies` (`target_id`, `type`); extension `x_extra`.
- `applyBatch` `create` items: `key`, `id`, `title`, `description`, `design`, `acceptance_criteria`, `notes`,
  `issue_type`, `status`, `priority`, `assignee`, `owner`, `labels`, `estimated_minutes`, `external_ref`, `due_at`,
  `defer_until`, `sender`, `metadata`, `ephemeral`, `no_history`, `metadata_refs`; extensions `x_extra`,
  `x_parent_id` and `x_inherit_labels_from_parent` (see below). Edges are `dep_add` items, `reverse` is a
  `dep_add` whose `source` is the other issue, and edge `metadata` is the `dep_add` member of that name.
- `updateIssue` `patch` (`IssuePatchBody`): `title`, `description`, `design`, `acceptance_criteria`, `notes`,
  `append_notes`, `priority`, `issue_type`, `status`, `assignee`, `parent_id`, `labels`, `add_labels`,
  `remove_labels`, `estimated_minutes`, `external_ref`, `due_at`, `defer_until`, `metadata`; extension `x_extra`.
  The `applyBatch` `update` patch (`ApplyPatchBody`) has the same members with `owner` and the nested
  `labels` edit instead of `parent_id`, `add_labels` and `remove_labels`; extension `x_extra`.

The upstream bodies have no member for the core `Issue` members a client may read (`spec_id`, `wisp_type`, `mol_type`,
`is_template`, the event members, ...), so a client that mirrors a store through them would drop those silently.
`x_extra` is an object on the create and patch bodies above that carries them under their core names and types:
strings `spec_id`, `source_system`, `compacted_at_commit`, `wisp_type`, `storage_class`, `await_type`, `await_id`,
`source_formula`, `source_location`, `mol_type`, `work_type`, `event_kind`, `actor`, `target`, `payload`; non-negative
integers `compaction_level`, `original_size`, `timeout`; booleans `is_template`, `pinned`; `compacted_at` (RFC 3339),
`waiters` (strings) and `bonded_from` (`{source_id, bond_type, bond_point?}`). Any other member is `400`
(`param: x_extra.<name>`). On create no member is nullable; a non-empty `wisp_type` makes the issue ephemeral unless
it is `no_history`, as upstream does. In a patch the given members are merged into the stored ones and an
explicit `null` removes a member (`pinned: null` is `false`). They are stored in the `extra` column (`pinned` in
its own) and emitted verbatim by every read, as an import stores them.

### Plan extensions (`profile.apply_batch_extensions`)

`applyBatch` has four item kinds (`create`, `update`, `close`, `dep_add`). A whole `bd` transaction also removes an
edge, comments and writes settings, so four more kinds run in the same atomic, ordered plan (any refused item
rolls back all of them). Each is `{kind, <kind>: {...}}` with exactly the payload its kind names, like the core
kinds, and refs (`{key}` backward, or `{id}`) as everywhere in a plan:

| Kind | Payload | Does | Result item |
|---|---|---|---|
| `x_dep_remove` | `{source: Ref, target: Ref}` | Removes the edge between them (journals `dep_remove`). | `{kind, issue_id: source, depends_on_id: target, changed, revision: "0"}`; `changed` is `false` when there was no edge |
| `x_comment` | `{target: Ref, text}` | Adds a comment as `addComment` does (author is the verified principal; the plan's `actor` is `x_client_actor`). | `{kind, issue_id, changed: true, revision}` |
| `x_set_config` | `{key, value}` | Writes a setting as `POST /config` does (`issue_prefix` allowed; `status.custom` and `types.custom` project, and later items of the plan see them). | `{kind, key, changed, revision: "0"}` |
| `x_unset_config` | `{key}` | Removes a setting as `DELETE /config/{key}` does. | `{kind, key, changed, revision: "0"}` |

`create` items also take `x_parent_id` (a `Ref` to the parent: a child id `<parent>.<n>` is minted under it and a
`parent-child` edge written) and `x_inherit_labels_from_parent` (boolean, copies the parent's labels). The spec's
`create` item has neither, because it spells a parent as a `dep_add` and mints a hash id; these two exist so a
child keeps a hierarchical id inside one plan.

### Operator surface

- `GET /admin/trackers` (administrators only): one entry per tracker with `issues`, `by_status`,
  `memories` and `settings` counts, to verify a migration without SQL.
- `POST /t/{tracker}/v0/beads/config` with `{key, value}` is kept from the first release
  (`profile.config_post`); unlike `PUT /config/{key}` it may write `issue_prefix`.
- Capability tokens `profile.heartbeat` (`POST /issues/{id}:heartbeat`) and `profile.leases_reclaim`
  (`POST /leases:reclaim`) declare the two lease routes that were served without a token.

### Other extension members

- `ContextResponse.x_store_version` and `x_min_client_version`: the store's release version and the oldest bd backend it still
  serves, both `MAJOR.MINOR.PATCH`. They are not part of the upstream document; the bd backend in this repository compares
  them with its own version on connect (see [`compatibility.md`](compatibility.md)). A client that ignores them still works.
- `EventRecord.x_event_type`: the upstream audit event type (`created`, `claimed`, `unclaimed`,
  `closed`, `reopened`, `commented`, `dependency_added`, `dependency_removed`, plus `lease_renewed`).
  Re-adding an edge with different stored metadata appends a `dep_add` event; an identical re-add does
  not.
- `EventRecord.x_client_actor`: the `actor` (or `author`) the caller asserted in the request body,
  kept for provenance only; never used for authorization.
- `Problem.reason` on `409` responses (`idempotency_key_reused`, `version_conflict`, `stale_claim`).

### Mirroring (`preserve_timestamps`)

`createIssue` accepts `preserve_timestamps: true`, and then `created_at`,
`started_at`, `closed_at` and `original_created_by`. This exists for mirroring a
store that already has a history: a tracker whose issues all carry the day it was
mirrored has lost the only thing staleness, `bd list --sort updated` and every
age-based report read.

Without the opt-in, sending any of those four members is refused with
`invalid_argument` naming the field, rather than accepted and dropped. `updated_at`
is not a member: it is always written equal to the effective `created_at` on
create, exactly as the core does.

`original_created_by` overrides `created_by` only. Without it the verified
principal is still the actor of every event, and `x_client_actor` keeps whatever
the caller asserted — the store does not let a mirror forge authorship.

This is a migration path, not a general edit capability: `updateIssue` still
cannot move a timestamp.

## Agent API keys

Besides OAuth access tokens, `/mcp` and `/t/*` accept **server-issued opaque bearer tokens**: agent API
keys of the form `bcf_<keyId>_<secret>`. This is a compatibility feature outside the MCP authorization
profile, which prefers OAuth tokens issued by the authorization server for the resource (the provider
documents the same caveat for external tokens). The split is deliberate: humans and interactive clients
use OAuth; unattended agents use keys, because they cannot open a browser. Keys are issued and
validated by this server only, bound to this resource, never forwarded anywhere, and never logged.

- A key is team scoped, has scopes `beads:read` (always) and optionally `beads:write`, an optional
  tracker allowlist (another tracker is `403`, code `forbidden`, `param: tracker`; an extension to the
  Problem code vocabulary), an optional expiry, and can be revoked. A revoked, expired or unknown key is
  `401`; a key without `beads:write` gets the `403 insufficient_scope` challenge on a write, though it
  cannot step up the way an OAuth client can.
- The principal is `{ sub: "key:<id>", email: "agent:<label>", name: <label> }`. It is the actor of
  every event and `created_by`, exactly like an OAuth user's email.
- `X-Beads-Agent` (optional, at most 255 characters) is a client-asserted agent or session name. It is
  recorded as `x_client_actor` on events, replacing the asserted `actor` there, and never as the
  principal.
- Scopes are `beads:read`, `beads:write` and `beads:import` (see "Import").
- Management (`POST`, `GET`, `DELETE` on `/admin/keys`) needs the `ADMIN_TOKEN` Worker secret, accepted
  on `/admin/*` only (it is rejected on `/mcp` and `/t/*`), or an OAuth user listed in `ADMIN_EMAILS`
  with `beads:write`. These routes are not part of the upstream contract.

## MCP

`/mcp` serves tools that wrap the same operations: `tracker_context`, `bead_get`, `bead_list`,
`bead_ready`, `bead_create`, `bead_update`, `bead_close`, `bead_reopen`, `bead_claim`,
`bead_claim_next`, `bead_release`, `bead_comment_add`, `bead_dependency_add`,
`bead_dependency_remove`, `memory_get`, `memory_list`, `memory_put`, `memory_forget`, `bead_history`.
Results are the operation's JSON body as structured content; failures set `isError` and carry the
Problem body. Write tools take `mutation_id`. Defaults of the tool layer (not of the HTTP contract):
`issue_type` `task`, `priority` 2.
