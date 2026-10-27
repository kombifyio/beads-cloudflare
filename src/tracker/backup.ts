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
import { archiveSnapshot, expiredSnapshotKeys, SNAPSHOT_MAX_BYTES, type SnapshotRequest } from "./snapshot-core.mjs";
import { isObject } from "./util";

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
  let progress: BackupProgress = {
    version: 1, day,
    last_tracker: previous?.day === day ? previous.last_tracker : null,
    pending_tracker: null,
    lease_until: started + PROGRESS_LEASE_MS,
    run_id: crypto.randomUUID(),
  };
  let progressETag = savedProgress?.etag;
  const checkpoint = async (next: BackupProgress) => {
    const saved = await bucket.put(PROGRESS_KEY, JSON.stringify(next), {
      onlyIf: progressETag ? { etagMatches: progressETag } : { etagDoesNotMatch: "*" },
      httpMetadata: { contentType: "application/json" },
    });
    if (!saved) throw new Error("scheduled backup progress changed; sweep stopped");
    progressETag = saved.etag;
    progress = next;
  };
  await checkpoint(progress);
  const failed: string[] = [];
  if (previous?.pending_tracker) {
    failed.push(previous.pending_tracker);
    console.error(JSON.stringify({ event: "store_backup_interrupted", day: previous.day, tracker: previous.pending_tracker, run_id: previous.run_id }));
  }
  const read = backupReader(env);
  const trackers = (await storeFor(env).trackerSummary()).map((t) => t.tracker)
    .sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  const remaining = trackers.filter((tracker) => progress.last_tracker === null || tracker > progress.last_tracker);
  let checked = 0;
  let attempted = 0;
  for (const tracker of remaining) {
    if (checked >= MAX_TRACKER_CHECKS_PER_RUN || Date.now() - started >= MAX_SWEEP_MS) break;
    await checkpoint({ ...progress, last_tracker: tracker, pending_tracker: tracker });
    checked += 1;
    const key = `${BACKUP_PREFIX}${tracker}/${day}.snapshot.json`;
    try {
      if (!await bucket.head(key)) {
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
      }
    } catch (e) {
      failed.push(tracker);
      console.error(JSON.stringify({ event: "store_backup_failed", tracker, key, error: e instanceof Error ? e.message : String(e) }));
    }
    await checkpoint({ ...progress, pending_tracker: null });
  }
  const unchecked = remaining.length - checked;
  if (unchecked) {
    console.log(JSON.stringify({ event: "store_backup_pending", day, checked, attempted, unchecked_trackers: unchecked, cursor: progress.last_tracker }));
  } else {
    await checkpoint({ ...progress, last_tracker: null });
    await pruneSnapshots(bucket, policy.retention_days, now);
    console.log(JSON.stringify({ event: "store_backup_sweep", day, checked, attempted, failed: failed.length }));
  }
  await checkpoint({ ...progress, last_tracker: unchecked ? progress.last_tracker : null, pending_tracker: null, lease_until: 0 });
  if (failed.length) throw new Error(`store backup failed for ${failed.join(", ")}`);
}

/** Deletes expired manifests and the parts that belong only to them. The newest manifest of a tracker, and every part of a kept manifest, stay. */
export async function pruneSnapshots(bucket: R2Bucket, retentionDays: number, now = new Date()): Promise<void> {
  const cutoff = now.getTime() - retentionDays * 86_400_000;
  const objects: { key: string; uploaded: number }[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: BACKUP_PREFIX, cursor });
    for (const object of page.objects) objects.push({ key: object.key, uploaded: object.uploaded.getTime() });
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  await deleteKeys(bucket, expiredSnapshotKeys(objects, cutoff));
}
