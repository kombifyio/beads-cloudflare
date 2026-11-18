# Costs and limits

A store runs entirely in the operator's Cloudflare account and is billed by Cloudflare like any other Worker. This
page lists what a store uses, which limits it runs into first, and how to size the scheduled work. Prices and quotas
change: check Cloudflare's current [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/),
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/),
[Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) and
[limits](https://developers.cloudflare.com/durable-objects/platform/limits/) before you rely on a number.

## What a store uses

| Resource | Used for | Grows with |
|---|---|---|
| One Worker | every HTTP request, MCP call and the scheduled maintenance | requests and CPU time |
| One SQLite-backed Durable Object per team (`TEAM`, default `default`) | all trackers of the team: issues, events, comments, dependencies, memories, settings, API-key digests, idempotency receipts | rows stored, rows read and written |
| One Workers KV namespace (`OAUTH_KV`) | OAuth clients and grants of human sign-in, and the hourly health samples (kept 30 days) | sign-ins, token refreshes, one health write an hour |
| One cron trigger, `17 * * * *` | hourly maintenance: lapsed claims, the health sample, the portfolio snapshot and the backup sweep | one invocation an hour |
| An R2 bucket (optional, `BACKUP_BUCKET`) | daily logical backups, kept 30 days by default (`BACKUP_POLICY.retention_days`) | tracker size times retention |

All trackers of a team share one Durable Object, so its storage limit is the team's limit. `GET /admin/health` reports
the database size; the default alert fires at 5 GiB (`HEALTH_THRESHOLDS.storage_bytes`) so there is room before
Cloudflare's per-object cap. Every successful write also stores an event and one revision row, so the event journal
grows with activity, not only with the number of issues. Idempotency receipts expire after seven days.

## Workers Free or Paid

Durable Objects with SQLite storage are offered on both plans, so a store can be deployed on Workers Free. The
maintainers run it on Workers Paid and have not qualified it on Free. On Free, the daily request quota, the CPU time
per invocation and the Durable Object storage and operation quotas are much lower; the operations most likely to reach
them are a large `bd import`, an export of a large tracker and the hourly backup sweep of a large tracker. If you try
Free, watch the Worker's logs for exceeded-limit errors and the `store_backup_*` events (see
[operations](operations.md#scheduled-backups)).

A deployment can request more CPU time per invocation with `limits.cpu_ms` (Paid only). It then applies to every
invocation, HTTP requests included, and is a ceiling, not a guarantee.

## Request size limits

| Request | Body limit |
|---|---|
| Ordinary writes | 1 MiB |
| Batch and large writes | 4 MiB |
| Merge import (`issues:import`) | 16 MiB, at most 200 records, 5,000 edges and 5,000 comments per batch |
| One response and one archive object | 64 MiB |

Split larger imports into batches; [the profile](profile.md) gives each route's limits.

## The 5120-byte limit per text binding

Cloudflare limits each plain-text variable of a Worker to 5120 bytes. The authorization policy is plain text, and a
store that maps many repositories, each with several GitHub Actions workflows, outgrows that limit first. Three things
keep it small:

- In `GITHUB_REPOSITORIES` a workflow can be named by its bare file name (`ci.yml`) or relative path
  (`.github/workflows/ci.yml@refs/heads/main`) instead of the full `owner/repo/.github/workflows/...` reference; the
  Worker expands it to the same exact main-branch reference.
- Workflow grants that let one repository's workflows read or write another repository's tracker can move to the
  separate `GITHUB_WORKFLOW_GRANTS` binding. It states the owner id, the target repository and the tracker once, and
  maps each caller repository to its workflow file names and their events. The Worker expands it into the same grants
  as the inline form and validates them identically; a malformed value denies every tracker.
- `node scripts/check-deploy-config.mjs` refuses any configuration whose text binding is over 5120 bytes before you
  deploy it.

## Sizing the backup sweep

The scheduled backup writes one archive per tracker and UTC day, starting at `BACKUP_POLICY.hour` (UTC, default 3).
Its cost and duration are bounded per invocation, not per day:

- Each invocation checks at most 128 tracker manifests and starts no further tracker after four minutes.
- Each tracker is read twice; both reads must agree. A tracker larger than the in-memory budget (8 MiB in the
  scheduled reader) is written as a v2 manifest plus parts of at most 64 MiB, and the Worker holds one part at a time,
  so a large tracker costs reads, not memory.
- With the template's one hourly cron and the default start hour a day has 21 runs, so at most 2,688 tracker checks;
  retries, contended trackers and time limits reduce that. A store with more trackers than one day's checks can cover,
  or with trackers that take minutes to read, adds backup-only crons (`BACKUP_SWEEP_ONLY_CRONS`); six runs an hour
  allow 768 checks an hour. Each extra run adds invocations, Durable Object reads and R2 operations.
- Retention runs once per full-maintenance invocation and is bounded to 32 list pages, 1024 listed objects, 64 part
  HEADs and 30 seconds.

[Operations](operations.md#scheduled-backups) describes the sweep, its retry queue and its alerts in full.
