// Operator restore drill for one tracker of a deployed store (docs/operations.md "Logical recovery drill").
// Restores a scheduled R2 snapshot into an unused scratch tracker through the guarded operator CLI
// (tracker-snapshot.mjs restore), compares counts and hashes with the snapshot and with the live source
// tracker (every issue the journal does not name as changed since the snapshot must be identical),
// empties the scratch tracker, revokes both one-day keys it minted and verifies their denial.
// Tokens are never printed; the receipt holds ids, counts, hashes and timings only.
//   BEADS_CLOUDFLARE_BASE=https://... BEADS_ADMIN_TOKEN=... \
//     node scripts/restore-drill.mjs <snapshot.json> <source-tracker> restore-drill-<name> <private-out-dir>
// Download the manifest first. A v2 archive also needs its sibling part directory
// (`cf r2 objects get snapshots/<tracker>/<day>.snapshot.json` and `snapshots/<tracker>/<day>/part-NNNNN.json`).
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { assertEmptyDestination, readSnapshotFile, snapshotPartPath, writePrivateSnapshot } from "./tracker-snapshot.mjs";
import { canonical, captureSnapshot, cleanIssue } from "../src/tracker/snapshot-core.mjs";

const REPO = fileURLToPath(new URL("..", import.meta.url));

const BASE = (() => { const u = new URL(process.env.BEADS_CLOUDFLARE_BASE ?? "");
  if (u.protocol !== "https:" || u.pathname !== "/" || u.search || u.username) throw new Error("BEADS_CLOUDFLARE_BASE must be an https origin"); return u.origin; })();
const [snapshotFile, source, scratch, outDir] = process.argv.slice(2);
const admin = process.env.BEADS_ADMIN_TOKEN;
if (!snapshotFile || !source || !scratch || !outDir || !admin) throw new Error("usage: restore-drill.mjs <snapshot> <source> <scratch> <out-dir> with BEADS_ADMIN_TOKEN");
if (!/^restore-drill-[a-z0-9-]+$/.test(scratch) || scratch.length > 40) throw new Error("scratch tracker must be named restore-drill-*");
const sha = value => createHash("sha256").update(canonical(value)).digest("hex");
const counts = state => ({ issues: state.issues.length, dependencies: state.dependencies.length,
  comments: state.issues.reduce((sum, issue) => sum + (issue.comments?.length ?? 0), 0), memories: state.memories.length, settings: state.settings.length,
  statuses: state.vocabulary.statuses.length, types: state.vocabulary.types.length });
const t0 = Date.now();
const mark = {};
const step = name => { mark[name] = Date.now() - t0; };

async function call(token, pathname, method = "GET", body) {
  const response = await fetch(`${BASE}${pathname}`, { method, redirect: "error", signal: AbortSignal.timeout(60_000),
    headers: { Authorization: `Bearer ${token}`, "X-Beads-Agent": "restore-drill",
      ...(body ? { "Content-Type": "application/json", "Idempotency-Key": randomUUID() } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await response.text();
  if (!response.ok) { const e = new Error(`${method} ${pathname.replace(/\/t\/[^/]+/, "/t/<tracker>")} refused: HTTP ${response.status}${pathname.startsWith("/admin") ? ` ${text.slice(0, 200)}` : ""}`); e.status = response.status; throw e; }
  return text ? JSON.parse(text) : {};
}
const tracker = token => async (t, suffix, method = "GET", body) => call(token, `/t/${t}/v0/beads${suffix}`, method, body);
const capture = (request, t) => captureSnapshot(request, t, { byteLength: text => Buffer.byteLength(text), eventLimit: 1000, journal: "head" });

// 1. Snapshot: copy into a private file (and part directory, for a v2 archive), then verify.
const raw = fs.readFileSync(snapshotFile, "utf8");
let downloaded;
try { downloaded = JSON.parse(raw); }
catch { throw new Error("snapshot is not valid JSON; file content is withheld"); }
const privateFile = path.join(outDir, `${source}.snapshot.private.json`);
const privateParts = [];
fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
writePrivateSnapshot(privateFile, raw.endsWith("\n") ? raw : `${raw}\n`);
if (downloaded?.payload?.format === "beads-cloudflare.logical-snapshot/v2") {
  for (const part of downloaded.payload.parts ?? []) {
    if (!part || typeof part.name !== "string") throw new Error("snapshot format or integrity is invalid");
    const target = snapshotPartPath(privateFile, part.name);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    const partRaw = fs.readFileSync(snapshotPartPath(snapshotFile, part.name), "utf8");
    writePrivateSnapshot(target, partRaw.endsWith("\n") ? partRaw : `${partRaw}\n`);
    privateParts.push(target);
  }
}
let opened;
try { opened = readSnapshotFile(privateFile); }
catch (error) {
  fs.rmSync(privateFile, { force: true });
  for (const part of privateParts) fs.rmSync(part, { force: true });
  throw error;
}
const envelope = opened.envelope;
const snap = opened.payload;
if (snap.source.tracker !== source || snap.source.origin !== BASE) {
  fs.rmSync(privateFile, { force: true });
  for (const part of privateParts) fs.rmSync(part, { force: true });
  throw new Error("snapshot is not of the named source tracker on this store");
}
step("snapshot_verified");

// 2. Store health before, the scratch tracker unused, two finite keys.
const healthBefore = await call(admin, "/admin/health");
const trackersBefore = (await call(admin, "/admin/trackers")).items;
if (trackersBefore.some(t => t.tracker === scratch)) throw new Error("scratch tracker already exists; never reuse a destination");
const keyD = await call(admin, "/admin/keys", "POST", { label: `${scratch} import`, scopes: ["beads:read", "beads:write", "beads:import"], trackers: [scratch], expires_in_days: 1 });
let keyS;
try { keyS = await call(admin, "/admin/keys", "POST", { label: `${scratch} source-read`, scopes: ["beads:read"], trackers: [source], expires_in_days: 1 }); }
catch (e) { await call(admin, `/admin/keys/${encodeURIComponent(keyD.id)}`, "DELETE").catch(() => {}); throw e; }
const receipt = { schema: "beads.restore-drill.v1", origin: BASE, source_tracker: source, scratch_tracker: scratch,
  snapshot: { key: `snapshots/${source}/${path.basename(snapshotFile)}`, captured_at: snap.captured_at, digest: envelope.integrity.digest,
    store_version: snap.source.store_version, mutation_revision: snap.source.mutation_revision, journal_head: snap.journal.head,
    counts: counts(snap.state), state_sha256: sha(snap.state) },
  keys: { import: { id: keyD.id, trackers: keyD.trackers, scopes: keyD.scopes, expires_at: keyD.expires_at }, source_read: { id: keyS.id, trackers: keyS.trackers, scopes: keyS.scopes, expires_at: keyS.expires_at } },
  store_before: (({ thresholds, ...h }) => h)(healthBefore) };
let cleanupOk = false;
try {
  const dest = tracker(keyD.key);
  const empty = await capture(dest, scratch);
  assertEmptyDestination(empty, scratch);
  step("destination_empty");

  // 3. Guarded restore through the operator CLI.
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(REPO, "scripts", "tracker-snapshot.mjs"), "restore", privateFile, "--tracker", scratch, "--quiesced", "--exclusive"],
      { cwd: REPO, env: { ...process.env, BEADS_CLOUDFLARE_BASE: BASE, BEADS_SNAPSHOT_TOKEN: keyD.key, BEADS_ADMIN_TOKEN: "" }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", c => { out += c; }); child.stderr.on("data", c => { err += c; });
    child.once("close", code => code === 0 ? resolve(JSON.parse(out.trim().split("\n").at(-1))) : reject(new Error(`restore CLI exited ${code}: ${err.trim().slice(0, 300)}`)));
  });
  step("restored");
  if (result.recovery !== "VERIFIED" || result.digest !== envelope.integrity.digest) throw new Error("restore acknowledgement differs");

  // 4. Independent read of the restored tracker.
  const restored = await capture(dest, scratch);
  const restoredMatches = canonical(restored.state.issues) === canonical(snap.state.issues) && canonical(restored.state.dependencies) === canonical(snap.state.dependencies) &&
    canonical(restored.state.memories) === canonical(snap.state.memories) && canonical(restored.state.settings) === canonical(snap.state.settings) &&
    canonical(restored.state.vocabulary) === canonical(snap.state.vocabulary);
  receipt.restore = { cli: result.recovery, mutation_revision: result.mutation_revision, project_id: restored.state.project_id,
    counts: counts(restored.state), state_sha256: sha(restored.state), semantic_state_equal: restoredMatches,
    issues_sha256: sha(restored.state.issues), dependencies_sha256: sha(restored.state.dependencies) };
  if (!restoredMatches) throw new Error("restored state differs from the snapshot");
  step("restored_compared");

  // 5. Live tracker: rows unchanged since the snapshot must equal it; changes are named by the journal.
  const live = tracker(keyS.key);
  const ctx = await live(source, "/context");
  const pages = async (suffix, field) => { const items = []; let cursor;
    for (;;) { const page = await live(source, `${suffix}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`); items.push(...page[field]);
      if (!page.has_more) break; cursor = page.next_cursor; } return items; };
  const liveIssues = (await pages("/issues:export?include_templates=true&include_gates=true&include_infra=true&include_ephemeral=true&limit=200", "items")).map(cleanIssue);
  const liveDeps = await pages("/dependencies:export?limit=1000", "items");
  const liveMem = (await live(source, "/memories")).items;
  const events = []; let since = snap.journal.head;
  for (;;) { const page = await live(source, `/events?limit=1000&since=${since}`); if (!page.records.length) break; events.push(...page.records); since = page.records.at(-1).seq; if (since === page.head) break; }
  const touched = new Set(events.map(e => e.issue_id).filter(Boolean));
  const liveById = new Map(liveIssues.map(i => [i.id, i]));
  let unchanged = 0, unchangedEqual = 0, missingUntouched = 0;
  for (const issue of snap.state.issues) {
    if (touched.has(issue.id)) continue;
    unchanged++;
    const other = liveById.get(issue.id);
    if (!other) { missingUntouched++; continue; }
    if (canonical(other) === canonical(issue)) unchangedEqual++;
  }
  const created = liveIssues.filter(i => !snap.state.issues.some(s => s.id === i.id)).length;
  const removed = snap.state.issues.filter(s => !liveById.has(s.id)).length;
  receipt.live = { mutation_revision: ctx.x_mutation_revision, revisions_since_snapshot: ctx.x_mutation_revision - snap.source.mutation_revision,
    journal_events_since_snapshot: events.length, issues_touched_since_snapshot: touched.size,
    counts: { issues: liveIssues.length, dependencies: liveDeps.length, memories: liveMem.length },
    issues_created_since: created, issues_removed_since: removed,
    untouched_issues: unchanged, untouched_issues_identical: unchangedEqual, untouched_issues_missing: missingUntouched,
    issue_count_explained: liveIssues.length === snap.state.issues.length + created - removed };
  step("live_compared");
} finally {
  // 6. Cleanup: empty the scratch tracker, revoke both keys, verify denial.
  const errors = [];
  try {
    const dest = tracker(keyD.key);
    const state = await capture(dest, scratch);
    const ids = state.state.issues.map(i => i.id);
    for (let i = 0; i < ids.length; i += 100) await dest(scratch, "/issues:delete", "POST", { actor: "restore-drill", ids: ids.slice(i, i + 100), force: true, cascade: false });
    for (const item of state.state.memories) await dest(scratch, `/memories/${encodeURIComponent(item.key)}`, "DELETE");
    for (const item of state.state.settings) await dest(scratch, `/config/${encodeURIComponent(item.key)}`, "DELETE");
    const after = await capture(dest, scratch);
    const emptyAfter = [after.state.issues, after.state.dependencies, after.state.memories, after.state.settings, after.state.vocabulary.statuses, after.state.vocabulary.types].every(r => r.length === 0);
    receipt.cleanup = { deleted_issues: ids.length, deleted_memories: state.state.memories.length, deleted_settings: state.state.settings.length,
      active_state_empty: emptyAfter, journal_head: after.journal.head, journal_retained: true, mutation_revision: after.context.x_mutation_revision };
    if (!emptyAfter) errors.push("scratch tracker not empty after cleanup");
  } catch (e) { errors.push(`cleanup: ${e.message}`); }
  for (const [name, key] of [["import", keyD], ["source_read", keyS]]) {
    try {
      const revoked = await call(admin, `/admin/keys/${encodeURIComponent(key.id)}`, "DELETE");
      let denied = false, status = 0;
      try { await call(key.key, `/t/${key.trackers[0]}/v0/beads/context`); } catch (e) { denied = e.status === 401 || e.status === 403; status = e.status; }
      receipt.keys[name].revoked_at = revoked.revoked_at; receipt.keys[name].denial_after_revoke = denied ? `HTTP ${status}` : "NOT DENIED";
      if (!denied) errors.push(`${name} key still accepted after revocation`);
    } catch (e) { errors.push(`revoke ${name}: ${e.message}`); }
  }
  const healthAfter = await call(admin, "/admin/health").catch(() => ({}));
  receipt.store_after = (({ thresholds, ...h }) => h)(healthAfter);
  step("cleaned");
  receipt.timings_ms = mark;
  receipt.cleanup_errors = errors;
  cleanupOk = errors.length === 0;
  fs.rmSync(privateFile, { force: true });
  for (const part of privateParts) fs.rmSync(part, { force: true });
  receipt.result = cleanupOk && receipt.restore?.semantic_state_equal && receipt.live?.issue_count_explained &&
    receipt.live.untouched_issues_missing === 0 && receipt.live.untouched_issues_identical === receipt.live.untouched_issues ? "PASS" : "FAIL";
  if (receipt.result !== "PASS") process.exitCode = 1;
  receipt.receipt_sha256 = sha(receipt);
  fs.writeFileSync(path.join(outDir, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(JSON.stringify(receipt, null, 2));
}
