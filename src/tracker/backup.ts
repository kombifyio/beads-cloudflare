// Scheduled logical backup (hourly cron): once per UTC day, each tracker of the team store is captured
// through its own read API and sealed into the operator snapshot format, then written to the optional
// private R2 bucket BACKUP_BUCKET. A tracker that fits in the resident budget is one v1 object. A larger
// one is a v2 manifest plus part objects, each inside the 64 MiB budget, with the journal kept whole.
// `scripts/tracker-snapshot.mjs verify|restore` reads either shape. A tracker that moves between reads
// is retried at the next hourly run; no tracker is mutated. Without the binding nothing runs
// (see docs/operations.md).
import type { ApiContext } from "../auth/provider";
import { SCOPE_IMPORT, SCOPE_READ, SCOPE_WRITE } from "../auth/scopes";
import { handleTracker, storeFor } from "../http/endpoint";
import { archiveSnapshot, expiredSnapshotKeys, SNAPSHOT_MAX_BYTES, type SnapshotRequest } from "./snapshot-core.mjs";

export const BACKUP_PREFIX = "snapshots/";
const EVENT_PAGE = 1000;

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
    return jsonBody(response);
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
  const read = backupReader(env);
  const trackers = (await storeFor(env).trackerSummary()).map((t) => t.tracker);
  const failed: string[] = [];
  for (const tracker of trackers) {
    const key = `${BACKUP_PREFIX}${tracker}/${day}.snapshot.json`;
    if (await bucket.head(key)) continue;
    try {
      await deletePrefix(bucket, `${BACKUP_PREFIX}${tracker}/${day}/`);
      const archived = await archiveSnapshot(read, tracker, {
        origin: env.PUBLIC_ORIGIN, byteLength: bytes, eventLimit: EVENT_PAGE, now: () => now, sha256,
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
    } catch (e) {
      failed.push(tracker);
      console.error(JSON.stringify({ event: "store_backup_failed", tracker, key, error: e instanceof Error ? e.message : String(e) }));
    }
  }
  await pruneSnapshots(bucket, policy.retention_days, now);
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
