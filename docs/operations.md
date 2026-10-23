# Operating and recovering a tracker

Use the store's authenticated API and scoped credentials. A tracker is one logical namespace inside the team's SQLite Durable Object, which also holds API-key digests and idempotency receipts; the OAuth provider uses a separate Workers KV namespace. Record the deployed source/version, Worker name, account, Durable Object class/migration history, team name, KV namespace, repository policy and non-secret origin. Keep Worker secrets in the operator's secure custody and never copy credentials into an archive, command argument, issue, chat or build log.

## Logical backup

Stop agents, imports, CI writers and maintenance for the source tracker; `--quiesced` records that assertion and stops nothing. Provide `BEADS_CLOUDFLARE_BASE` and `BEADS_SNAPSHOT_TOKEN` through secure environment custody; the token needs `beads:read`, `beads:write` and `beads:import`, restricted to the admitted source/destination trackers with a finite expiry. The tool needs no admin token or Cloudflare credentials.

```sh
node scripts/tracker-snapshot.mjs backup /private/alpha.snapshot.json --tracker alpha --quiesced
node scripts/tracker-snapshot.mjs verify /private/alpha.snapshot.json
```

The archive holds full issue records, labels, comments, all dependency edges, memories, every stored configuration row (including hidden `kv.*` rows and original values of normally redacted settings, so it is confidential), project identity, the effective custom status/type vocabularies and the source event journal in order, deletions included. The tool reads the tracker until two passes agree (a memory or configuration write is detected even without an issue event). A tracker that fits in the 64 MiB resident budget is one `beads-cloudflare.logical-snapshot/v1` file. A larger tracker is a `beads-cloudflare.logical-snapshot/v2` manifest at the path you named plus part files in the sibling directory (`alpha.snapshot.json` and `alpha/part-00000.json`, …). The parts together are the full state and the full journal; history is not trimmed to fit. If a later pass differs, the parts are removed and no manifest is left. Metadata keeps the source store version, available source SHA and captured revision.

Files are created exclusively, never overwritten, mode 0600 or an owner-only Windows ACL applied before data is written. The SHA-256 envelope detects accidental corruption, not an attacker who can replace the archive and recompute the digest: keep archives and receipts in private custody, apply retention and encrypt off-device copies. Verification sends nothing to a service.

## Scheduled backups

With an R2 bucket bound as `BACKUP_BUCKET`, the hourly cron writes one archive per tracker and UTC day, starting at the configured hour and retrying at later hours what failed. The manifest object is `snapshots/<tracker>/<YYYY-MM-DD>.snapshot.json`. A tracker that fits in the resident budget is that one v1 object. A larger tracker is a v2 manifest at the same key plus `snapshots/<tracker>/<YYYY-MM-DD>/part-NNNNN.json`. Each part stays inside the 64 MiB object budget; the Worker holds one part at a time and does not raise its memory limit. The part set is the full semantic state and the full journal in order. `node scripts/tracker-snapshot.mjs verify|restore` reads a v1 file, or a v2 manifest and its sibling part directory, unchanged. The Worker reads through its own API under an internal read identity and writes no manifest if the state moved; parts from a failed write are deleted. So no maintenance window is needed. Each upload carries the body's SHA-256, which R2 checks, and the payload digest in its metadata. Retention deletes expired manifests and parts that belong only to them, and always keeps the newest manifest of each tracker together with its parts. A failed tracker logs `store_backup_failed` and fails the scheduled run, so Cloudflare cron-failure notifications fire; `store_backup` lines record each written archive. The optional `BACKUP_POLICY` JSON sets `hour` (UTC, default 3) and `retention_days` (default 30); a malformed value fails the run. The bucket holds confidential configuration: keep it private (no public or `r2.dev` access) and limit who can read it. Without the binding, and on the Preview, no backup runs.

## Logical recovery drill

Reserve a new exclusive tracker admitted to a finite shared-test import key; preserve the source. Quiesce the destination and make sure source claims are released or their leases expired (verified claim principals and fencing numbers cannot be reconstructed from the logical export). Verify the unchanged archive, then:

```sh
node scripts/tracker-snapshot.mjs restore /private/alpha.snapshot.json --tracker alpha-recovery --quiesced --exclusive
```

The tool refuses the source itself, any previously used target, retained vocabulary, journal/tombstone or stored project identity. The first replace-import batch atomically checks emptiness and a zero mutation revision; each later batch checks the preceding acknowledgement's revision (including memory/config changes the issue journal omits). Batches stay within 200 records, 5,000 edges, 5,000 comments and the 16 MiB privileged body limit; an oversized member is refused before any write. Edges to missing/external targets survive batch ordering. A final complete read compares the restored state with the archive.

No uncertain write is retried: a timeout, changed destination or missing acknowledgement stops the tool and reports how many batches were acknowledged (earlier ones may stay committed). Inspect the destination and its journal under the same scoped credential, keep the partial recovery as evidence and use another unused destination for a new attempt; never overwrite an occupied tracker. Clean up a successful drill only through the admitted key and its named scratch tracker, then revoke the fixture key and verify denial.

Recovery creates new import events; it does not replay source event sequence numbers, API keys, verified claim identities/fencing, idempotency receipts or OAuth grants. Re-establish scoped agent keys and have people sign in again; archived lease times are data, not proof that the old agent owns a new claim. Default issue prefixes derive from the destination tracker when the source had no explicit `issue_prefix`. Verify the affected `bd`/MCP paths before making the recovered tracker active.

`scripts/restore-drill.mjs` runs this drill on a deployed store for one tracker with the administrator token: it mints two one-day keys (import on a new `restore-drill-*` tracker, read on the source), restores a downloaded scheduled archive through `tracker-snapshot.mjs restore`, compares counts and hashes with the archive and with the live source (every issue the journal does not name as changed since the archive must be identical), empties the scratch tracker, revokes both keys and verifies their denial. The scratch tracker's journal stays because the store deletes no tracker. The `beads.restore-drill.v1` receipt holds ids, counts, hashes and timings only.

### Isolated Preview qualification

The protected-main Preview runner imports `verifyLogicalRecovery` from
`scripts/live-recovery-journey.mjs` and calls it with
`{ base, sourceSha, source: { tracker, token }, destinations: [{ tracker, token }] }`.
`base` must be the isolated HTTPS `preview-*` origin and `sourceSha` the exact
40-character deployed SHA. Admit only `cf-test-drill-<sha8>-s` and the finite
`cf-test-drill-<sha8>-d0` through `-d3` pool. Each credential must have a finite
test-session expiry, exact single-tracker scope and read/write/import grants.
The runner verifies exchange expiry; the helper checks authenticated context
scope and expiry when the context exposes it. No production or administrator
credential participates.

The source may be reused for a same-SHA retry only when its project identity is
unchanged and all active issues, dependencies, memories, settings and custom
vocabulary are empty. Its journal and mutation revision remain intact. A failed
run that leaves source records requires inspection. The helper selects the first
strictly unused destination before seeding anything, skipping used destinations
through reads only. Exhausting the four destinations fails closed. A restore
that started is never retried, even if its acknowledgement was lost. Daily
observations skip this drill; only main-push qualification consumes the pool.

The drill seeds two marked issues, one dependency, a Unicode comment, one memory
and one hidden configuration row, then runs the existing operator CLI's
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
before that field is added. It contains no tokens or record contents. The parent
runner retains this receipt under `logical_recovery` in its Preview artifact.
Sparse runners need the helper, `scripts/tracker-snapshot.mjs`,
`src/tracker/snapshot-core.mjs` and `cli/github-auth.mjs`; all their other imports
are Node built-ins.

## Store health and alerts

`GET /admin/health` (administrators only) returns the Durable Object database size (`storage_bytes`), row counts of issues, events, comments and dependencies, the request count, unexpected-failure count and `error_rate`, and write count with mean and maximum write latency, plus the active `thresholds`. Traffic figures cover the interval since the previous sample; an object evicted in between loses that interval's counters, the storage figures are always read from the database. Refusals (4xx problems) are not errors.

The hourly cron samples the store, keeps the series in the OAuth KV namespace under `health:hourly:<UTC hour>` for 30 days, writes one structured `store_health` log line (Workers observability) and, when a threshold is breached, a `store_health_alert` error line and fails the scheduled run so Cloudflare cron-failure notifications fire. Defaults: storage 5 GiB (Durable Object SQLite is capped at 10 GB), growth 512 MiB per day against the sample a day earlier, error rate 5 %, write latency 1000 ms. Override any of `storage_bytes`, `storage_growth_bytes_per_day`, `error_rate`, `write_latency_ms` with the optional `HEALTH_THRESHOLDS` variable, a JSON object; a malformed value keeps the defaults. Signed-in operators (emails in `ADMIN_EMAILS`) also see the latest hourly sample, the day-over-day growth and any breached threshold as a Store health section in the dashboard (`/portfolio/health`, read from the hourly series so it never resets the live counters); everyone else gets `404` and no section.

## Whole-object recovery and authorization custody

Cloudflare's SQLite Durable Object PITR recovers SQL and object-local KV state for 30 days, for the whole team object (all trackers, key and receipt tables together) and not the separate OAuth KV namespace. Bookmark and scheduled-restore methods exist on `ctx.storage`; this project exposes no public PITR endpoint, and a D1 restore command is no substitute ([SQLite storage/PITR API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)).

An admitted recovery needs an explicit incident decision naming object, timestamp, affected trackers and credential effects. Quiesce every writer, keep a fresh logical archive and the current bookmark, run the approved bookmark recovery through trusted operator code, keep the returned undo bookmark and inspect the restored state before reopening access. Restoring an earlier key table can revive a revoked key: reconcile revocations and issue fresh credentials. Preserve or deliberately invalidate the OAuth KV grants in the same plan. Protect `ADMIN_TOKEN`, `COOKIE_ENCRYPTION_KEY`, upstream sign-in credentials and Cloudflare account custody separately; a logical archive is not an OAuth/credential backup.

## Upgrades, costs and limits

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
under another credential does not establish the same principal or operation custody.
Reusing an idempotency key with different arguments returns
`reason: idempotency_key_reused` and `x_outcome: unknown`, without a claim that
the mutation was not applied. The original request may already have committed;
inspect its stored result before deciding whether a new operation is needed.

Use context `x_identity` and issue `x_claim` to distinguish credential principal,
worker allocation and lease expiry. Use `/portfolio/actionable` or MCP
`beads_actionable_work` for fresh cross-tracker selection with exclusion reasons and
explicit incomplete-store results. Ordinary `ready` keeps its existing meaning.

Before upgrading, record the deployed revision/version and take a verified private snapshot under maintenance. Preserve the Durable Object binding, team identity, migrations and OAuth KV binding (changing them can select empty storage). Read compatibility and minimum-client requirements, verify denied access and the smallest affected real flow, then release through the existing path. Prefer a forward fix; use an older artifact only when its schema and custody are compatible, and never blindly roll back a database.

The tool bounds one response and one archive object at 64 MiB and uses keyset-paged exports. A tracker above that size is stored as v2 parts instead of being held whole; the journal is still complete. Large journals raise read traffic because the tracker is read twice, and a third time when the parts are written. Restores write rows/indexes and append import events; each successful mutation also writes one revision row. OAuth KV, Worker requests/duration and Durable Object SQL storage/reads/writes bill separately: check [Durable Object pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) and [limits](https://developers.cloudflare.com/durable-objects/platform/limits/) before setting retention or scheduling large runs. This is bounded logical recovery, not an unlimited in-memory snapshot. One record that itself exceeds 64 MiB still fails closed. Whole-object PITR remains a separate incident procedure.
