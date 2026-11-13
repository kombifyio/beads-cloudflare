# Operating and recovering a tracker

Use the store's authenticated API and scoped credentials. A tracker is one logical namespace inside the team's SQLite Durable Object, which also holds API-key digests and idempotency receipts; the OAuth provider uses a separate Workers KV namespace. Record the deployed source/version, Worker name, account, Durable Object class/migration history, team name, KV namespace, repository policy and non-secret origin. Keep Worker secrets in a secret store you control and never copy credentials into an archive, command argument, issue, chat or build log.

## Recurring analysis and updates

Start with authenticated `context` and check the capabilities you intend to use.
Do not assume that every deployed store supports the newest profile. The HTTP
routes below are relative to `/t/{tracker}/v0/beads/`; the MCP tools use the same
authorization and domain operations. API details and limits are in
[the profile](profile.md#compact-analysis-and-incremental-changes).

| Task | HTTP | MCP |
| --- | --- | --- |
| Compact inventory | `GET issues:analysis?limit=200` | `bead_analysis` |
| Incremental inventory | `GET issues:changes?since=<head>&since_revision=<revision>` | `bead_changes` |
| Discover an interrupted plan | `GET operations` | `bead_operation_list` |
| Read a plan and committed results | `GET operations/{id}` | `bead_operation_inspect` |
| Register an immutable plan | `POST operations` | `bead_operation_create` |
| Apply only its next chunk | `POST operations/{id}:advance` | `bead_operation_advance` |

1. Read every analysis page with its returned cursor. Retain tracker, project,
   authenticated principal, revision, event head and complete rows in a
   private checkpoint. A 409 Problem with code `precondition_failed` and reason
   `revision_changed` requires discarding the partial observation and restarting,
   retaining the last complete checkpoint. The native portfolio client permits
   two such restarts per tracker across delta and full reads, then fails; its
   `revision_restarts` metric counts the restarts. Other errors fail the read.
   Separate trackers have separate revisions; their combined report is not a transaction.
2. Use an unfiltered, complete tracker checkpoint for delta materialization;
   changes are tracker-wide and carry no status/ID filter. Apply selection
   filters to the materialized view afterwards. A filtered analysis alone is
   not a complete delta baseline. On the next run, request changes from that
   complete checkpoint. Keep both original
   `since` parameters on continuation pages, apply changed rows and tombstones,
   then publish the new checkpoint atomically. `full_refresh_required` means
   obtain a complete analysis again; never fill a gap with stale rows. Recheck
   current authorization before reusing cached data.
3. Fetch the full issue and dependency details needed for the work being reviewed.
   Compact rows omit timestamps, labels, descriptions, comments, dependencies and
   full acceptance text, and may truncate titles. Fence additional reads against
   the tracker revision before reusing them. A compact listing is not an audit.
   A prerequisite's status can change a dependent's derived blocked state without
   changing that dependent's row revision; refresh that state or exclude it from
   a cache intended only for reports. Evaluate lease expiry at the current time.
4. Compose only verified, authorized mutations with their existing preconditions.
   For several chunks, generate and retain an operation ID before registering
   the plan. Registration returns its immutable hash and expected progress.
   Persist the acknowledged identity before advancing. Each successful advance
   commits the chunk's effects, result and next position atomically.
5. After a timeout or process interruption, inspect the same operation, including
   every result page. Discover it through the operation list if the local handle
   was lost. Verify the plan identity and committed results, then advance only
   the reported next chunk. Never repeat a committed chunk or recreate an
   uncertain plan. A revision conflict requires inspection and a new plan for
   remaining work; it never authorizes automatic rebasing. Operation access
   requires current write scope and the original principal/tracker binding.

Record actual acceptance results in the validated `beads_evidence` metadata member.
Its criterion digest is SHA-256 of the exact UTF-8 acceptance text, without
normalization; include source identity, environment, run and observation time.
Changed criteria make historical evidence stale. A recorded pass is a claim to
review, not an automatic issue close or proof of deployment.

Keep detail caches outside publicly served paths, restrict their permissions and
persist them across disposable jobs. A corrupt cache may be rebuilt from a full
authenticated remote read; failed reads must not replace the last good report.
Measure initial population, unchanged deltas and changed deltas separately: the
first compact-plus-detail read can cost more than a full export. Record calls,
payload bytes and elapsed time alongside revision and membership checks, and do
not infer semantic coverage from transport speed.

## Logical backup

Stop agents, imports, CI writers and maintenance for the source tracker; `--quiesced` records that assertion and stops nothing. Provide `BEADS_CLOUDFLARE_BASE` and `BEADS_SNAPSHOT_TOKEN` as environment variables from a secret store; the token needs `beads:read`, `beads:write` and `beads:import`, restricted to the source and destination trackers with a finite expiry. The tool needs no admin token or Cloudflare credentials.

```sh
node scripts/tracker-snapshot.mjs backup /private/alpha.snapshot.json --tracker alpha --quiesced
node scripts/tracker-snapshot.mjs verify /private/alpha.snapshot.json
```

The archive holds full issue records, labels, comments, all dependency edges, memories, every stored configuration row (including hidden `kv.*` rows and original values of normally redacted settings, so it is confidential), project identity, the effective custom status/type vocabularies and the source event journal in order, deletions included. The tool reads the tracker until two passes agree (a memory or configuration write is detected even without an issue event). A tracker that fits in the 64 MiB resident budget is one `beads-cloudflare.logical-snapshot/v1` file. A larger tracker is a `beads-cloudflare.logical-snapshot/v2` manifest at the path you named plus part files in the sibling directory (`alpha.snapshot.json` and `alpha/part-00000.json`, …). The parts together are the full state and the full journal; history is not trimmed to fit. If a later pass differs, the parts are removed and no manifest is left. Metadata keeps the source store version, available source SHA and captured revision.

Files are created exclusively, never overwritten, mode 0600 or an owner-only Windows ACL applied before data is written. The SHA-256 envelope detects accidental corruption, not an attacker who can replace the archive and recompute the digest: keep archives and receipts in private storage, apply retention and encrypt off-device copies. Verification sends nothing to a service.

Native durable operations and their principal-bound results are not part of logical snapshot v1/v2. An operation-only tracker is still discovered and gets an empty logical-state archive, not a restorable operation receipt. Preserve the existing Durable Object for operation inspection, or use Cloudflare's whole-object recovery (below) when those records must survive a disaster. After logical recovery, fetch a fresh analysis checkpoint; old incremental cursors are not valid against the restored tracker. Never recreate or advance an uncertain operation from a logical archive; a client that keeps its own operation receipts inspects them against the restored state without replaying them.

## Scheduled backups

A deployment can bind `CF_VERSION_METADATA` (Workers version metadata) and tag each immutable Worker version with the 40-character commit SHA it was built from. The scheduled reader then stamps that SHA into each archive's metadata; it does not pass through the HTTP entrypoint's source stamping. A present binding with a tag that is not a SHA refuses the backup. Without the binding (the default of `cloudflare.config.ts`) archives record the source SHA as unavailable. Existing archives remain immutable; a later deployment never supplies their missing source identity retroactively. The tag identifies the scheduled Worker, not a separate Durable Object rollout revision; deployment skew does not establish a data-schema revision.

With an R2 bucket bound as `BACKUP_BUCKET`, scheduled sweeps write one archive per nonterminal tracker and UTC day, starting at the configured hour. Discovery includes retained events, mutation revisions, project identity, custom vocabulary, native operation plans/results and analysis fences after the last issue, memory or setting is deleted; portfolio counts continue to describe active records. A tracker that fails, or is written while it is read, is read again by the later runs of the same UTC day (see the retry queue below); only a tracker that fails every attempt of the day fails the sweep. The manifest object is `snapshots/<tracker>/<YYYY-MM-DD>.snapshot.json`. A tracker that fits in the resident budget is that one v1 object. A larger tracker is a v2 manifest at the same key plus `snapshots/<tracker>/<YYYY-MM-DD>/part-NNNNN.json`. Each part stays inside the 64 MiB object budget; the Worker holds one part at a time and does not raise its memory limit. The part set is the full semantic state and the full journal in order. `node scripts/tracker-snapshot.mjs verify|restore` reads a v1 file, or a v2 manifest and its sibling part directory, unchanged. The Worker reads through its own API under an internal read identity. A tracker is read twice and both reads must agree: a v1 archive is written after the second read, a v2 part is uploaded while the second read verifies it against the first, and the manifest is written only after the whole second read agrees. Each read is bracketed by the tracker's mutation revision, so a write during either read ends the attempt with no manifest (a part from a failed attempt is deleted); a writer cannot make an archive inconsistent, only make an attempt fail. Writing is allowed while a tracker is backed up. Each upload carries the body's SHA-256, which R2 checks, and the payload digest in its metadata. Retention deletes expired manifests and parts that belong only to them, and always keeps the newest manifest of each tracker together with its parts.

The template schedules one hourly full-maintenance cron, `17 * * * *`. A deployment with many trackers can add backup-only sweeps, for example at minutes 7, 27, 37, 47 and 57. `BACKUP_SWEEP_ONLY_CRONS` is an optional `|`-separated list of exact cron expressions; an empty list or nonmatching cron runs full maintenance. Duplicate entries, entries without five single-space-separated fields, or the reserved `17 * * * *` log `store_schedule_config_invalid` and run full maintenance. `store_schedule_dispatch` records the actual cron and selected mode. For Wrangler configurations, the deploy-config check requires every listed expression to be a configured trigger and at least one trigger to remain full maintenance. Deployments bypassing that check must preserve a full-maintenance trigger; the Worker cannot discover its configured trigger inventory at runtime. A cron string mismatch also falls back to full maintenance.

With that six-slot schedule and the default start hour a UTC day offers at most 126 invocations and 16128 checks, not 16128 distinct trackers: retries, rechecks, time limits, failures and scheduler delays reduce capacity. Completion for a particular inventory and workload is not guaranteed. A deployment can request more CPU time with `limits.cpu_ms` (for example `60000`, which then applies to every invocation, HTTP requests included); that is a ceiling, not a guarantee that a cron invocation receives it. Check your plan's limits and the observed headroom yourself. Extra schedules also add invocation, R2 and Durable Object usage; see [costs and limits](costs-and-limits.md).

Each invocation checks at most 128 tracker manifests and starts no further tracker after four minutes; the CPU limit is unchanged. Six invocations an hour admit 768 checks/hour, with the four-minute wall budget still able to stop a run earlier. The 17-minute lease remains longer than the 15-minute cron limit: an interrupted invocation can skip the following ten-minute slot, preserving fencing. The forward cursor checks durable trackers before ephemeral trackers. A changed inventory triggers a bounded HEAD audit of the already passed prefix, with half the check/time budget reserved for forward work. A completed, unchanged inventory is not traversed again. The first resume of an old `sweep_failed` record audits the prior prefix once because that legacy flag did not retain the failed tracker identities.

The schema-validated `backup-progress/scheduled.json` stores the UTC day, cursors, pending tracker, inventory digest, retry outcomes, completion timestamp and 17-minute lease. Atomic R2 ETag conditions serialize invocations; an uncertain checkpoint stops the invocation. A tracker checkpoint precedes its HEAD/capture, so interruption cannot skip it. On resume a valid daily archive resolves the interruption without uploading it again. An interrupted missing archive joins the retry queue.

Retries keep the tracker name and attempt count, with exponential backoff from one minute to one hour within the same UTC day. At most twelve failed attempts are allowed automatically. A permanent error or exhausted retry remains named as `exhausted` in progress; it never resets the traversal. `store_backup_failed` names the tracker and fails that invocation. Subsequent progress logs retain the exhausted tracker names, and the existing missed-heartbeat/backup-age alert remains down until every tracker is archived. Independently stored `backup-progress/outcomes/<day>/<tracker>.json` records each tracker's latest archived/retry/failed outcome; if that supplementary object cannot be written, `store_backup_outcome_failed` names it, while the archive or retry checkpoint still settles the tracker. A success removes only that tracker from the retry queue. No transient day-wide failure flag can invalidate other successful archives.

Operators use **POST `/admin/backups/sweep`** to start or resume one bounded invocation for the current UTC day, including before the scheduled start hour. It explicitly retries exhausted trackers once; automatic retries retain their bound. Repeat the operation while state reports pending work. **GET `/admin/backups/sweep`** reports the saved progress, named retry/exhausted trackers, completion timestamp, check budget and existing heartbeat marker's day/upload time. Both require the existing admin-token or operator OAuth admin authorization. An active lease refuses overlap; no force or lease-steal operation is exposed. A failed invocation retains its durable progress for resume.

Retention runs before the sweep in each full-maintenance invocation, including an incomplete sweep or an hour before capture starts; backup-only invocations skip it. Its separate ETag-protected cursor and lease at `backup-progress/retention.json` allow at most 32 list pages, 1024 listed objects, 64 part-manifest HEADs and 30 seconds per invocation. It scans then prunes each tracker, preserving every newest-upload tie and its parts; only recognized dated archives older than the cutoff are removed, so current-day uploads remain safe. A retention failure logs `store_backup_retention_failed`, still allows capture to proceed, and fails the overall scheduled run. The optional `BACKUP_POLICY` JSON sets `hour` (UTC, default 3), `retention_days` (default 30) and `late_tracker_prefixes` (up to 16 tracker-id prefixes, for example of scratch or test trackers, whose trackers the sweep backs up after all others; default none); a malformed value or an unknown member fails the run. `cloudflare.config.ts` takes it from `BEADS_BACKUP_POLICY` and leaves it empty when that variable is absent, so set the variable for every `setup` run that should keep a policy. The optional secret `BACKUP_HEARTBEAT_URL` (an `https://` heartbeat endpoint of an uptime service) is pinged once per UTC day on the first complete, failure-free sweep; the marker `backup-progress/heartbeat.json` holds that day. A failed ping logs `store_backup_heartbeat_failed` and does not fail the backup. Keep the confidential bucket private and limit who can read it. Without the binding no backup runs.

R2 operations that can be repeated without changing the outcome (GET, HEAD, LIST, DELETE, and a PUT of the same bytes to the same archive key) are tried again at most three times with bounded jitter when R2 answers `10001` (InternalError), `10043` (ServiceUnavailable) or `10058` (TooManyRequests); the other errors, and exhaustion, fail that tracker's attempt. `store_backup_r2_retry` identifies each repeat by operation and code, and `store_backup_r2_failed` is logged only when an operation gave up. The progress PUT is not repeatable, because it may have committed before the error reached the Worker. After a retry code the Worker reads the record back: a record equal to the intended one is adopted with its ETag, an unchanged ETag means nothing was written and the same conditional PUT is sent again, and any other record, or an unreadable one, stops the invocation as a changed checkpoint. An invocation stopped this way keeps its lease until it expires; the pending tracker, if its marker was committed, is then counted as an interrupted attempt. A progress write that fails never alters an archive: archives are separate objects, written before the checkpoint that records them, and a previous day's manifest and parts are never opened for writing.

A traversal is not a frozen inventory: a newly discovered tracker behind the cursor joins the next inventory audit, and additions after discovery are not included in that invocation. An existing same-day archive counts only if its R2 HEAD has a recognized format, a SHA-256-shaped digest and a safe integer mutation revision. Invalid metadata fails the sweep without overwriting that object. Download the affected object and check it with `node scripts/tracker-snapshot.mjs verify`; do not delete or overwrite it merely to clear the alert. A later UTC day has a separate archive key and does not repair the earlier object. HEAD checks do not verify archive contents or multipart parts. A sweep log or heartbeat alone is therefore not proof of complete current tracker coverage or a restorable archive; those qualifications remain separate.

To treat a period (for example 48 hours) as backup-healthy, require complete log coverage, no `store_backup_failed`, `store_backup_r2_failed`, `store_backup_interrupted`, `store_backup_retention_failed`, resource-limit exception or abnormal invocation outcome, and at least one completed `store_backup_sweep` with `failed: 0` for every UTC day covered. A day with only `store_backup_pending` or `store_backup_retry_required` is incomplete. A tracker that was contended or hit a retried R2 error and was then archived (`store_backup_contended`, `store_backup_retry_scheduled` and `store_backup_r2_retry` followed by `store_backup_retry_resolved` or the archive's `store_backup`) does not fail the period. Retain each invocation's `checked` and `attempted` counts and its source/version. A cursor that advances does not by itself prove that the schedule keeps up with your inventory.

A cleared `ci-conformance-*` or `restore-drill-*` tracker becomes terminal only with positive ordinary one-day, single-tracker write-key admission, no live explicitly scoped write key, and no remaining issues, memories, settings or custom vocabulary. Keys from the GitHub exchange and keys valid for every tracker do not mark a tracker as a fixture. After R2 acknowledges its manifest, an internal revision watermark removes that unchanged terminal tracker from later daily scans. A new active key or a later mutation re-enlists it. Its newest archive and complete database history remain intact. Ordinary empty trackers continue daily capture. Historical fixtures without this admission evidence remain eligible; a name alone never retires them. `terminal_backup_revision/` scheduler watermarks are not logical snapshot state. Logical restore starts backup discovery afresh; it does not restore terminal retirement or native operation records.

## Logical recovery drill

Reserve a new, unused tracker and an import key limited to it with a short expiry; preserve the source. Quiesce the destination and make sure source claims are released or their leases expired (verified claim principals and fencing numbers cannot be reconstructed from the logical export). Verify the unchanged archive, then:

```sh
node scripts/tracker-snapshot.mjs restore /private/alpha.snapshot.json --tracker alpha-recovery --quiesced --exclusive
```

The tool refuses the source itself, any previously used target, retained vocabulary, journal/tombstone or stored project identity. The first replace-import batch atomically checks emptiness and a zero mutation revision; each later batch checks the preceding acknowledgement's revision (including memory/config changes the issue journal omits). Batches stay within 200 records, 5,000 edges, 5,000 comments and the 16 MiB privileged body limit; an oversized member is refused before any write. Edges to missing/external targets survive batch ordering. A final complete read compares the restored state with the archive.

No uncertain write is retried: a timeout, changed destination or missing acknowledgement stops the tool and reports how many batches were acknowledged (earlier ones may stay committed). Inspect the destination and its journal under the same scoped credential, keep the partial recovery as evidence and use another unused destination for a new attempt; never overwrite an occupied tracker. Clean up a successful drill only through that scoped key and its named scratch tracker, then revoke the key and verify that it is denied.

Recovery creates new import events; it does not replay source event sequence numbers, API keys, verified claim identities/fencing, idempotency receipts, native durable operation plans/results (`operations`, `operation_chunks`), incremental analysis fences (`analysis_changes`) or OAuth grants. Re-establish scoped agent keys and have people sign in again; archived lease times are data, not proof that the old agent owns a new claim. Default issue prefixes derive from the destination tracker when the source had no explicit `issue_prefix`. Verify the affected `bd`/MCP paths before making the recovered tracker active.

`scripts/restore-drill.mjs` runs this drill on a deployed store for one tracker with the administrator token: it mints two one-day keys (import on a new `restore-drill-*` tracker, read on the source), restores a downloaded scheduled archive through `tracker-snapshot.mjs restore`, compares counts and hashes with the archive and with the live source (every issue the journal does not name as changed since the archive must be identical), empties the scratch tracker, revokes both keys and verifies their denial. The scratch tracker's journal stays because the store deletes no tracker. The `beads.restore-drill.v1` receipt holds ids, counts, hashes and timings only.

### Automated recovery journey

`scripts/live-recovery-journey.mjs` exports `verifyLogicalRecovery`, which runs
the drill above end to end against a disposable test deployment. Call it with
`{ base, sourceSha, source: { tracker, token }, destinations: [{ tracker, token }] }`.
`base` must be an HTTPS origin whose host name starts with `preview-`, and
`sourceSha` the exact 40-character commit SHA that deployment reports. It accepts
only the source tracker `cf-test-drill-<sha8>-s` and the destinations
`cf-test-drill-<sha8>-d0` through `-d3`. Each key must have a short expiry,
exactly one tracker and read/write/import scopes. No administrator key takes part.

The source may be reused for a same-SHA retry only when its project identity is
unchanged and all active issues, dependencies, memories, settings and custom
vocabulary are empty. Its journal and mutation revision remain intact. A failed
run that leaves source records requires inspection. The helper selects the first
strictly unused destination before seeding anything, skipping used destinations
through reads only. Exhausting the four destinations fails closed. A restore
that started is never retried, even if its acknowledgement was lost.

The drill seeds two marked issues, one dependency, a Unicode comment, one memory
and one hidden configuration row, then runs the operator CLI's
`backup`, offline `verify` and guarded `restore`. An independent API capture
must match the snapshot's complete semantic state. Successful cleanup deletes
only the known fixture IDs and exact marked memory/configuration keys, verifies
empty active state and retains both journals. Unknown state stops cleanup.
An uncertain destination is preserved for inspection. A mode 0600 ownership
manifest records fixture IDs and keys before seeding, without credentials. The
snapshot is also mode 0600 inside the mode 0700 temporary directory. Both are
retained on failure; successful cleanup removes the private temporary artifacts.

The returned `beads.logical-recovery-journey.v1` receipt contains source SHA,
origin, snapshot digest, source/destination tracker identities, store versions,
mutation revisions, counts, state and journal SHA-256 hashes, cleanup results,
exclusions and elapsed time. `report_sha256` hashes the canonical returned object
before that field is added. It contains no tokens or record contents. A caller
needs the helper, `scripts/tracker-snapshot.mjs`, `src/tracker/snapshot-core.mjs`
and `cli/github-auth.mjs`; all their other imports are Node built-ins.

## Store health and alerts

`GET /admin/health` (administrators only) returns the Durable Object database size (`storage_bytes`), row counts of issues, events, comments and dependencies, the request count, unexpected-failure count and `error_rate`, and write count with mean and maximum write latency, plus the active `thresholds`. Traffic figures cover the interval since the previous sample; an object evicted in between loses that interval's counters, the storage figures are always read from the database. Refusals (4xx problems) are not errors.

The hourly cron samples the store, keeps the series in the OAuth KV namespace under `health:hourly:<UTC hour>` for 30 days, writes one structured `store_health` log line (Workers observability) and, when a threshold is breached, a `store_health_alert` error line and fails the scheduled run so Cloudflare cron-failure notifications fire. Defaults: storage 5 GiB (Durable Object SQLite is capped at 10 GB), growth 512 MiB per day against the sample a day earlier, error rate 5 %, write latency 1000 ms. Override any of `storage_bytes`, `storage_growth_bytes_per_day`, `error_rate`, `write_latency_ms` with the optional `HEALTH_THRESHOLDS` variable, a JSON object; a malformed value keeps the defaults. Signed-in operators (emails in `ADMIN_EMAILS`) also see the latest hourly sample, the day-over-day growth and any breached threshold as a Store health section in the dashboard (`/portfolio/health`, read from the hourly series so it never resets the live counters); everyone else gets `404` and no section.

## Whole-object recovery and credentials

Cloudflare's SQLite Durable Object PITR recovers SQL and object-local KV state for 30 days, for the whole team object (all trackers, key and receipt tables together) and not the separate OAuth KV namespace. Bookmark and scheduled-restore methods exist on `ctx.storage`; this project exposes no public PITR endpoint, and a D1 restore command is no substitute ([SQLite storage/PITR API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)).

Decide a whole-object recovery explicitly, naming the object, the timestamp, the affected trackers and the effect on credentials. Quiesce every writer, keep a fresh logical archive and the current bookmark, run the bookmark recovery through operator code you trust, keep the returned undo bookmark and inspect the restored state before reopening access. Restoring an earlier key table can revive a revoked key: reconcile revocations and issue fresh credentials. Preserve or deliberately invalidate the OAuth KV grants in the same plan. Protect `ADMIN_TOKEN`, `COOKIE_ENCRYPTION_KEY`, the sign-in credentials and access to the Cloudflare account separately; a logical archive is not an OAuth/credential backup.

## Closing with evidence and uncertain writes

Keep a short close reason and attach the full evidence as a comment in one
`issues:batchApply` transaction, or use MCP `beads_close` with `evidence_comment`.
Place the guarded close before `x_comment` so its expected revision refers to the
pre-operation row. Retain the operation key and returned `x_comment_id`; require
independent readback of the closed state, reason and exact comment before recording
completion. See [the profile](profile.md#completion-evidence-and-outcomes).

An explicit `x_outcome: rejected` with `x_mutation_applied: false` proves a refused
transaction did not mutate. Correct that request and submit a new operation. A
timeout, missing acknowledgement or mismatched readback is uncertain. Inspect it
under the same scoped identity before another mutation. Server idempotency receipts
last seven days and belong to the verified principal. The same worker display name
under another credential does not establish the same principal or the same operation.
Reusing an idempotency key with different arguments returns
`reason: idempotency_key_reused` and `x_outcome: unknown`, without a claim that
the mutation was not applied. The original request may already have committed;
inspect its stored result before deciding whether a new operation is needed.

Use context `x_identity` and issue `x_claim` to distinguish credential principal,
worker allocation and lease expiry. Use `/portfolio/actionable` or MCP
`beads_actionable_work` for fresh cross-tracker selection with exclusion reasons and
explicit incomplete-store results. Ordinary `ready` keeps its existing meaning.

## Upgrades

Before upgrading, record the deployed revision/version and take a verified private snapshot under maintenance. Preserve the Durable Object binding, team identity, migrations and OAuth KV binding (changing them can select empty storage). Read compatibility and minimum-client requirements, verify denied access and the smallest affected real flow, then release through the existing path. Prefer a forward fix; use an older artifact only when its schema and its credentials are compatible, and never blindly roll back a database.

## Limits of a logical backup

The tool bounds one response and one archive object at 64 MiB and uses keyset-paged exports. A tracker above that size is stored as v2 parts instead of being held whole; the journal is still complete. Large journals raise read traffic because the tracker is read twice, and a third time when the parts are written. Restores write rows/indexes and append import events; each successful mutation also writes one revision row. OAuth KV, Worker requests/duration and Durable Object SQL storage/reads/writes bill separately: check [Durable Object pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) and [limits](https://developers.cloudflare.com/durable-objects/platform/limits/) before setting retention or scheduling large runs. This is bounded logical recovery, not an unlimited in-memory snapshot. One record that itself exceeds 64 MiB still fails closed. Whole-object PITR remains a separate incident procedure. For the plan, quota and cost picture of a whole store see [costs and limits](costs-and-limits.md).
