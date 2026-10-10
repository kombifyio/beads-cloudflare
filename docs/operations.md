# Operating and recovering a tracker

Use the public store's authenticated API and scoped credentials. A tracker is one logical namespace
inside the team's SQLite Durable Object; API-key digests and idempotency receipts share that object.
The OAuth provider uses a separate Workers KV namespace. Record the deployed source/version, Worker
name, account, Durable Object class/migration history and team name, KV namespace, repository policy
and non-secret origin. Retain Worker secrets in the operator's existing secure custody. Do not copy
credentials into a tracker archive, command argument, issue, chat or build log.

## Logical backup

Stop agents, imports, CI writers and maintenance for the source tracker. `--quiesced` records that
explicit maintenance assertion; it does not stop another process. Supply `BEADS_CLOUDFLARE_BASE` and
`BEADS_SNAPSHOT_TOKEN` through secure environment custody. The token needs `beads:read`, `beads:write`
and `beads:import`, restricted to the admitted source/destination trackers and given a finite expiry.
The snapshot tool never needs an admin token or Cloudflare account credentials.

Run from the installed release or matching source checkout, using an existing private output directory:

```sh
node scripts/tracker-snapshot.mjs backup /private/alpha.snapshot.json --tracker alpha --quiesced
node scripts/tracker-snapshot.mjs verify /private/alpha.snapshot.json
```

The archive holds full issue records, labels, comments, all exported dependency edges, memories, every
stored configuration row, project identity and the exact effective custom status/type vocabularies.
Configuration includes normally hidden `kv.*` rows and the original values of settings ordinarily redacted by reads, so the archive
is confidential. The source event journal is archived in order, including deletion events. The tool
performs two complete reads and requires identical semantic state, journal and tracker revision; a
memory or configuration write is detected even without an issue event. If state changes, no archive
is written. Metadata retains the source store version, available source SHA and captured revision.

Files are created exclusively, never overwritten, with mode 0600 or an owner-only Windows ACL applied
before data is written. The SHA-256 envelope detects accidental corruption or changed bytes; it is
not a signature against an attacker who can replace the archive and recompute its digest. Keep files
and their integrity receipts in controlled private custody, apply your retention policy and encrypt
off-device backups. Verification does not send archive content or credentials to a service.

## Logical recovery drill

Reserve a new, exclusive tracker and admit it to a finite shared-test import key. Preserve the source
tracker. Quiesce the destination and ensure source claims have been released or their leases expired;
verified claim principals and fencing numbers are not reconstructible through the logical export.
Keep the source archive unchanged and verify it before recovery:

```sh
node scripts/tracker-snapshot.mjs restore /private/alpha.snapshot.json --tracker alpha-recovery --quiesced --exclusive
```

The tool refuses the source itself, any previously used target, retained vocabulary, journal/tombstone or
stored project identity. Its first replace-import batch atomically checks emptiness and a zero tracker
mutation revision. Every later batch checks the preceding acknowledgement's revision, including
memory/config changes that the issue journal omits. Batches stay within 200 records, 5,000 edges,
5,000 comments and the 16 MiB privileged body limit; a member too large to import is refused before
any write. Archived records may refer to missing/external targets, so batch ordering does not drop
those edges. A final complete read compares restored semantic state with the archive.

No uncertain write is retried. A timeout, changed destination or missing acknowledgement stops the
tool and reports how many batches were acknowledged. Previous batches may remain committed. Inspect
the destination and its journal under the same scoped credential, retain this partial recovery as
evidence, and use another unused destination for a fresh attempt. Never resume by overwriting an
occupied tracker. Cleanup a successful drill only through the admitted key and its named scratch
tracker; revoke the fixture key through the provisioner's existing custody and verify denial.

Recovery creates new import events; it does not replay source event sequence numbers, API keys,
verified claim identities/fencing, idempotency receipts or OAuth grants. The source journal remains
in the private archive. Re-establish scoped agent keys and have humans sign in again. Archived lease
times and issue fields remain data; do not treat them as proof that the old agent owns a new claim.
Default issue prefixes derive from the selected destination tracker when the source had no explicit
`issue_prefix` setting. Verify the affected `bd`/MCP paths before making the recovered tracker active.

## Whole-object recovery and authorization custody

Cloudflare's SQLite Durable Object PITR can recover its SQL and object-local KV state within the past
30 days. It applies to the whole team object, so all trackers and its key/receipt tables move together.
It does not recover the separate OAuth KV namespace. Cloudflare exposes bookmark and scheduled-restore
methods on `ctx.storage`; this project does not expose a public PITR endpoint. Do not substitute a D1
restore command for Durable Object recovery. See the [SQLite storage/PITR API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/).

An admitted whole-object recovery needs an explicit incident decision naming the object, timestamp,
affected trackers and credential effects. Quiesce every writer to that object, retain a fresh logical
archive and the current bookmark, then execute the approved bookmark recovery through trusted operator
code. Preserve its returned undo bookmark and inspect the restored state before reopening access.
Restoring an earlier key table can revive a previously revoked key; reconcile revocations and issue
fresh credentials. Preserve or deliberately invalidate the separate OAuth KV grants with the same
incident plan. Protect `ADMIN_TOKEN`, `COOKIE_ENCRYPTION_KEY`, upstream sign-in credentials and any
Cloudflare account custody separately. A logical archive is not an OAuth/credential backup.

## Upgrades, costs and limits

Before upgrading, record the exact deployed revision/version and take a verified private snapshot
under maintenance. Preserve the Durable Object binding, team identity, migrations and OAuth KV
binding; changing those can select empty storage. Read release compatibility and minimum-client
requirements, verify denied access and the smallest affected real flow, then release through the
existing deployment path. Prefer a forward fix. Only use an explicitly admitted older artifact when
its schema and custody are compatible; never blindly roll back a database.

The tool bounds response/archive buffering at 64 MiB and uses keyset-paged exports. Large journals
increase read traffic because the complete archive is read twice; archive size is not a fixed daily
cost. Restores write rows/indexes and append new import events; each successful mutation also writes
one revision row. OAuth KV, Worker requests/duration and Durable Object SQL storage/read/write usage
have separate billing dimensions. Check current [Durable Object pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
and [platform limits](https://developers.cloudflare.com/durable-objects/platform/limits/) before setting
retention or scheduling large runs. This utility is bounded logical recovery, not an unlimited
streaming backup service. A snapshot exceeding its limit requires a separately admitted larger
backup design or whole-object incident recovery, not disabling safeguards.
