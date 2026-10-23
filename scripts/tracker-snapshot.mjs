#!/usr/bin/env node
// Private logical snapshots through the authenticated tracker API, never direct SQL or admin custody.
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { credentialFilePrivate } from "../cli/github-auth.mjs";
import { assembleState, archiveSnapshot, canonical, captureSnapshot, cleanIssue, readStateParts, SNAPSHOT_FORMAT as FORMAT, SNAPSHOT_FORMAT_V2 as FORMAT_V2, SNAPSHOT_PART_FORMAT as PART_FORMAT, SNAPSHOT_MAX_BYTES as MAX_BYTES } from "../src/tracker/snapshot-core.mjs";

export { canonical };
const BATCH_BYTES = 15 << 20;
const trackerValid = value => typeof value === "string" && value.length <= 40 && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(value);
const hash = value => createHash("sha256").update(canonical(value)).digest("hex");

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

/** Part files sit beside a manifest: `day.snapshot.json` → `day/part-00000.json`. */
export function snapshotPartPath(manifestFile, name) {
  if (!/^part-\d{5}\.json$/.test(name)) throw new Error("snapshot part name is invalid");
  const baseName = path.basename(manifestFile);
  const dirName = baseName.endsWith(".snapshot.json") ? baseName.slice(0, -".snapshot.json".length) : baseName.slice(0, -path.extname(baseName).length);
  if (!dirName || dirName === "." || dirName === "..") throw new Error("snapshot part path is invalid");
  const dir = path.resolve(path.dirname(manifestFile), dirName);
  const resolved = path.resolve(dir, name);
  const relative = path.relative(dir, resolved);
  if (relative !== name || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("snapshot part path is invalid");
  return resolved;
}

function verifyState(state) {
  if (typeof state?.project_id !== "string" || !["issues", "dependencies", "memories", "settings"].every(key => Array.isArray(state[key])) ||
      !Array.isArray(state.vocabulary?.statuses) || !Array.isArray(state.vocabulary?.types)) throw new Error("snapshot format or integrity is invalid");
  const identities = new Set();
  for (const issue of state.issues) {
    if (typeof issue?.id !== "string" || identities.has(issue.id)) throw new Error("snapshot issue identities are invalid");
    identities.add(issue.id);
  }
  for (const edge of state.dependencies) {
    if (!identities.has(edge.issue_id) || typeof edge.depends_on_id !== "string") throw new Error("snapshot has an edge without a restorable source issue");
  }
  for (const key of ["memories", "settings"]) {
    const keys = new Set();
    for (const entry of state[key]) {
      if (typeof entry?.key !== "string" || typeof entry.value !== "string" || keys.has(entry.key)) throw new Error(`snapshot ${key} are invalid`);
      keys.add(entry.key);
    }
  }
  return state;
}

/** v1 envelope, or a v2 manifest plus part envelopes from `readPart(name)`. Journal parts are checked and dropped. */
export function parseSnapshot(envelope, readPart) {
  if (envelope?.payload?.format === FORMAT_V2) return parseSnapshotV2(envelope, readPart);
  return { envelope, payload: verifySnapshot(envelope) };
}

function parseSnapshotV2(envelope, readPart) {
  const p = envelope?.payload;
  if (envelope?.integrity?.algorithm !== "sha256" || envelope.integrity.digest !== hash(p) || !trackerValid(p?.source?.tracker) ||
      typeof p.state?.project_id !== "string" || typeof p.captured_at !== "string" || !Number.isSafeInteger(p.part_bytes) || p.part_bytes < 1 || p.part_bytes > MAX_BYTES ||
      !Array.isArray(p.parts) || !Array.isArray(p.exclusions) || !Number.isSafeInteger(p.journal?.head) || p.journal.head < 0 || !Number.isSafeInteger(p.journal.records) || p.journal.records < 0) {
    throw new Error("snapshot format or integrity is invalid");
  }
  const stateParts = [];
  let seq = 0;
  let journalRecords = 0;
  let journalStarted = false;
  for (const [index, spec] of p.parts.entries()) {
    if (!spec || spec.index !== index || spec.name !== `part-${String(index).padStart(5, "0")}.json` || typeof spec.digest !== "string" || typeof spec.records_digest !== "string" || !Number.isSafeInteger(spec.count) || spec.count < 0) {
      throw new Error("snapshot format or integrity is invalid");
    }
    if (spec.section === "journal") journalStarted = true;
    else if (journalStarted || !["issues", "dependencies", "memories", "settings", "vocabulary"].includes(spec.section)) throw new Error("snapshot journal is incomplete");
    const partEnvelope = readPart(spec.name);
    const part = partEnvelope?.payload;
    if (partEnvelope?.integrity?.algorithm !== "sha256" || partEnvelope.integrity.digest !== spec.digest || hash(part) !== spec.digest ||
        part?.format !== PART_FORMAT || part.section !== spec.section || part.index !== index || part.tracker !== p.source.tracker || part.captured_at !== p.captured_at) {
      throw new Error("snapshot format or integrity is invalid");
    }
    const body = part.section === "vocabulary" ? part.vocabulary : part.records;
    if (part.section === "vocabulary") {
      if (!Array.isArray(part.vocabulary?.statuses) || !Array.isArray(part.vocabulary?.types)) throw new Error("snapshot format or integrity is invalid");
    } else if (!Array.isArray(part.records)) throw new Error("snapshot format or integrity is invalid");
    if (hash(body) !== spec.records_digest) throw new Error("snapshot format or integrity is invalid");
    if (part.section === "vocabulary") {
      if (spec.count !== part.vocabulary.statuses.length + part.vocabulary.types.length) throw new Error("snapshot format or integrity is invalid");
      stateParts.push(part);
    } else if (part.section === "journal") {
      if (spec.count !== part.records.length || spec.seq_first !== part.records[0]?.seq || spec.seq_last !== part.records.at(-1)?.seq) throw new Error("snapshot journal order is invalid");
      for (const event of part.records) {
        if (!Number.isSafeInteger(event.seq) || event.seq <= seq || event.seq > p.journal.head) throw new Error("snapshot journal order is invalid");
        seq = event.seq;
      }
      journalRecords += part.records.length;
    } else {
      if (!Array.isArray(part.records) || spec.count !== part.records.length) throw new Error("snapshot format or integrity is invalid");
      stateParts.push(part);
    }
  }
  if (seq !== p.journal.head || journalRecords !== p.journal.records) throw new Error("snapshot journal is incomplete");
  const state = verifyState(assembleState(p.state.project_id, stateParts));
  return { envelope, payload: { format: p.format, captured_at: p.captured_at, source: p.source, state, journal: { head: p.journal.head, records: [] }, exclusions: p.exclusions, part_bytes: p.part_bytes, parts: p.parts } };
}

export function readSnapshotFile(file) {
  const envelope = readPrivate(file);
  if (envelope?.payload?.format !== FORMAT_V2) return { envelope, payload: verifySnapshot(envelope) };
  return parseSnapshot(envelope, name => readPrivate(snapshotPartPath(file, name)));
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

const capture = (request, tracker) => captureSnapshot(request, tracker, { byteLength: text => Buffer.byteLength(text), journal: "head" });
const digestText = async text => createHash("sha256").update(text).digest("hex");

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
    const { envelope, payload } = readSnapshotFile(file);
    console.log(JSON.stringify({ snapshot: "VERIFIED", digest: envelope.integrity.digest, tracker: payload.source.tracker, captured_at: payload.captured_at, format: payload.format }));
    return;
  }
  if (!trackerValid(tracker) || !flags.includes("--quiesced")) throw new Error("an explicit tracker and --quiesced maintenance assertion are required");
  const base = process.env.BEADS_CLOUDFLARE_BASE;
  const request = client(base, process.env.BEADS_SNAPSHOT_TOKEN);
  if (command === "backup") {
    const written = [];
    const archived = await archiveSnapshot(request, tracker, {
      origin: new URL(base).origin, byteLength: text => Buffer.byteLength(text), sha256: digestText, eventLimit: 1000,
      emit: async item => {
        const target = item.role === "part" ? snapshotPartPath(file, item.name) : file;
        if (item.role === "part") fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
        writePrivateSnapshot(target, item.body);
        written.push(target);
      },
      abort: async () => { for (const target of written.reverse()) fs.rmSync(target, { force: true }); },
    });
    console.log(JSON.stringify({ snapshot: "SAVED", tracker, digest: archived.digest, format: archived.format, parts: archived.parts }));
    return;
  }
  if (!flags.includes("--exclusive")) throw new Error("restore requires --exclusive ownership of a new destination tracker");
  const { envelope, payload: snapshot } = readSnapshotFile(file);
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
    if (snapshot.format === FORMAT_V2) {
      const live = await readStateParts(request, tracker, { byteLength: text => Buffer.byteLength(text), sha256: digestText, partBytes: snapshot.part_bytes });
      const expected = snapshot.parts.filter(part => part.section !== "journal").map(part => part.records_digest);
      const actual = live.parts.map(part => part.recordsDigest);
      if (live.context.x_mutation_revision !== revision || live.context.project_id !== snapshot.state.project_id || canonical(expected) !== canonical(actual)) throw new Error("restored semantic state differs from the snapshot");
    } else {
      const restored = await capture(request, tracker);
      if (restored.context.x_mutation_revision !== revision || canonical(restored.state) !== canonical(snapshot.state)) throw new Error("restored semantic state differs from the snapshot");
    }
    console.log(JSON.stringify({ recovery: "VERIFIED", tracker, digest: envelope.integrity.digest, mutation_revision: revision, journal: "archived-source-not-replayed", authorization: "new-credentials-required" }));
  } catch {
    throw new Error(`recovery stopped after ${completed} acknowledged batch(es); destination may contain partial effects. Inspect it; do not retry an uncertain write or overwrite it`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
