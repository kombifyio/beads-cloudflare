// Scheduled logical backup: once per UTC day, each tracker of the team store is captured
// through its own read API and sealed into the operator snapshot format, then written to the optional
// private R2 bucket BACKUP_BUCKET. A tracker that fits in the resident budget is one v1 object. A larger
// one is a v2 manifest plus part objects, each inside the 64 MiB budget, with the journal kept whole.
// `scripts/tracker-snapshot.mjs verify|restore` reads either shape. A tracker that moves between reads
// is read again at once and, if it keeps moving, at the next scheduled runs; no tracker is mutated. Without
// the binding nothing runs (see docs/operations.md).
import { z } from "zod";
import type { ApiContext } from "../auth/provider";
import { SCOPE_IMPORT, SCOPE_READ, SCOPE_WRITE } from "../auth/scopes";
import { handleTracker, storeFor } from "../http/endpoint";
import { archiveSnapshot, classifySnapshotKey, SnapshotChangedError, SNAPSHOT_FORMAT, SNAPSHOT_FORMAT_V2, SNAPSHOT_MAX_BYTES, type SnapshotRequest } from "./snapshot-core.mjs";
import { isObject, isTrackerId } from "./util";
import { isEphemeralBackupTracker } from "./backup-lifecycle";

export const BACKUP_PREFIX = "snapshots/";
const EVENT_PAGE = 1000;
export const MAX_TRACKER_CHECKS_PER_RUN = 128;
const PROGRESS_KEY = "backup-progress/scheduled.json";
const HEARTBEAT_KEY = "backup-progress/heartbeat.json";
const PROGRESS_LEASE_MS = 17 * 60_000;
const PROGRESS_MAX_BYTES = 4 << 20;
/** A tracker whose capture failed this many times in one UTC day is failed for good: the run and the sweep report it. */
const MAX_TRACKER_ATTEMPTS = 12;
/** Bounded control record; individual tracker outcomes also have independent R2 objects. */
const MAX_RETRY_TRACKERS = 10000;
/** One run reads a contended tracker a second time at once, only for a capture short enough to repeat inside the cron wall time and the CPU limit. */
const MAX_CAPTURE_ATTEMPTS = 2;
const CAPTURE_RETRY_DEADLINE_MS = 10 * 60_000;
/** R2 InternalError, ServiceUnavailable and TooManyRequests: the provider asks the caller to try again. */
const R2_RETRY_CODES = new Set(["10001", "10043", "10058"]);
/** A capture that took longer than this is not repeated in the same run: its CPU would risk the 60 s limit; the next run has a fresh budget. */
const MAX_CONTENDED_CAPTURE_MS = 60_000;
const retrySchema = z.object({ tracker: z.string().max(128), attempts: z.number().int().min(1).max(MAX_TRACKER_ATTEMPTS), next_attempt_at: z.number().nonnegative().optional(), exhausted: z.boolean().optional() }).strict();
const progressSchema = z.object({
  version: z.literal(1),
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  last_tracker: z.string().max(128).nullable(),
  pending_tracker: z.string().max(128).nullable(),
  /** Trackers that failed today and still owe an archive, with their failed attempts; each is read again by a later run. */
  retry: z.array(retrySchema).max(MAX_RETRY_TRACKERS).optional(),
  /** Written by the previous deployment; read so that its record does not stop the sweep, never used. */
  retried_tracker: z.string().max(128).nullable().optional(),
  durable_recheck_tracker: z.string().max(128).optional(),
  durable_recheck_until: z.string().max(128).optional(),
  durable_recheck_active: z.boolean().optional(),
  durable_inventory_digest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  sweep_failed: z.boolean().optional(),
  completed_at: z.string().optional(),
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
  /** Trackers whose id starts with one of these prefixes (for example scratch or test trackers) are backed up after all others. */
  late_tracker_prefixes: string[];
}
export const DEFAULT_BACKUP_POLICY: BackupPolicy = { hour: 3, retention_days: 30, late_tracker_prefixes: [] };

/** Optional `BACKUP_POLICY` JSON overriding `hour` (0-23), `retention_days` (1-3650) or `late_tracker_prefixes` (up to 16 non-empty strings); malformed fails the run. */
export function backupPolicy(env: Env): BackupPolicy {
  if (!env.BACKUP_POLICY) return DEFAULT_BACKUP_POLICY;
  const raw: unknown = JSON.parse(env.BACKUP_POLICY);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid BACKUP_POLICY");
  const policy = { ...DEFAULT_BACKUP_POLICY, ...(raw as Partial<BackupPolicy>) };
  if (Object.keys(raw).some((key) => !(key in DEFAULT_BACKUP_POLICY)) || !Number.isInteger(policy.hour) || policy.hour < 0 || policy.hour > 23 ||
      !Number.isInteger(policy.retention_days) || policy.retention_days < 1 || policy.retention_days > 3650 ||
      !Array.isArray(policy.late_tracker_prefixes) || policy.late_tracker_prefixes.length > 16 ||
      !policy.late_tracker_prefixes.every((prefix) => typeof prefix === "string" && prefix.length > 0 && prefix.length <= 64)) throw new Error("invalid BACKUP_POLICY");
  return policy;
}

const bytes = (text: string) => new TextEncoder().encode(text).byteLength;
const sha256 = async (text: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, "0")).join("");
const r2ErrorCode = (error: unknown) => error instanceof Error ? error.message.match(/\((\d{5})\)(?:\s|$)/)?.[1] : undefined;
const retryDelay = (attempt: number) => 250 * 2 ** attempt + Math.floor(Math.random() * 200);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A failure that another attempt cannot cure; it is reported at once instead of being retried. */
class PermanentBackupError extends Error {}
const permanentFailure = (error: unknown): boolean => error instanceof PermanentBackupError ||
  (error instanceof Error && /exceeds the [^"]*budget|does not advertise guarded logical recovery|requires a source-SHA deployment tag/.test(error.message));

/**
 * Runs one idempotent R2 operation (get, head, list, delete, or a put of the same bytes to the same key) and tries it
 * again, at most three times, when the provider answers with a retry code. The last failure is logged and thrown.
 */
async function r2Retry<T>(operation: string, run: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      const code = r2ErrorCode(error);
      if (!code || !R2_RETRY_CODES.has(code) || attempt >= 3) {
        console.error(JSON.stringify({ event: "store_backup_r2_failed", operation, code: code ?? null, attempts: attempt + 1 }));
        throw error;
      }
      console.warn(JSON.stringify({ event: "store_backup_r2_retry", operation, code, attempt: attempt + 1 }));
      await sleep(retryDelay(attempt));
    }
  }
}

function archiveRevision(metadata: Record<string, string> | undefined): number | null {
  if ((metadata?.format !== SNAPSHOT_FORMAT && metadata?.format !== SNAPSHOT_FORMAT_V2) ||
      !/^[a-f0-9]{64}$/.test(metadata?.digest ?? "") || !/^(0|[1-9][0-9]*)$/.test(metadata?.mutation_revision ?? "")) return null;
  const revision = Number(metadata?.mutation_revision);
  return Number.isSafeInteger(revision) ? revision : null;
}

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
  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000);
    await r2Retry("delete", () => bucket.delete(batch));
  }
}

const listBackupParts = (bucket: R2Bucket, prefix: string, cursor: string | undefined): Promise<R2Objects> =>
  r2Retry("cleanup_list", () => bucket.list({ prefix, cursor }));

/** Removes a previous failed part upload for this day. The manifest is a different key, so a finished archive is left alone. */
async function deletePrefix(bucket: R2Bucket, prefix: string): Promise<void> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await listBackupParts(bucket, prefix, cursor);
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

export async function runBackupSweep(env: Env, now = new Date(), options: { manual?: boolean } = {}): Promise<void> {
  const bucket = env.BACKUP_BUCKET;
  if (!bucket) return;
  const policy = backupPolicy(env);
  if (!options.manual && now.getUTCHours() < policy.hour) return;
  const day = now.toISOString().slice(0, 10);
  const started = Date.now();
  const archiveKey = (tracker: string) => `${BACKUP_PREFIX}${tracker}/${day}.snapshot.json`;
  const savedProgress = await r2Retry("progress_get", () => bucket.get(PROGRESS_KEY));
  if (savedProgress && savedProgress.size > PROGRESS_MAX_BYTES) throw new Error("scheduled backup progress exceeds its byte budget");
  const previous = savedProgress ? progressSchema.parse(await savedProgress.json()) : null;
  if (previous && previous.lease_until > started) throw new Error("scheduled backup sweep already in progress");
  const sameDay = previous?.day === day;
  const failed: string[] = [];
  // Only trackers still owing an archive are retried; successful archives survive any progress failure.
  const retrying = new Map<string, z.infer<typeof retrySchema>>(sameDay ? (previous?.retry ?? []).map((entry) => [entry.tracker, entry]) : []);
  // The old day-wide flag contains no tracker identities. Audit its already traversed prefix once on upgrade.
  const legacyAudit = sameDay && previous?.sweep_failed === true;
  const outcomePut = async (tracker: string, outcome: object) => {
    try {
      await r2Retry("outcome_put", () => bucket.put(`backup-progress/outcomes/${day}/${tracker}.json`, JSON.stringify(outcome), { httpMetadata: { contentType: "application/json" } }));
    } catch {
      // The archive or retry checkpoint remains authoritative if this supplementary outcome object is unavailable.
      console.error(JSON.stringify({ event: "store_backup_outcome_failed", day, tracker }));
    }
  };
  const fail = async (tracker: string, error: unknown) => {
    const attempts = Math.min(MAX_TRACKER_ATTEMPTS, (retrying.get(tracker)?.attempts ?? 0) + 1);
    const exhausted = permanentFailure(error) || attempts >= MAX_TRACKER_ATTEMPTS;
    const outcome = { tracker, attempts, exhausted, next_attempt_at: now.getTime() + Math.min(3600_000, 60_000 * 2 ** (attempts - 1)) };
    retrying.set(tracker, outcome);
    await outcomePut(tracker, { ...outcome, status: exhausted ? "failed" : "retry", day });
    const event = exhausted ? "store_backup_failed" : "store_backup_retry_scheduled";
    if (exhausted) failed.push(tracker);
    (exhausted ? console.error : console.warn)(JSON.stringify({ event, key: archiveKey(tracker), ...outcome, error: error instanceof Error ? error.message : String(error) }));
  };
  if (previous?.pending_tracker) {
    console.error(JSON.stringify({ event: "store_backup_interrupted", day: previous.day, tracker: previous.pending_tracker, run_id: previous.run_id }));
    // An interrupted attempt is one failed attempt; a pending tracker of an earlier day belongs to that day's sweep.
    if (sameDay) {
      // A lost checkpoint acknowledgement can follow a successful archive; only the archive settles this attempt.
      try {
        const archived = await r2Retry("archive_head", () => bucket.head(archiveKey(previous.pending_tracker!)));
        if (archived && archiveRevision(archived.customMetadata) !== null) retrying.set(previous.pending_tracker, { tracker: previous.pending_tracker, attempts: 1, next_attempt_at: 0 });
        else await fail(previous.pending_tracker, new Error("capture was interrupted"));
      } catch (error) { await fail(previous.pending_tracker, error); }
    }
  }
  let progress: BackupProgress = {
    version: 1, day,
    last_tracker: sameDay ? previous.last_tracker : null,
    pending_tracker: null,
    completed_at: sameDay ? previous.completed_at : undefined,
    durable_recheck_tracker: sameDay ? previous.durable_recheck_tracker : undefined,
    durable_recheck_until: legacyAudit ? previous.last_tracker ?? undefined : sameDay ? previous.durable_recheck_until : undefined,
    durable_recheck_active: legacyAudit ? true : sameDay ? previous.durable_recheck_active : undefined,
    durable_inventory_digest: legacyAudit ? undefined : sameDay ? previous.durable_inventory_digest : undefined,
    lease_until: started + PROGRESS_LEASE_MS,
    run_id: crypto.randomUUID(),
  };
  let progressETag = savedProgress?.etag;
  /**
   * Writes the progress record conditionally on the ETag of the previous write. A provider error is not a verdict: the
   * PUT may have committed. After a retry code the record is read back; a record equal to the intended one is adopted,
   * an unchanged ETag means nothing was written and the same PUT is sent again, and anything else stops the sweep.
   */
  const checkpoint = async (next: BackupProgress) => {
    const record: BackupProgress = { ...next, sweep_failed: false, retry: retrying.size ? [...retrying.values()] : undefined };
    const body = JSON.stringify(record);
    for (let attempt = 0; ; attempt++) {
      let saved: R2Object | null;
      try {
        saved = await bucket.put(PROGRESS_KEY, body, {
          onlyIf: progressETag ? { etagMatches: progressETag } : { etagDoesNotMatch: "*" },
          httpMetadata: { contentType: "application/json" },
        });
      } catch (error) {
        const code = r2ErrorCode(error);
        if (!code || !R2_RETRY_CODES.has(code) || attempt >= 3) {
          console.error(JSON.stringify({ event: "store_backup_r2_failed", operation: "progress_put", code: code ?? null, attempts: attempt + 1 }));
          throw error;
        }
        console.warn(JSON.stringify({ event: "store_backup_r2_retry", operation: "progress_put", code, attempt: attempt + 1 }));
        await sleep(retryDelay(attempt));
        const current = await r2Retry("progress_get", () => bucket.get(PROGRESS_KEY));
        if (current?.etag === progressETag) { await current?.body?.cancel(); continue; }
        if (current && await current.text() === body) { progressETag = current.etag; progress = record; return; }
        throw new Error("scheduled backup progress changed; sweep stopped");
      }
      if (!saved) throw new Error("scheduled backup progress changed; sweep stopped");
      progressETag = saved.etag;
      progress = record;
      return;
    }
  };
  await checkpoint(progress);
  const read = backupReader(env);
  const late = (tracker: string) => isEphemeralBackupTracker(tracker) || policy.late_tracker_prefixes.some((prefix) => tracker.startsWith(prefix));
  const sweepKey = (tracker: string) => (late(tracker) ? "1" : "0") + tracker;
  const trackers = (await storeFor(env).backupCandidates())
    .sort((a, b) => sweepKey(a) < sweepKey(b) ? -1 : sweepKey(a) > sweepKey(b) ? 1 : 0);
  const durable = trackers;
  const durableInventoryDigest = await sha256(JSON.stringify(durable));
  const cursor = progress.last_tracker;
  if (cursor === null || (progress.durable_recheck_active && progress.durable_inventory_digest === undefined) ||
      (!progress.durable_recheck_active && progress.durable_inventory_digest !== durableInventoryDigest)) {
    await checkpoint({ ...progress, durable_inventory_digest: durableInventoryDigest,
      durable_recheck_active: cursor === null ? undefined : true, durable_recheck_tracker: undefined,
      durable_recheck_until: cursor ?? undefined });
  }
  const candidates = new Set(trackers);
  // A tracker that is no longer a candidate (its terminal archive was acknowledged) owes nothing.
  for (const tracker of [...retrying.keys()]) {
    if (!candidates.has(tracker)) {
      retrying.delete(tracker);
      console.log(JSON.stringify({ event: "store_backup_retry_dropped", tracker }));
    }
  }
  const recheckUntil = progress.durable_recheck_until;
  const recheck = recheckUntil === undefined || !progress.durable_recheck_active ? [] : durable.filter((tracker) => sweepKey(tracker) <= sweepKey(recheckUntil) &&
    (progress.durable_recheck_tracker === undefined || sweepKey(tracker) > sweepKey(progress.durable_recheck_tracker)) && !retrying.has(tracker));
  const forward = trackers.filter((tracker) => (cursor === null || sweepKey(tracker) > sweepKey(cursor)) && !retrying.has(tracker));
  const recheckLimit = Math.floor(MAX_TRACKER_CHECKS_PER_RUN / 2);
  const queue = [
    ...[...retrying.values()].filter((entry) => options.manual || (!entry.exhausted && (entry.next_attempt_at ?? 0) <= now.getTime())).map(({ tracker }) => ({ tracker, kind: "retry" as const })),
    ...recheck.slice(0, recheckLimit).map((tracker) => ({ tracker, kind: "recheck" as const })),
    ...forward.map((tracker) => ({ tracker, kind: "forward" as const })),
    ...recheck.slice(recheckLimit).map((tracker) => ({ tracker, kind: "recheck" as const })),
  ];
  let checked = 0;
  let attempted = 0;
  let forwardStarted = false;
  let rechecksDeferred = false;
  const acknowledged: { tracker: string; revision: number }[] = [];
  /** One capture: clear a failed earlier upload of the day, then read until two passes agree and write the archive. */
  const capture = async (tracker: string, key: string) => {
    await deletePrefix(bucket, `${BACKUP_PREFIX}${tracker}/${day}/`);
    return archiveSnapshot(read, tracker, {
      origin: env.PUBLIC_ORIGIN, byteLength: bytes, eventLimit: EVENT_PAGE, now: () => now, sha256,
      residentBytes: SCHEDULED_RESIDENT_BYTES,
      emit: async (item) => {
        const objectKey = item.role === "part" ? `${BACKUP_PREFIX}${tracker}/${day}/${item.name}` : key;
        const source = item.envelope.payload.source;
        // R2 rejects the upload if the stored bytes do not hash to the checksum computed here; the same bytes to the same key may be sent again.
        const checksum = await sha256(item.body);
        await r2Retry("archive_put", () => bucket.put(objectKey, item.body, { sha256: checksum, httpMetadata: { contentType: "application/json" }, customMetadata: {
          digest: item.envelope.integrity.digest, format: item.envelope.payload.format,
          ...(item.role === "part"
            ? { section: String(item.envelope.payload.section ?? "") }
            : { mutation_revision: String(source?.mutation_revision ?? ""), source_sha: source?.source_sha ?? "" }),
        } }));
      },
      abort: async (names) => deleteKeys(bucket, names.map((name) => (name === "manifest" || name === "archive" ? key : `${BACKUP_PREFIX}${tracker}/${day}/${name}`))),
    });
  };
  /**
   * A tracker that is written while it is read is contended, not broken: nothing was archived, and a read that finds
   * no writer in its way succeeds. Read it again at once while the run has time; otherwise the retry queue keeps it.
   */
  const captureContended = async (tracker: string, key: string) => {
    for (let attempt = 1; ; attempt++) {
      const began = Date.now();
      try {
        return await capture(tracker, key);
      } catch (error) {
        const took = Date.now() - began;
        if (!(error instanceof SnapshotChangedError) || attempt >= MAX_CAPTURE_ATTEMPTS || took > MAX_CONTENDED_CAPTURE_MS || Date.now() - started + took * 1.5 >= CAPTURE_RETRY_DEADLINE_MS) throw error;
        console.warn(JSON.stringify({ event: "store_backup_contended", tracker, attempt, ms: took }));
        await sleep(500 + Math.floor(Math.random() * 1500));
      }
    }
  };
  for (const { tracker, kind } of queue) {
    if (checked >= MAX_TRACKER_CHECKS_PER_RUN || Date.now() - started >= MAX_SWEEP_MS) break;
    if (kind === "forward") forwardStarted = true;
    if (kind === "recheck" && (rechecksDeferred || (!forwardStarted && forward.length > 0 && Date.now() - started >= MAX_SWEEP_MS / 2))) {
      rechecksDeferred = true;
      continue;
    }
    const key = archiveKey(tracker);
    await checkpoint({ ...progress, last_tracker: kind === "forward" ? tracker : progress.last_tracker,
      durable_recheck_tracker: kind === "recheck" ? tracker : progress.durable_recheck_tracker,
      pending_tracker: tracker });
    checked += 1;
    try {
      const existing = await r2Retry("archive_head", () => bucket.head(key));
      if (!existing) {
        attempted += 1;
        const archived = await captureContended(tracker, key);
        console.log(JSON.stringify({ event: "store_backup", tracker, key, digest: archived.digest, bytes: archived.bytes, parts: archived.parts, format: archived.format, mutation_revision: archived.mutation_revision }));
        acknowledged.push({ tracker, revision: archived.mutation_revision });
      } else {
        const revision = archiveRevision(existing.customMetadata);
        if (revision === null) throw new PermanentBackupError("existing daily archive has invalid metadata");
        acknowledged.push({ tracker, revision });
      }
      await outcomePut(tracker, { day, tracker, status: "archived", attempts: (retrying.get(tracker)?.attempts ?? 0) + 1 });
      const earlier = retrying.get(tracker);
      if (earlier !== undefined) {
        retrying.delete(tracker);
        console.log(JSON.stringify({ event: "store_backup_retry_resolved", tracker, failed_attempts: earlier.attempts }));
      }
    } catch (e) {
      await fail(tracker, e);
    }
    await checkpoint({ ...progress, pending_tracker: null });
  }
  const terminal = await storeFor(env).acknowledgeTerminalBackups(acknowledged);
  if (terminal) console.log(JSON.stringify({ event: "store_backup_terminal_archived", trackers: terminal }));
  const unchecked = queue.length - checked;
  const inventoryRecheckRequired = !unchecked && progress.durable_recheck_active === true && progress.durable_inventory_digest !== durableInventoryDigest;
  // A tracker that still owes an archive keeps the traversal open, so a day that ends with one never reports a sweep.
  const pending = unchecked > 0 || inventoryRecheckRequired || retrying.size > 0;
  await checkpoint({ ...progress, pending_tracker: null, completed_at: pending ? undefined : now.toISOString(),
    durable_inventory_digest: inventoryRecheckRequired ? undefined : progress.durable_inventory_digest,
    durable_recheck_active: pending ? progress.durable_recheck_active : undefined,
    durable_recheck_tracker: pending && !inventoryRecheckRequired ? progress.durable_recheck_tracker : undefined,
    durable_recheck_until: pending ? progress.durable_recheck_until : undefined,
    lease_until: 0 });
  console.log(JSON.stringify({ event: pending ? "store_backup_pending" : "store_backup_sweep", day, checked, attempted,
    unchecked_trackers: unchecked, cursor: progress.last_tracker, retry_trackers: retrying.size,
    failed: failed.length, exhausted_trackers: [...retrying.values()].filter((entry) => entry.exhausted).map((entry) => entry.tracker) }));
  if (failed.length) throw new Error(`store backup failed for ${failed.join(", ")}`);
  if (!pending) await pingBackupHeartbeat(env, bucket, day);
}

/** Admin readback uses the same progress and heartbeat marker that the backup-age probe reads. */
export async function backupSweepState(env: Env): Promise<unknown> {
  if (!env.BACKUP_BUCKET) return { configured: false };
  const saved = await r2Retry("progress_get", () => env.BACKUP_BUCKET!.get(PROGRESS_KEY));
  if (saved && saved.size > PROGRESS_MAX_BYTES) throw new Error("scheduled backup progress exceeds its byte budget");
  const progress = saved ? progressSchema.parse(await saved.json()) : null;
  const marker = await env.BACKUP_BUCKET.get(HEARTBEAT_KEY);
  return { configured: true, max_tracker_checks: MAX_TRACKER_CHECKS_PER_RUN, progress,
    heartbeat: marker ? { uploaded: marker.uploaded.toISOString(), ...await marker.json<{ day: string }>() } : null };
}

/**
 * Pings the optional external heartbeat on the first complete, failure-free sweep of a UTC day, so a
 * missed day raises the monitor's alert. The day marker keeps later hourly sweeps from pinging again,
 * which would delay that alert by up to a day. A failed ping is logged and never fails the backup.
 */
async function pingBackupHeartbeat(env: Env, bucket: R2Bucket, day: string): Promise<void> {
  const url = env.BACKUP_HEARTBEAT_URL?.trim();
  if (!url?.startsWith("https://")) return;
  try {
    // An unreadable or oversized marker counts as absent, so it never blocks the ping.
    const marker = await bucket.get(HEARTBEAT_KEY);
    const pinged = marker && marker.size <= 1024 ? await marker.json<{ day?: string }>().catch(() => null) : null;
    if (pinged?.day === day) return;
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    await bucket.put(HEARTBEAT_KEY, JSON.stringify({ day }), { httpMetadata: { contentType: "application/json" } });
    console.log(JSON.stringify({ event: "store_backup_heartbeat", day }));
  } catch (error) {
    console.error(JSON.stringify({ event: "store_backup_heartbeat_failed", day, error: error instanceof Error ? error.message : String(error) }));
  }
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
