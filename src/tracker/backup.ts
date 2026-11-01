// Scheduled logical backup (hourly cron): once per UTC day, each tracker of the team store is captured
// through its own read API and sealed into the operator snapshot format, then written to the optional
// private R2 bucket BACKUP_BUCKET. A tracker that fits in the resident budget is one v1 object. A larger
// one is a v2 manifest plus part objects, each inside the 64 MiB budget, with the journal kept whole.
// `scripts/tracker-snapshot.mjs verify|restore` reads either shape. A tracker that moves between reads
// is retried at the next hourly run; no tracker is mutated. Without the binding nothing runs
// (see docs/operations.md).
import { z } from "zod";
import type { ApiContext } from "../auth/provider";
import { SCOPE_IMPORT, SCOPE_READ, SCOPE_WRITE } from "../auth/scopes";
import { handleTracker, storeFor } from "../http/endpoint";
import { archiveSnapshot, classifySnapshotKey, SNAPSHOT_FORMAT, SNAPSHOT_FORMAT_V2, SNAPSHOT_MAX_BYTES, type SnapshotRequest } from "./snapshot-core.mjs";
import { isObject, isTrackerId } from "./util";
import { isEphemeralBackupTracker } from "./backup-lifecycle";

export const BACKUP_PREFIX = "snapshots/";
const EVENT_PAGE = 1000;
const MAX_TRACKER_CHECKS_PER_RUN = 128;
const PROGRESS_KEY = "backup-progress/scheduled.json";
const PROGRESS_LEASE_MS = 20 * 60_000;
const progressSchema = z.object({
  version: z.literal(1),
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  last_tracker: z.string().max(128).nullable(),
  pending_tracker: z.string().max(128).nullable(),
  retried_tracker: z.string().max(128).nullable().optional(),
  lease_until: z.number().int().nonnegative(),
  run_id: z.string().uuid(),
}).strict();
type BackupProgress = z.infer<typeof progressSchema>;
const MAX_SWEEP_MS = 4 * 60_000;
const SCHEDULED_RESIDENT_BYTES = 8 << 20;

export interface BackupPolicy {
  /** First UTC hour of the day at which the daily backup runs; later hours retry what failed. */
  hour: number;
  /** Snapshots older than this are deleted, except the newest of each tracker. */
  retention_days: number;
}
export const DEFAULT_BACKUP_POLICY: BackupPolicy = { hour: 3, retention_days: 30 };

/** Optional `BACKUP_POLICY` JSON overriding `hour` (0-23) or `retention_days` (1-3650); malformed fails the run. */
export function backupPolicy(env: Env): BackupPolicy {
  if (!env.BACKUP_POLICY) return DEFAULT_BACKUP_POLICY;
  const raw: unknown = JSON.parse(env.BACKUP_POLICY);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid BACKUP_POLICY");
  const policy = { ...DEFAULT_BACKUP_POLICY, ...(raw as Partial<BackupPolicy>) };
  if (Object.keys(raw).some((key) => !(key in DEFAULT_BACKUP_POLICY)) || !Number.isInteger(policy.hour) || policy.hour < 0 || policy.hour > 23 ||
      !Number.isInteger(policy.retention_days) || policy.retention_days < 1 || policy.retention_days > 3650) throw new Error("invalid BACKUP_POLICY");
  return policy;
}

const bytes = (text: string) => new TextEncoder().encode(text).byteLength;
const sha256 = async (text: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, "0")).join("");

async function jsonBody(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("tracker read returned no body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      size += value.byteLength;
      if (size > SNAPSHOT_MAX_BYTES) throw new Error("one tracker response exceeds the snapshot byte budget");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try { return JSON.parse(new TextDecoder().decode(body)); }
  catch { throw new Error("tracker read returned invalid JSON"); }
}

/** In-process reads under an internal identity. Only GET is ever issued; `config:export` needs the import scope. */
export function backupReader(env: Env): SnapshotRequest {
  const ctx = { props: { sub: "store-backup", email: "store-backup", name: "Scheduled backup" }, auth: { scope: [SCOPE_READ, SCOPE_WRITE, SCOPE_IMPORT] } } as unknown as ApiContext;
  return async (tracker, suffix) => {
    const response = await handleTracker(new Request(`${env.PUBLIC_ORIGIN}/t/${encodeURIComponent(tracker)}/v0/beads${suffix}`, { method: "GET" }), env, ctx);
    if (!response.ok) { await response.body?.cancel(); throw new Error(`tracker read refused (${response.status})`); }
    const body = await jsonBody(response);
    if (suffix === "/context" && env.CF_VERSION_METADATA) {
      const version = env.CF_VERSION_METADATA;
      if (!/^[a-f0-9]{40}$/.test(version.tag) || !isObject(body)) throw new Error("scheduled backup requires a source-SHA deployment tag");
      return { ...body, x_source_sha: version.tag, x_worker_version: version };
    }
    return body;
  };
}

async function deleteKeys(bucket: R2Bucket, keys: string[]): Promise<void> {
  for (let i = 0; i < keys.length; i += 1000) await bucket.delete(keys.slice(i, i + 1000));
}

/** Removes a previous failed part upload for this day. The manifest is a different key, so a finished archive is left alone. */
async function deletePrefix(bucket: R2Bucket, prefix: string): Promise<void> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor });
    keys.push(...page.objects.map((object) => object.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  await deleteKeys(bucket, keys);
}

export async function runScheduledBackup(env: Env, now = new Date()): Promise<void> {
  if (!env.BACKUP_BUCKET) return;
  const policy = backupPolicy(env);
  const failures: unknown[] = [];
  try { await pruneSnapshots(env.BACKUP_BUCKET, policy.retention_days, now); }
  catch (error) {
    console.error(JSON.stringify({ event: "store_backup_retention_failed", error: error instanceof Error ? error.message : String(error) }));
    failures.push(error);
  }
  try { await runBackupSweep(env, now); }
  catch (error) { failures.push(error); }
  if (failures.length) throw new AggregateError(failures, "scheduled backup or retention failed");
}

async function runBackupSweep(env: Env, now: Date): Promise<void> {
  const bucket = env.BACKUP_BUCKET;
  if (!bucket) return;
  const policy = backupPolicy(env);
  if (now.getUTCHours() < policy.hour) return;
  const day = now.toISOString().slice(0, 10);
  const started = Date.now();
  const savedProgress = await bucket.get(PROGRESS_KEY);
  if (savedProgress && savedProgress.size > 1024) throw new Error("scheduled backup progress exceeds its byte budget");
  const previous = savedProgress ? progressSchema.parse(await savedProgress.json()) : null;
  if (previous && previous.lease_until > started) throw new Error("scheduled backup sweep already in progress");
  const failed: string[] = [];
  // A tracker cut off mid-archive (the invocation ran out of budget after earlier trackers) is retried
  // once per day, first in the next run with a fresh budget; a second interruption counts as failed.
  let retry: string | null = null;
  if (previous?.pending_tracker) {
    console.error(JSON.stringify({ event: "store_backup_interrupted", day: previous.day, tracker: previous.pending_tracker, run_id: previous.run_id }));
    if (previous.day === day && previous.pending_tracker !== previous.retried_tracker) retry = previous.pending_tracker;
    else failed.push(previous.pending_tracker);
  }
  let progress: BackupProgress = {
    version: 1, day,
    last_tracker: previous?.day === day ? previous.last_tracker : null,
    // A run that stops before reaching the retry leaves it pending for the next run.
    pending_tracker: retry,
    retried_tracker: previous?.day === day ? previous.retried_tracker ?? null : null,
    lease_until: started + PROGRESS_LEASE_MS,
    run_id: crypto.randomUUID(),
  };
  let progressETag = savedProgress?.etag;
  const checkpoint = async (next: BackupProgress) => {
    const { retried_tracker, ...rest } = next;
    const saved = await bucket.put(PROGRESS_KEY, JSON.stringify(retried_tracker ? next : rest), {
      onlyIf: progressETag ? { etagMatches: progressETag } : { etagDoesNotMatch: "*" },
      httpMetadata: { contentType: "application/json" },
    });
    if (!saved) throw new Error("scheduled backup progress changed; sweep stopped");
    progressETag = saved.etag;
    progress = next;
  };
  await checkpoint(progress);
  const read = backupReader(env);
  // Durable trackers sweep before short-lived CI and drill trackers, so a large backlog of those
  // never pushes a large, busy authority tracker past the end of its UTC day.
  const sweepKey = (tracker: string) => (isEphemeralBackupTracker(tracker) ? "1" : "0") + tracker;
  const trackers = (await storeFor(env).backupCandidates())
    .sort((a, b) => sweepKey(a) < sweepKey(b) ? -1 : sweepKey(a) > sweepKey(b) ? 1 : 0);
  const remaining = trackers.filter((tracker) => progress.last_tracker === null || sweepKey(tracker) > sweepKey(progress.last_tracker));
  // The retried tracker never moves the cursor back.
  const queue = retry && trackers.includes(retry) ? [retry, ...remaining.filter((tracker) => tracker !== retry)] : remaining;
  let checked = 0;
  let attempted = 0;
  const acknowledged: { tracker: string; revision: number }[] = [];
  for (const tracker of queue) {
    if (checked >= MAX_TRACKER_CHECKS_PER_RUN || Date.now() - started >= MAX_SWEEP_MS) break;
    const retrying = tracker === retry;
    await checkpoint({ ...progress, last_tracker: retrying ? progress.last_tracker : tracker, pending_tracker: tracker, retried_tracker: retrying ? tracker : progress.retried_tracker });
    checked += 1;
    const key = `${BACKUP_PREFIX}${tracker}/${day}.snapshot.json`;
    try {
      const existing = await bucket.head(key);
      if (!existing) {
        attempted += 1;
        await deletePrefix(bucket, `${BACKUP_PREFIX}${tracker}/${day}/`);
        const archived = await archiveSnapshot(read, tracker, {
          origin: env.PUBLIC_ORIGIN, byteLength: bytes, eventLimit: EVENT_PAGE, now: () => now, sha256,
          residentBytes: SCHEDULED_RESIDENT_BYTES,
          emit: async (item) => {
            const objectKey = item.role === "part" ? `${BACKUP_PREFIX}${tracker}/${day}/${item.name}` : key;
            const source = item.envelope.payload.source;
            // R2 rejects the upload if the stored bytes do not hash to the checksum computed here.
            await bucket.put(objectKey, item.body, { sha256: await sha256(item.body), httpMetadata: { contentType: "application/json" }, customMetadata: {
              digest: item.envelope.integrity.digest, format: item.envelope.payload.format,
              ...(item.role === "part"
                ? { section: String(item.envelope.payload.section ?? "") }
                : { mutation_revision: String(source?.mutation_revision ?? ""), source_sha: source?.source_sha ?? "" }),
            } });
          },
          abort: async (names) => deleteKeys(bucket, names.map((name) => (name === "manifest" || name === "archive" ? key : `${BACKUP_PREFIX}${tracker}/${day}/${name}`))),
        });
        console.log(JSON.stringify({ event: "store_backup", tracker, key, digest: archived.digest, bytes: archived.bytes, parts: archived.parts, format: archived.format, mutation_revision: archived.mutation_revision }));
        acknowledged.push({ tracker, revision: archived.mutation_revision });
      } else if ((existing.customMetadata?.format === SNAPSHOT_FORMAT || existing.customMetadata?.format === SNAPSHOT_FORMAT_V2) &&
                 /^[a-f0-9]{64}$/.test(existing.customMetadata?.digest ?? "") && /^(0|[1-9][0-9]*)$/.test(existing.customMetadata?.mutation_revision ?? "")) {
        const revision = Number(existing.customMetadata?.mutation_revision);
        if (Number.isSafeInteger(revision)) acknowledged.push({ tracker, revision });
      }
    } catch (e) {
      failed.push(tracker);
      console.error(JSON.stringify({ event: "store_backup_failed", tracker, key, error: e instanceof Error ? e.message : String(e) }));
    }
    await checkpoint({ ...progress, pending_tracker: null });
  }
  const terminal = await storeFor(env).acknowledgeTerminalBackups(acknowledged);
  if (terminal) console.log(JSON.stringify({ event: "store_backup_terminal_archived", trackers: terminal }));
  const unchecked = queue.length - checked;
  if (unchecked) {
    console.log(JSON.stringify({ event: "store_backup_pending", day, checked, attempted, unchecked_trackers: unchecked, cursor: progress.last_tracker }));
  } else {
    await checkpoint({ ...progress, last_tracker: null });
    console.log(JSON.stringify({ event: "store_backup_sweep", day, checked, attempted, failed: failed.length }));
  }
  await checkpoint({ ...progress, last_tracker: unchecked ? progress.last_tracker : null, pending_tracker: null, lease_until: 0 });
  if (failed.length) throw new Error(`store backup failed for ${failed.join(", ")}`);
}

const RETENTION_PROGRESS_KEY = "backup-progress/retention.json";
const MAX_RETENTION_PAGES = 32;
const MAX_RETENTION_OBJECTS = 1024;
const MAX_RETENTION_HEADS = 64;
const MAX_RETENTION_MS = 30_000;
const retentionCursor = z.string().max(2048).nullable();
const retentionBase = z.object({ version: z.literal(1), cutoff: z.number().nonnegative(), lease_until: z.number().int().nonnegative(), run_id: z.string().uuid() });
const retentionSchema = z.discriminatedUnion("phase", [
  retentionBase.extend({ phase: z.literal("trackers"), cursor: retentionCursor }).strict(),
  retentionBase.extend({ phase: z.enum(["scan", "prune"]), tracker: z.string().max(128).refine(isTrackerId), cursor: retentionCursor,
    outer_cursor: retentionCursor, newest_upload: z.number().nonnegative().nullable() }).strict(),
]);
type RetentionProgress = z.infer<typeof retentionSchema>;
const oldArchiveDay = (id: string, cutoff: number): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(id)) return false;
  const at = Date.parse(`${id}T00:00:00Z`);
  return Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === id && at < cutoff;
};

/** Independent bounded maintenance: scan one tracker's newest manifest, then prune its old archives. */
export async function pruneSnapshots(bucket: R2Bucket, retentionDays: number, now = new Date()): Promise<void> {
  const started = Date.now(), cutoff = now.getTime() - retentionDays * 86_400_000;
  const saved = await bucket.get(RETENTION_PROGRESS_KEY);
  if (saved && saved.size > 8192) throw new Error("snapshot retention progress exceeds its byte budget");
  const previous = saved ? retentionSchema.parse(await saved.json()) : null;
  if (previous && previous.lease_until > started) throw new Error("snapshot retention already in progress");
  let progress: RetentionProgress = previous
    ? { ...previous, lease_until: started + PROGRESS_LEASE_MS, run_id: crypto.randomUUID() }
    : { version: 1, phase: "trackers", cursor: null, cutoff, lease_until: started + PROGRESS_LEASE_MS, run_id: crypto.randomUUID() };
  let etag = saved?.etag;
  const checkpoint = async (next: RetentionProgress) => {
    const stored = await bucket.put(RETENTION_PROGRESS_KEY, JSON.stringify(next), {
      onlyIf: etag ? { etagMatches: etag } : { etagDoesNotMatch: "*" }, httpMetadata: { contentType: "application/json" },
    });
    if (!stored) throw new Error("snapshot retention progress changed; maintenance stopped");
    etag = stored.etag; progress = next;
  };
  await checkpoint(progress);
  let pages = 0, objects = 0, heads = 0, deleted = 0, complete = false;
  const base = () => ({ version: progress.version, cutoff: progress.cutoff, lease_until: progress.lease_until, run_id: progress.run_id });
  while (pages < MAX_RETENTION_PAGES && objects < MAX_RETENTION_OBJECTS && heads < MAX_RETENTION_HEADS && Date.now() - started < MAX_RETENTION_MS) {
    const current = progress;
    if (current.phase === "trackers") {
      const page = await bucket.list({ prefix: BACKUP_PREFIX, delimiter: "/", limit: 1, cursor: current.cursor ?? undefined });
      pages++; objects += page.objects.length;
      const prefix = page.delimitedPrefixes[0], cursor = page.truncated ? page.cursor : null;
      const tracker = prefix?.slice(BACKUP_PREFIX.length, -1);
      if (tracker && isTrackerId(tracker)) {
        await checkpoint({ ...base(), phase: "scan", tracker, cursor: null, outer_cursor: cursor, newest_upload: null });
      } else {
        await checkpoint({ ...base(), phase: "trackers", cursor, cutoff: page.truncated ? current.cutoff : cutoff });
        if (!page.truncated) { complete = true; break; }
      }
      continue;
    }
    const limit = Math.min(32, MAX_RETENTION_OBJECTS - objects, current.phase === "prune" ? MAX_RETENTION_HEADS - heads : 32);
    const page = await bucket.list({ prefix: `${BACKUP_PREFIX}${current.tracker}/`, cursor: current.cursor ?? undefined, limit });
    pages++; objects += page.objects.length;
    if (current.phase === "scan") {
      let newest = current.newest_upload;
      for (const object of page.objects) {
        const kind = classifySnapshotKey(object.key);
        if (kind?.role === "manifest") newest = Math.max(newest ?? 0, object.uploaded.getTime());
      }
      await checkpoint({ ...current, phase: page.truncated ? "scan" : "prune", cursor: page.truncated ? page.cursor : null, newest_upload: newest });
      continue;
    }
    const expired: string[] = [];
    for (const object of page.objects) {
      const kind = classifySnapshotKey(object.key);
      if (!kind || kind.role === "ignore" || !oldArchiveDay(kind.id, current.cutoff)) continue;
      if (kind.role === "manifest") {
        if (object.uploaded.getTime() < current.cutoff && current.newest_upload !== null && object.uploaded.getTime() < current.newest_upload) expired.push(object.key);
      } else {
        const manifest = await bucket.head(`${BACKUP_PREFIX}${current.tracker}/${kind.id}.snapshot.json`);
        heads++;
        if ((!manifest && object.uploaded.getTime() < current.cutoff) ||
            (manifest && manifest.uploaded.getTime() < current.cutoff && current.newest_upload !== null && manifest.uploaded.getTime() < current.newest_upload)) expired.push(object.key);
      }
    }
    await deleteKeys(bucket, expired); deleted += expired.length;
    if (page.truncated) await checkpoint({ ...current, cursor: page.cursor });
    else {
      await checkpoint({ ...base(), phase: "trackers", cursor: current.outer_cursor, cutoff: current.outer_cursor === null ? cutoff : current.cutoff });
      if (current.outer_cursor === null) { complete = true; break; }
    }
  }
  await checkpoint({ ...progress, lease_until: 0 });
  console.log(JSON.stringify({ event: "store_backup_retention", pages, objects, head_checks: heads, deleted, complete, phase: progress.phase }));
}
