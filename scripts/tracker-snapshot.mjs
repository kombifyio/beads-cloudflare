#!/usr/bin/env node
// Private logical snapshots through the authenticated tracker API, never direct SQL or admin custody.
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { credentialFilePrivate } from "../cli/github-auth.mjs";

const FORMAT = "beads-cloudflare.logical-snapshot/v1";
const MAX_BYTES = 64 << 20;
const BATCH_BYTES = 15 << 20;
const DERIVED = new Set(["is_blocked", "dependency_count", "dependent_count", "comment_count", "parent", "revision", "comments_omitted", "lease_granted_node", "dependents", "epic_total_children", "epic_closed_children", "epic_closeable"]);
const trackerValid = value => typeof value === "string" && value.length <= 40 && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(value);
export const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
const hash = value => createHash("sha256").update(canonical(value)).digest("hex");
const cleanIssue = issue => Object.fromEntries(Object.entries(issue).filter(([key]) => !DERIVED.has(key)));
const orderBy = (items, key) => [...items].sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);

export function sealSnapshot(payload) { return { payload, integrity: { algorithm: "sha256", digest: hash(payload) } }; }

export function verifySnapshot(envelope) {
  const p = envelope?.payload;
  if (envelope?.integrity?.algorithm !== "sha256" || envelope.integrity.digest !== hash(p) || p?.format !== FORMAT ||
      !trackerValid(p.source?.tracker) || typeof p.state?.project_id !== "string" ||
      !["issues", "dependencies", "memories", "settings"].every(key => Array.isArray(p.state[key])) ||
      !Array.isArray(p.state.vocabulary?.statuses) || !Array.isArray(p.state.vocabulary?.types) ||
      !Array.isArray(p.journal?.records) || !Number.isSafeInteger(p.journal.head) || p.journal.head < 0) {
    throw new Error("snapshot format or integrity is invalid");
  }
  const identities = new Set();
  for (const issue of p.state.issues) {
    if (typeof issue?.id !== "string" || identities.has(issue.id)) throw new Error("snapshot issue identities are invalid");
    identities.add(issue.id);
  }
  for (const edge of p.state.dependencies) {
    if (!identities.has(edge.issue_id) || typeof edge.depends_on_id !== "string") throw new Error("snapshot has an edge without a restorable source issue");
  }
  for (const key of ["memories", "settings"]) {
    const keys = new Set();
    for (const entry of p.state[key]) {
      if (typeof entry?.key !== "string" || typeof entry.value !== "string" || keys.has(entry.key)) throw new Error(`snapshot ${key} are invalid`);
      keys.add(entry.key);
    }
  }
  let seq = 0;
  for (const event of p.journal.records) {
    if (!Number.isSafeInteger(event.seq) || event.seq <= seq || event.seq > p.journal.head) throw new Error("snapshot journal order is invalid");
    seq = event.seq;
  }
  if (seq !== p.journal.head) throw new Error("snapshot journal is incomplete");
  return p;
}

export function assertEmptyDestination(capture, tracker) {
  const s = capture.state;
  if (capture.context?.x_mutation_revision !== 0 || s.project_id !== tracker || capture.journal.head !== 0 ||
    [s.issues, s.dependencies, s.memories, s.settings, s.vocabulary.statuses, s.vocabulary.types].some(items => items.length !== 0)) {
    throw new Error("restore requires an unused empty destination; existing tracker state will not be overwritten");
  }
}

/** Bound records, relation/thread counts and UTF-8 body size before the first request is sent. */
export function restoreBatches(snapshot) {
  const s = snapshot.state;
  if (s.issues.some(issue => issue.status === "in_progress" && issue.assignee && Date.parse(issue.lease_expires_at) > Date.now())) {
    throw new Error("release live claims or wait for their leases to expire before logical recovery; verified claim custody is not restored");
  }
  const edges = new Map();
  for (const edge of s.dependencies) (edges.get(edge.issue_id) ?? edges.set(edge.issue_id, []).get(edge.issue_id)).push(edge);
  const batches = [];
  const blank = () => ({ actor: "logical-recovery", mode: "replace", vocabulary: s.vocabulary, issues: [], memories: [], settings: [] });
  let current = { ...blank(), project_id: s.project_id };
  let edgeCount = 0, commentCount = 0;
  const bytes = body => Buffer.byteLength(JSON.stringify({ ...body, restore_guard: { schema_version: 1, expected_revision: Number.MAX_SAFE_INTEGER, require_empty: false } }));
  const append = (kind, item) => {
    const issueEdges = kind === "issues" ? item.dependencies?.length ?? 0 : 0;
    const issueComments = kind === "issues" ? item.comments?.length ?? 0 : 0;
    const candidate = { ...current, [kind]: [...current[kind], item] };
    if (candidate.issues.length > 200 || edgeCount + issueEdges > 5000 || commentCount + issueComments > 5000 || bytes(candidate) > BATCH_BYTES) {
      if (current.issues.length || current.settings.length || current.memories.length) {
        batches.push(current); current = blank(); edgeCount = 0; commentCount = 0;
      }
    }
    const next = { ...current, [kind]: [...current[kind], item] };
    if (next.issues.length > 200 || issueEdges > 5000 || issueComments > 5000 || bytes(next) > BATCH_BYTES) throw new Error("one snapshot member exceeds the server's bounded import capacity");
    current = next; edgeCount += issueEdges; commentCount += issueComments;
  };
  for (const setting of s.settings) append("settings", setting);
  for (const memory of s.memories) append("memories", memory);
  for (const issue of s.issues) append("issues", { ...cleanIssue(issue), dependencies: edges.get(issue.id) ?? [] });
  if (bytes(current) > BATCH_BYTES) throw new Error("snapshot vocabulary exceeds the server's bounded import capacity");
  batches.push(current);
  return batches;
}

function client(base, token) {
  const origin = new URL(base);
  if (origin.protocol !== "https:" || origin.pathname !== "/" || origin.username || origin.password || origin.search || origin.hash || !token) throw new Error("an explicit HTTPS origin and BEADS_SNAPSHOT_TOKEN are required");
  return async (tracker, suffix, method = "GET", body, idempotency) => {
    const response = await fetch(`${origin.origin}/t/${tracker}/v0/beads${suffix}`, {
      method, redirect: "error", signal: AbortSignal.timeout(30_000),
      headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}), ...(idempotency ? { "Idempotency-Key": idempotency } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`tracker request refused: HTTP ${response.status}`); }
    const reader = response.body.getReader();
    const chunks = []; let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > MAX_BYTES) throw new Error("one tracker response exceeds the snapshot byte budget");
        chunks.push(value);
      }
    } catch (error) { await reader.cancel().catch(() => {}); throw error; }
    finally { reader.releaseLock(); }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw new Error("tracker returned invalid JSON; response content is withheld"); }
  };
}

async function capture(request, tracker) {
  const before = await request(tracker, "/context");
  if (!before.capabilities?.includes("profile.logical_recovery_v1") || !Number.isSafeInteger(before.x_mutation_revision)) throw new Error("store does not advertise guarded logical recovery");
  let consumed = 0;
  const budget = data => { consumed += Buffer.byteLength(canonical(data)); if (consumed > MAX_BYTES) throw new Error("snapshot exceeds the 64 MiB memory budget"); return data; };
  const pages = async (suffix, field, event = false) => {
    const items = []; let cursor; let since = 0;
    for (;;) {
      const page = await request(tracker, `${suffix}${event ? `&since=${since}` : cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      const rows = budget(page[field]);
      if (!Array.isArray(rows)) throw new Error("invalid tracker export response");
      items.push(...rows);
      if (event) {
        if (!rows.length) { if (since !== page.head) throw new Error("incomplete journal export"); break; }
        const next = rows.at(-1).seq;
        if (!Number.isSafeInteger(next) || next <= since) throw new Error("journal cursor did not advance");
        since = next;
        if (since === page.head) break;
      } else {
        if (!page.has_more) break;
        if (!page.next_cursor || page.next_cursor === cursor) throw new Error("export cursor did not advance");
        cursor = page.next_cursor;
      }
    }
    return items;
  };
  const issues = await pages("/issues:export?include_templates=true&include_gates=true&include_infra=true&include_ephemeral=true&limit=200", "items");
  const dependencies = await pages("/dependencies:export?limit=1000", "items");
  const memories = budget((await request(tracker, "/memories")).items);
  const settings = await pages("/config:export?limit=100", "items");
  const statuses = budget((await request(tracker, "/config:statuses:detailed")).statuses);
  const types = budget((await request(tracker, "/config:types")).types);
  const records = await pages("/events?limit=10", "records", true);
  const after = await request(tracker, "/context");
  if (before.x_mutation_revision !== after.x_mutation_revision || before.project_id !== after.project_id ||
      before.x_store_version !== after.x_store_version || before.x_source_sha !== after.x_source_sha) throw new Error("tracker changed during snapshot; stop all writers before retrying a read");
  return { context: after, state: { project_id: after.project_id, issues: orderBy(issues.map(cleanIssue), i => i.id),
    dependencies: orderBy(dependencies, e => `${e.issue_id}\0${e.depends_on_id}`), memories: orderBy(memories, m => m.key), settings: orderBy(settings, s => s.key),
    vocabulary: { statuses: orderBy(statuses, s => s.name), types } }, journal: { head: records.at(-1)?.seq ?? 0, records } };
}

export function writePrivateSnapshot(file, data) {
  const absolute = path.resolve(file);
  const fd = fs.openSync(absolute, "wx", 0o600);
  try {
    if (process.platform === "win32") {
      // Apply and verify an owner-only ACL while the file is still empty, before writing confidential config.
      const script = "$p=$env:TRACKER_SNAPSHOT_FILE; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $acl=New-Object System.Security.AccessControl.FileSecurity; $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false); $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl','Allow'))); Set-Acl -LiteralPath $p -AclObject $acl -ErrorAction Stop";
      const childEnv = { ...process.env, TRACKER_SNAPSHOT_FILE: absolute };
      delete childEnv.PSModulePath;
      const executable = path.join(process.env.SystemRoot ?? "C:/Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      const result = spawnSync(executable, ["-NoProfile", "-NonInteractive", "-Command", script], { env: childEnv, timeout: 10_000, windowsHide: true, encoding: "utf8" });
      if (result.status !== 0) throw new Error("could not apply private snapshot ACL");
    }
    if (!credentialFilePrivate(absolute)) throw new Error("snapshot file is not private");
    fs.writeFileSync(fd, data); fs.fsyncSync(fd);
  } catch (error) { fs.closeSync(fd); fs.unlinkSync(absolute); throw error; }
  fs.closeSync(fd);
}

function readPrivate(file) {
  if (!credentialFilePrivate(file) || fs.statSync(file).size > MAX_BYTES) throw new Error("snapshot must be private and at most 64 MiB");
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { throw new Error("snapshot is not valid JSON; file content is withheld"); }
}

export async function main(args = process.argv.slice(2)) {
  const [command, file, ...flags] = args;
  const trackerAt = flags.indexOf("--tracker");
  const tracker = trackerAt >= 0 ? flags[trackerAt + 1] : undefined;
  if (!["backup", "verify", "restore"].includes(command) || !file) throw new Error("usage: tracker-snapshot.mjs backup|verify|restore <private-file> [--tracker <id> --quiesced --exclusive]");
  if (command === "verify") {
    const envelope = readPrivate(file); const payload = verifySnapshot(envelope);
    console.log(JSON.stringify({ snapshot: "VERIFIED", digest: envelope.integrity.digest, tracker: payload.source.tracker, captured_at: payload.captured_at }));
    return;
  }
  if (!trackerValid(tracker) || !flags.includes("--quiesced")) throw new Error("an explicit tracker and --quiesced maintenance assertion are required");
  const base = process.env.BEADS_CLOUDFLARE_BASE;
  const request = client(base, process.env.BEADS_SNAPSHOT_TOKEN);
  if (command === "backup") {
    const first = await capture(request, tracker);
    const second = await capture(request, tracker);
    if (canonical(first) !== canonical(second)) throw new Error("complete semantic snapshot changed across repeated reads; no archive was written");
    const payload = { format: FORMAT, captured_at: new Date().toISOString(), source: { origin: new URL(base).origin, tracker,
      store_version: second.context.x_store_version, source_sha: second.context.x_source_sha ?? null, mutation_revision: second.context.x_mutation_revision },
      state: second.state, journal: second.journal,
      exclusions: ["api-keys", "oauth-kv-grants", "worker-secrets", "claim-principals-and-fencing", "idempotency-receipts"] };
    const envelope = sealSnapshot(payload); verifySnapshot(envelope);
    const serialized = `${JSON.stringify(envelope)}\n`;
    if (Buffer.byteLength(serialized) > MAX_BYTES) throw new Error("sealed snapshot exceeds the 64 MiB archive budget");
    writePrivateSnapshot(file, serialized);
    console.log(JSON.stringify({ snapshot: "SAVED", tracker, digest: envelope.integrity.digest, source_sha: payload.source.source_sha }));
    return;
  }
  if (!flags.includes("--exclusive")) throw new Error("restore requires --exclusive ownership of a new destination tracker");
  const envelope = readPrivate(file); const snapshot = verifySnapshot(envelope);
  if (snapshot.source.origin === new URL(base).origin && snapshot.source.tracker === tracker) throw new Error("restore never targets the source tracker");
  const batches = restoreBatches(snapshot);
  const destination = await capture(request, tracker);
  assertEmptyDestination(destination, tracker);
  let revision = destination.context.x_mutation_revision;
  let completed = 0;
  const session = randomUUID();
  try {
    for (const [index, body] of batches.entries()) {
      const result = await request(tracker, "/issues:import", "POST", { ...body,
        restore_guard: { schema_version: 1, expected_revision: revision, require_empty: index === 0 } }, `restore:${session}:${index}`);
      if (result.x_mutation_revision !== revision + 1) throw new Error("restore acknowledgement lacks the expected revision");
      revision = result.x_mutation_revision; completed++;
    }
    const restored = await capture(request, tracker);
    if (restored.context.x_mutation_revision !== revision || canonical(restored.state) !== canonical(snapshot.state)) throw new Error("restored semantic state differs from the snapshot");
    console.log(JSON.stringify({ recovery: "VERIFIED", tracker, digest: envelope.integrity.digest, mutation_revision: revision, journal: "archived-source-not-replayed", authorization: "new-credentials-required" }));
  } catch {
    throw new Error(`recovery stopped after ${completed} acknowledged batch(es); destination may contain partial effects. Inspect it; do not retry an uncertain write or overwrite it`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
