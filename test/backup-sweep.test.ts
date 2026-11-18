// The scheduled backup sweep against the real tracker store and an in-memory R2 bucket: writers that are active
// while a tracker is read, and R2 errors on the progress record. Only reads of this test's own trackers and bucket.
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from "vitest";
import { runBackupSweep } from "../src/tracker/backup";
import { call, tracker } from "./helpers";

const bucket = (env as unknown as { BACKUP_BUCKET: R2Bucket }).BACKUP_BUCKET;
const PROGRESS = "backup-progress/scheduled.json";
const HEARTBEAT = "https://heartbeat.test/backup";
const R2_INTERNAL = () => new Error("put: We encountered an internal error. Please try again. (10001)");

let dayNumber = 0;
const nextDay = () => `2031-04-${String(++dayNumber + 9).padStart(2, "0")}`;
let sweepHour = 3;
const at = (day: string) => new Date(`${day}T${String(sweepHour).padStart(2, "0")}:00:00Z`);
const archiveKey = (name: string, day: string) => `snapshots/${name}/${day}.snapshot.json`;

const importKey = async (name: string) => (await call("POST", "/admin/keys", env.ADMIN_TOKEN, {
  label: name, scopes: ["beads:read", "beads:write", "beads:import"], trackers: [name],
})).body.key as string;

async function seed(name: string) {
  const t = tracker(name, await importKey(name));
  await t.create(`${name} first issue`);
  await t.create(`${name} second issue`);
  return t;
}

const writers: { stop: () => Promise<void> }[] = [];
/** A writer that never stops by itself, like an agent session; `halt` stops it after its current write. */
function writer(t: ReturnType<typeof tracker>) {
  let halted = false, count = 0;
  const done = (async () => {
    const id = await t.create("written all day");
    while (!halted) {
      const reply = await t.patch(`/issues/${id}`, { patch: { title: `write ${count++}` } });
      if (reply.status !== 200) throw new Error(`test writer was refused: ${JSON.stringify(reply.body)}`);
    }
  })();
  const handle = { halt: () => { halted = true; }, stop: async () => { halted = true; await done; }, count: () => count };
  writers.push(handle);
  return handle;
}

const events = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.flatMap(([line]) => { try { return [JSON.parse(String(line)) as Record<string, any>]; } catch { return []; } });
const readProgress = async () => (await (await bucket.get(PROGRESS))!.json()) as Record<string, any>;
async function expireLease() {
  const record = await readProgress();
  await bucket.put(PROGRESS, JSON.stringify({ ...record, lease_until: 0 }));
}
const sweep = (day: string) => runBackupSweep({ ...env, BACKUP_HEARTBEAT_URL: HEARTBEAT } as Env, at(day));

/** The bucket as the sweep sees it, with a hook on each PUT. The hook may delay, fail, or write and then fail. */
function observed(onPut: (key: string, body: unknown, real: () => Promise<R2Object | null>) => Promise<R2Object | null>): R2Bucket {
  return new Proxy(bucket, {
    get(target, property) {
      if (property === "put") return (key: string, body: unknown, options?: unknown) => onPut(key, body, () => (target.put as any)(key, body, options));
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
const sweepWith = (day: string, withBucket: R2Bucket) => runBackupSweep({ ...env, BACKUP_BUCKET: withBucket, BACKUP_HEARTBEAT_URL: HEARTBEAT } as Env, at(day));

let log: MockInstance, warn: MockInstance, error: MockInstance, heartbeat: MockInstance;
beforeEach(async () => {
  sweepHour = 3;
  await bucket.delete(PROGRESS);
  log = vi.spyOn(console, "log").mockImplementation(() => {});
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  error = vi.spyOn(console, "error").mockImplementation(() => {});
  heartbeat = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("ok"));
});
afterEach(async () => {
  for (const handle of writers.splice(0)) await handle.stop();
  vi.restoreAllMocks();
});

it("archives a tracker that is written all day: it is read again when contention is reported, with no failure and a heartbeat", async () => {
  const day = nextDay();
  const t = await seed("sweep-hot-a");
  const w = writer(t);
  warn.mockImplementation((line: unknown) => { if (String(line).includes("store_backup_contended")) w.halt(); });
  await sweep(day);
  await w.stop();
  const warned = events(warn).filter((entry) => entry.tracker === "sweep-hot-a");
  expect(w.count()).toBeGreaterThan(0);
  expect(warned.some((entry) => entry.event === "store_backup_contended" && entry.attempt === 1)).toBe(true);
  expect(events(error).filter((entry) => entry.event === "store_backup_failed")).toEqual([]);
  const archived = await bucket.head(archiveKey("sweep-hot-a", day));
  expect(archived?.customMetadata?.mutation_revision).toBe(String((await t.get("/context")).body.x_mutation_revision));
  expect(events(log).some((entry) => entry.event === "store_backup_sweep" && entry.failed === 0)).toBe(true);
  expect(heartbeat).toHaveBeenCalledTimes(1);
  const progress = await readProgress();
  expect(progress.retry).toBeUndefined();
  expect(progress.sweep_failed).toBe(false);
  expect(progress.lease_until).toBe(0);
});

it("keeps a tracker that stays contended in the retry queue without voiding the day, and archives it once the writers pause", async () => {
  const day = nextDay();
  const t = await seed("sweep-hot-b");
  const w = writer(t);
  await sweep(day);
  const open = await readProgress();
  expect(open.retry).toMatchObject([{ tracker: "sweep-hot-b", attempts: 1, exhausted: false }]);
  expect(open.sweep_failed).toBe(false);
  expect(open.lease_until).toBe(0);
  expect(await bucket.head(archiveKey("sweep-hot-b", day))).toBeNull();
  expect(events(warn).filter((entry) => entry.event === "store_backup_contended" && entry.tracker === "sweep-hot-b").length).toBeGreaterThan(0);
  expect(events(warn).some((entry) => entry.event === "store_backup_retry_scheduled" && entry.tracker === "sweep-hot-b" && entry.attempts === 1)).toBe(true);
  expect(events(log).some((entry) => entry.event === "store_backup_pending" && entry.retry_trackers === 1)).toBe(true);
  expect(events(log).some((entry) => entry.event === "store_backup_sweep")).toBe(false);
  expect(heartbeat).not.toHaveBeenCalled();
  await w.stop();
  sweepHour++;
  await sweep(day);
  expect(await bucket.head(archiveKey("sweep-hot-b", day))).not.toBeNull();
  expect(events(log).some((entry) => entry.event === "store_backup_retry_resolved" && entry.tracker === "sweep-hot-b")).toBe(true);
  expect(events(log).some((entry) => entry.event === "store_backup_sweep" && entry.failed === 0)).toBe(true);
  expect(heartbeat).toHaveBeenCalledTimes(1);
  expect((await readProgress()).retry).toBeUndefined();
}, 60_000);

it("fails loudly once a tracker has stayed contended through every attempt of the day, and never sends a heartbeat for it", async () => {
  const day = nextDay();
  const t = await seed("sweep-hot-c");
  const w = writer(t);
  let rejected: unknown;
  let runs = 0;
  while (!rejected && runs < 16) {
    runs++;
    sweepHour++;
    await sweep(day).catch((reason: unknown) => { rejected = reason; });
  }
  await w.stop();
  expect(runs).toBe(12);
  expect(String(rejected)).toContain("store backup failed for sweep-hot-c");
  expect(events(error).filter((entry) => entry.event === "store_backup_failed" && entry.tracker === "sweep-hot-c" && entry.attempts === 12)).toHaveLength(1);
  expect(await bucket.head(archiveKey("sweep-hot-c", day))).toBeNull();
  expect(heartbeat).not.toHaveBeenCalled();
  // Exhausted trackers do not restart the traversal. Only an explicit admin resume retries them.
  await sweep(day);
  expect(await bucket.head(archiveKey("sweep-hot-c", day))).toBeNull();
  await runBackupSweep({ ...env, BACKUP_HEARTBEAT_URL: HEARTBEAT } as Env, at(day), { manual: true });
  expect(await bucket.head(archiveKey("sweep-hot-c", day))).not.toBeNull();
}, 240_000);

it("retries a progress write that R2 refused without committing it", async () => {
  const day = nextDay();
  await seed("sweep-prog-a");
  let refused = 0;
  const flaky = observed(async (key, body, real) => {
    if (key === PROGRESS && refused === 0 && String(body).includes('"pending_tracker":"sweep-prog-a"')) { refused++; throw R2_INTERNAL(); }
    return real();
  });
  await sweepWith(day, flaky);
  expect(refused).toBe(1);
  expect(events(warn).some((entry) => entry.event === "store_backup_r2_retry" && entry.operation === "progress_put" && entry.code === "10001")).toBe(true);
  expect(events(error).filter((entry) => entry.event === "store_backup_r2_failed")).toEqual([]);
  expect(await bucket.head(archiveKey("sweep-prog-a", day))).not.toBeNull();
  const progress = await readProgress();
  expect(progress.sweep_failed).toBe(false);
  expect(progress.retry).toBeUndefined();
  expect(heartbeat).toHaveBeenCalledTimes(1);
});

it("adopts a progress write that committed before R2 reported the error, instead of stopping on its own ETag", async () => {
  const day = nextDay();
  await seed("sweep-prog-b");
  let acknowledgements = 0;
  const lossy = observed(async (key, body, real) => {
    const saved = await real();
    if (key === PROGRESS && acknowledgements === 0 && String(body).includes('"pending_tracker":"sweep-prog-b"')) { acknowledgements++; throw R2_INTERNAL(); }
    return saved;
  });
  await sweepWith(day, lossy);
  expect(acknowledgements).toBe(1);
  expect(events(error).filter((entry) => entry.event === "store_backup_r2_failed")).toEqual([]);
  expect(await bucket.head(archiveKey("sweep-prog-b", day))).not.toBeNull();
  expect((await readProgress()).sweep_failed).toBe(false);
  expect(heartbeat).toHaveBeenCalledTimes(1);
});

it("keeps every earlier archive and the one just written when the progress write keeps failing, then finishes cleanly without writing it again", async () => {
  const before = nextDay();
  const day = nextDay();
  await seed("sweep-prog-c");
  await sweep(before);
  const previousDay = await bucket.head(archiveKey("sweep-prog-c", before));
  expect(previousDay).not.toBeNull();
  heartbeat.mockClear();
  // From the write that clears the pending marker of this tracker, every progress write fails: its archive is
  // written, its pending marker is committed, and the run cannot go on.
  let failingFromHere = false;
  const failing = observed(async (key, body, real) => {
    if (key === PROGRESS && String(body).includes('"last_tracker":"sweep-prog-c"') && String(body).includes('"pending_tracker":null')) failingFromHere = true;
    if (key === PROGRESS && failingFromHere) throw R2_INTERNAL();
    return real();
  });
  await expect(sweepWith(day, failing)).rejects.toThrow(/10001/);
  expect(events(error).some((entry) => entry.event === "store_backup_r2_failed" && entry.operation === "progress_put" && entry.code === "10001")).toBe(true);
  const written = await bucket.head(archiveKey("sweep-prog-c", day));
  expect(written).not.toBeNull();
  const stranded = await readProgress();
  expect(stranded.pending_tracker).toBe("sweep-prog-c");
  expect(heartbeat).not.toHaveBeenCalled();
  expect((await bucket.head(archiveKey("sweep-prog-c", before)))?.etag).toBe(previousDay?.etag);
  await expireLease();
  await sweep(day);
  expect(events(error).some((entry) => entry.event === "store_backup_interrupted" && entry.tracker === "sweep-prog-c")).toBe(true);
  expect(events(log).some((entry) => entry.event === "store_backup_retry_resolved" && entry.tracker === "sweep-prog-c")).toBe(true);
  expect((await bucket.head(archiveKey("sweep-prog-c", day)))?.etag).toBe(written?.etag);
  expect((await bucket.head(archiveKey("sweep-prog-c", before)))?.etag).toBe(previousDay?.etag);
  const progress = await readProgress();
  expect(progress.pending_tracker).toBeNull();
  expect(progress.sweep_failed).toBe(false);
  expect(progress.retry).toBeUndefined();
  expect(heartbeat).toHaveBeenCalledTimes(1);
}, 60_000);

it("resumes a progress record of the previous format: its pending tracker is read again and the day finishes clean", async () => {
  const day = nextDay();
  await seed("sweep-legacy");
  await bucket.put(PROGRESS, JSON.stringify({ version: 1, day, last_tracker: null, pending_tracker: "sweep-legacy", retried_tracker: null, sweep_failed: false, lease_until: 0, run_id: crypto.randomUUID() }));
  await runBackupSweep({ ...env, BACKUP_HEARTBEAT_URL: HEARTBEAT } as Env, at(day), { manual: true });
  await sweep(day);
  expect(await bucket.head(archiveKey("sweep-legacy", day))).not.toBeNull();
  expect(events(log).some((entry) => entry.event === "store_backup_retry_resolved" && entry.tracker === "sweep-legacy")).toBe(true);
  expect((await readProgress()).retried_tracker).toBeUndefined();
  expect(heartbeat).toHaveBeenCalledTimes(1);
});

it("retains the named exhausted outcome for invalid metadata without restarting the traversal", async () => {
  const day = nextDay();
  await seed("sweep-invalid");
  await bucket.put(archiveKey("sweep-invalid", day), "not an archive");
  await expect(sweep(day)).rejects.toThrow(/store backup failed for sweep-invalid/);
  expect(events(error).some((entry) => entry.event === "store_backup_failed" && entry.tracker === "sweep-invalid" && entry.attempts === 1)).toBe(true);
  expect(heartbeat).not.toHaveBeenCalled();
  expect((await bucket.get(archiveKey("sweep-invalid", day)))?.size).toBe("not an archive".length);
  expect((await readProgress()).retry).toMatchObject([{ tracker: "sweep-invalid", exhausted: true }]);
});

it("resumes the inherited day-wide failure flag once, records each archive, then checks no successful tracker again", async () => {
  const day = nextDay();
  await seed("sweep-inherited");
  await bucket.put(PROGRESS, JSON.stringify({ version: 1, day, last_tracker: "sweep-inherited", pending_tracker: null, sweep_failed: true, lease_until: 0, run_id: crypto.randomUUID() }));
  await sweep(day);
  expect(await bucket.head(archiveKey("sweep-inherited", day))).not.toBeNull();
  expect((await readProgress()).completed_at).toBe(at(day).toISOString());
  log.mockClear();
  await sweep(day);
  expect(events(log).find((entry) => entry.event === "store_backup_sweep")?.checked).toBe(0);
  expect(heartbeat).toHaveBeenCalledTimes(1);
});

it("requires admin authentication for manual sweep and state, and allows a same-day resume before the scheduled hour", async () => {
  expect((await call("GET", "/admin/backups/sweep", undefined)).status).toBe(401);
  expect((await call("POST", "/admin/backups/sweep", await importKey("sweep-no-admin"))).status).toBe(403);
  const reply = await call("POST", "/admin/backups/sweep", env.ADMIN_TOKEN);
  expect(reply.status).toBe(200);
  expect(reply.body.progress.completed_at).toBeDefined();
  const state = await call("GET", "/admin/backups/sweep", env.ADMIN_TOKEN);
  expect(state.status).toBe(200);
  expect(state.body.max_tracker_checks).toBe(128);
});

it("does not starve forward work when an interrupted tracker's HEAD and outcome object both fail", async () => {
  const day = nextDay();
  await seed("sweep-stuck-a");
  await seed("sweep-stuck-z");
  await bucket.put(PROGRESS, JSON.stringify({ version: 1, day, last_tracker: "sweep-stuck-a", pending_tracker: "sweep-stuck-a", lease_until: 0, run_id: crypto.randomUUID() }));
  const failing = new Proxy(observed(async (key, _body, real) => {
    if (key.includes("outcomes/") && key.endsWith("sweep-stuck-a.json")) throw R2_INTERNAL();
    return real();
  }), { get(target, property) {
    if (property === "head") return (key: string) => key === archiveKey("sweep-stuck-a", day) ? Promise.reject(R2_INTERNAL()) : bucket.head(key);
    const value = Reflect.get(target, property, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  await sweepWith(day, failing);
  expect(await bucket.head(archiveKey("sweep-stuck-z", day))).not.toBeNull();
  expect((await readProgress()).retry).toMatchObject([{ tracker: "sweep-stuck-a", attempts: 1 }]);
  expect(heartbeat).not.toHaveBeenCalled();
  sweepHour++;
  await sweep(day);
  expect(await bucket.head(archiveKey("sweep-stuck-a", day))).not.toBeNull();
  expect(heartbeat).toHaveBeenCalledTimes(1);
}, 60_000);
