import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertEmptyDestination, main, parseSnapshot, readSnapshotFile, restoreBatches, sealSnapshot, snapshotPartPath, verifySnapshot, writePrivateSnapshot } from "../scripts/tracker-snapshot.mjs";
import { credentialFilePrivate } from "../cli/github-auth.mjs";
import { archiveSnapshot, captureSnapshot, expiredSnapshotKeys, readStateParts, SNAPSHOT_EXCLUSIONS, SNAPSHOT_FORMAT, SNAPSHOT_FORMAT_V2 } from "../src/tracker/snapshot-core.mjs";

const sha256 = async text => createHash("sha256").update(text).digest("hex");
const byteLength = text => Buffer.byteLength(text);

function fixture({ issues = 2, events = 4, actor = "historical", mutate } = {}) {
  const issueRows = Array.from({ length: issues }, (_, index) => ({ id: `source-${String.fromCharCode(98 - index)}`, title: "restore me", status: "open", priority: 2, is_blocked: true }));
  const records = Array.from({ length: events }, (_, index) => ({ seq: index + 1, ts: "2025-01-01T00:00:00Z", op: "create", issue_id: "source-b", actor, issue: null }));
  const context = { capabilities: ["profile.logical_recovery_v1"], x_mutation_revision: 3, project_id: "source", x_store_version: "1", x_source_sha: "abc" };
  let passes = 0;
  return async (_tracker, suffix) => {
    const url = new URL(`https://beads.test${suffix}`);
    if (url.pathname === "/context") return mutate?.context?.(context, passes) ?? { ...context };
    if (url.pathname === "/issues:export") {
      if (!url.searchParams.get("cursor")) passes += 1;
      const start = Number(url.searchParams.get("cursor") ?? "0");
      const page = issueRows.slice(start, start + 1).map(issue => mutate?.issue?.(issue, passes) ?? issue);
      const more = start + 1 < issueRows.length;
      return { items: page, has_more: more, ...(more ? { next_cursor: String(start + 1) } : {}) };
    }
    if (url.pathname === "/dependencies:export") return { items: [{ issue_id: "source-b", depends_on_id: "external:retained", type: "blocks", created_at: "2025-01-01T00:00:00Z", created_by: "historical", metadata: "{}" }], has_more: false };
    if (url.pathname === "/memories") return { items: [{ key: "memory", value: "durable note" }] };
    if (url.pathname === "/config:export") return { items: [{ key: "kv.private", value: "private value" }], has_more: false };
    if (url.pathname === "/config:statuses:detailed") return { statuses: [{ name: "open", category: "open" }] };
    if (url.pathname === "/config:types") return { types: ["task"] };
    if (url.pathname === "/events") {
      const since = Number(url.searchParams.get("since") ?? "0");
      const limit = Number(url.searchParams.get("limit") ?? "10");
      const head = records.at(-1)?.seq ?? 0;
      return { head, records: records.filter(record => record.seq > since).slice(0, limit) };
    }
    throw new Error(`unexpected ${suffix}`);
  };
}

const archiveOptions = (request, extra = {}) => ({
  origin: "https://beads.example", byteLength, sha256, now: () => new Date("2026-01-01T00:00:00.000Z"), eventLimit: 3, ...extra,
  emit: extra.emit,
});

const emptyState = () => ({ project_id: "scratch-target", issues: [], dependencies: [], memories: [], settings: [], vocabulary: { statuses: [], types: [] } });
const payload = () => ({ format: "beads-cloudflare.logical-snapshot/v1", source: { tracker: "source" }, state: emptyState(), journal: { head: 0, records: [] } });

test("detects changed snapshot content before it can become a restore plan", () => {
  const archive = sealSnapshot(payload());
  assert.deepEqual(verifySnapshot(archive), archive.payload);
  archive.payload.state.settings.push({ key: "private-config", value: "changed" });
  assert.throws(() => verifySnapshot(archive), /integrity/);
  const brokenJournal = payload();
  brokenJournal.journal.head = 9;
  assert.throws(() => verifySnapshot(sealSnapshot(brokenJournal)), /journal/);
});

test("refuses occupied recovery destinations and live claim custody", () => {
  assert.doesNotThrow(() => assertEmptyDestination({ context: { x_mutation_revision: 0 }, state: emptyState(), journal: { head: 0 } }, "scratch-target"));
  assert.throws(() => assertEmptyDestination({ context: { x_mutation_revision: 2 }, state: emptyState(), journal: { head: 0 } }, "scratch-target"), /empty destination/);
  for (const plane of ["issues", "dependencies", "memories", "settings"]) {
    const state = emptyState(); state[plane].push({ restored: false });
    assert.throws(() => assertEmptyDestination({ context: { x_mutation_revision: 0 }, state, journal: { head: 0 } }, "scratch-target"), /empty destination/);
  }
  for (const plane of ["statuses", "types"]) {
    const state = emptyState(); state.vocabulary[plane].push("retained");
    assert.throws(() => assertEmptyDestination({ context: { x_mutation_revision: 0 }, state, journal: { head: 0 } }, "scratch-target"), /empty destination/);
  }
  assert.throws(() => assertEmptyDestination({ context: { x_mutation_revision: 0 }, state: emptyState(), journal: { head: 7 } }, "scratch-target"), /empty destination/);
  const claimed = payload();
  claimed.state.issues.push({ id: "source-claim", status: "in_progress", assignee: "worker", lease_expires_at: new Date(Date.now() + 60_000).toISOString() });
  assert.throws(() => restoreBatches(claimed), /claim/);
});

test("plans bounded recovery batches without losing records, configuration or relation provenance", () => {
  const snapshot = payload();
  snapshot.state.settings = [{ key: "kv.private", value: "private value" }];
  snapshot.state.memories = [{ key: "memory", value: "durable note" }];
  snapshot.state.issues = Array.from({ length: 201 }, (_, i) => ({ id: `source-${i}`, title: "restore me", priority: 2,
    created_at: "2025-01-01T00:00:00Z", status: "open", comments: [{ id: `c-${i}`, author: "historical", text: "kept", created_at: "2025-01-01T00:00:00Z" }] }));
  snapshot.state.dependencies = [{ issue_id: "source-0", depends_on_id: "external:retained", type: "blocks", created_at: "2025-01-01T00:00:00Z", created_by: "historical", metadata: "{}" }];
  const batches = restoreBatches(snapshot);
  assert.deepEqual(batches.flatMap(batch => batch.issues).map(({ dependencies, ...issue }) => issue), snapshot.state.issues);
  assert.deepEqual(batches.flatMap(batch => batch.issues.flatMap(issue => issue.dependencies)), snapshot.state.dependencies);
  assert.deepEqual(batches.flatMap(batch => batch.settings), snapshot.state.settings);
  assert.deepEqual(batches.flatMap(batch => batch.memories), snapshot.state.memories);
  assert.ok(batches.every(batch => batch.issues.length <= 200 && Buffer.byteLength(JSON.stringify(batch)) < (16 << 20)));
});

test("writes private snapshot files without overwriting an existing archive", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "beads-snapshot-pure-"));
  const file = path.join(directory, "snapshot.json");
  try {
    const content = JSON.stringify(sealSnapshot(payload()));
    writePrivateSnapshot(file, content);
    assert.equal(credentialFilePrivate(file), true);
    assert.equal(fs.readFileSync(file, "utf8"), content);
    assert.throws(() => writePrivateSnapshot(file, "replace"));
    assert.equal(fs.readFileSync(file, "utf8"), content);
  } finally { fs.rmSync(file, { force: true }); fs.rmdirSync(directory); }
});

test("invalid archive JSON never exposes file content in the CLI failure", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "beads-snapshot-invalid-"));
  const file = path.join(directory, "snapshot.json");
  const secret = "private-value-must-not-appear-in-errors";
  try {
    writePrivateSnapshot(file, `{ "token": "${secret}" trailing-content`);
    await assert.rejects(main(["verify", file]), error => !error.message.includes(secret) && error.message.includes("content is withheld"));
  } finally { fs.rmSync(file, { force: true }); fs.rmdirSync(directory); }
});

test("keeps a tracker that fits as one v1 archive and reads the journal length without its records", async () => {
  const emitted = [];
  const archived = await archiveSnapshot(fixture(), "source", archiveOptions(null, { emit: async item => emitted.push(item) }));
  assert.equal(archived.format, SNAPSHOT_FORMAT);
  assert.equal(emitted.length, 1);
  const envelope = JSON.parse(emitted[0].body);
  const payload = verifySnapshot(envelope);
  assert.equal(payload.journal.head, 4);
  assert.equal(payload.journal.records.length, 4);
  assert.deepEqual(payload.exclusions, SNAPSHOT_EXCLUSIONS);
  assert.equal(payload.state.issues[0].is_blocked, undefined);
  const headOnly = await captureSnapshot(fixture(), "source", { byteLength, journal: "head" });
  assert.equal(headOnly.journal.head, 4);
  assert.deepEqual(headOnly.journal.records, []);
  assert.deepEqual(headOnly.state.issues.map(issue => issue.id), ["source-a", "source-b"]);
});

test("stores a journal past the resident budget as ordered parts without holding it all", async () => {
  const emitted = [];
  const archived = await archiveSnapshot(fixture({ events: 12, actor: "a".repeat(40) }), "source", archiveOptions(null, {
    residentBytes: 80, partBytes: 70, emit: async item => emitted.push(item),
  }));
  assert.equal(archived.format, SNAPSHOT_FORMAT_V2);
  assert.equal(archived.journalHead, 12);
  assert.ok(archived.parts > 1);
  assert.ok(archived.peakResident < archived.accounted, `resident peak ${archived.peakResident} covered the whole archive ${archived.accounted}`);
  assert.equal(emitted.at(-1).role, "manifest");
  const parts = new Map(emitted.filter(item => item.role === "part").map(item => [item.name, JSON.parse(item.body)]));
  const opened = parseSnapshot(JSON.parse(emitted.at(-1).body), name => parts.get(name));
  assert.deepEqual(opened.payload.exclusions, SNAPSHOT_EXCLUSIONS);
  assert.equal(opened.payload.journal.head, 12);
  assert.equal(opened.payload.journal.records.length, 0);
  assert.deepEqual(opened.payload.state.issues.map(issue => issue.id), ["source-a", "source-b"]);
  assert.equal(opened.payload.state.issues[0].is_blocked, undefined);
  assert.equal(opened.payload.state.dependencies[0].depends_on_id, "external:retained");
  assert.equal(opened.payload.state.settings[0].value, "private value");
  const live = await readStateParts(fixture({ events: 12, actor: "a".repeat(40) }), "source", { byteLength, sha256, partBytes: opened.payload.part_bytes, eventLimit: 3 });
  assert.deepEqual(live.parts.map(part => part.recordsDigest), opened.payload.parts.filter(part => part.section !== "journal").map(part => part.records_digest));
  assert.doesNotThrow(() => restoreBatches(opened.payload));
  const tampered = structuredClone(parts.get("part-00000.json"));
  tampered.payload.records[0].title = "tampered";
  assert.throws(() => parseSnapshot(JSON.parse(emitted.at(-1).body), name => name === "part-00000.json" ? tampered : parts.get(name)), /integrity|journal|invalid/);
});

test("writes no manifest when the tracker changes or a part upload fails", async () => {
  const emitted = [];
  await assert.rejects(archiveSnapshot(fixture({ mutate: { issue: (issue, passes) => passes > 1 ? { ...issue, title: "changed" } : issue } }), "source", archiveOptions(null, {
    residentBytes: 80, partBytes: 70, emit: async item => emitted.push(item),
  })), /no archive was written/);
  assert.equal(emitted.length, 0);
  await assert.rejects(archiveSnapshot(fixture({ mutate: { context: (context, passes) => ({ ...context, x_mutation_revision: passes > 0 ? 9 : context.x_mutation_revision }) } }), "source", archiveOptions(null, {
    emit: async () => { throw new Error("should not emit"); },
  })), /tracker changed during snapshot/);
  const written = [];
  const removed = [];
  await assert.rejects(archiveSnapshot(fixture({ events: 12, actor: "a".repeat(40) }), "source", archiveOptions(null, {
    residentBytes: 80, partBytes: 70,
    emit: async item => { if (written.length === 1) throw new Error("upload failed"); written.push(item.name); },
    abort: async names => removed.push(...names),
  })), /upload failed/);
  assert.deepEqual(removed, written);
  assert.equal(removed.includes("manifest"), false);
});

test("reads a private v2 manifest from its sibling part directory", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "beads-snapshot-v2-"));
  const manifest = path.join(directory, "day.snapshot.json");
  try {
    await archiveSnapshot(fixture({ events: 6, actor: "a".repeat(30) }), "source", archiveOptions(null, {
      residentBytes: 40, partBytes: 50,
      emit: async item => {
        const target = item.role === "part" ? snapshotPartPath(manifest, item.name) : manifest;
        if (item.role === "part") fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
        writePrivateSnapshot(target, item.body);
      },
    }));
    const opened = readSnapshotFile(manifest);
    assert.equal(opened.payload.format, SNAPSHOT_FORMAT_V2);
    assert.equal(opened.payload.journal.head, 6);
    assert.equal(credentialFilePrivate(snapshotPartPath(manifest, "part-00000.json")), true);
    assert.throws(() => snapshotPartPath(manifest, "../part-00000.json"), /part name/);
    fs.rmSync(snapshotPartPath(manifest, "part-00000.json"));
    assert.throws(() => readSnapshotFile(manifest), /private|JSON|invalid|ENOENT/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("rereads an events page that does not fit in the response budget", async () => {
  const inner = fixture({ events: 6, actor: "a".repeat(20) });
  const request = async (tracker, suffix) => {
    const url = new URL(`https://beads.test${suffix}`);
    if (url.pathname === "/events" && Number(url.searchParams.get("limit")) > 2) throw new Error("one tracker response exceeds the snapshot byte budget");
    return inner(tracker, suffix);
  };
  const emitted = [];
  const archived = await archiveSnapshot(request, "source", archiveOptions(null, {
    residentBytes: 40, partBytes: 50, eventLimit: 100, emit: async item => emitted.push(item),
  }));
  const manifest = emitted.find(item => item.role === "manifest" || item.role === "archive");
  const opened = manifest.role === "manifest"
    ? parseSnapshot(JSON.parse(manifest.body), name => JSON.parse(emitted.find(item => item.name === name).body))
    : { payload: verifySnapshot(JSON.parse(manifest.body)) };
  assert.equal(opened.payload.journal.head, 6);
  assert.equal(archived.journalHead, 6);
});

test("keeps every part of a retained manifest and drops failed part uploads", () => {
  const expired = expiredSnapshotKeys([
    { key: "snapshots/alpha/2026-10-01.snapshot.json", uploaded: 10 },
    { key: "snapshots/alpha/2026-10-01/part-00000.json", uploaded: 10 },
    { key: "snapshots/alpha/2026-10-20.snapshot.json", uploaded: 50 },
    { key: "snapshots/alpha/2026-10-20/part-00000.json", uploaded: 40 },
    { key: "snapshots/alpha/2026-10-20/part-00001.json", uploaded: 49 },
    { key: "snapshots/alpha/2026-10-20/notes.txt", uploaded: 1 },
    { key: "snapshots/alpha/orphan/part-00000.json", uploaded: 1 },
    { key: "snapshots/beta/2026-10-01.snapshot.json", uploaded: 10 },
    { key: "snapshots/beta/2026-10-02.snapshot.json", uploaded: 200 },
    { key: "snapshots/beta/2026-10-02/part-00000.json", uploaded: 20 },
  ], 100);
  assert.deepEqual(expired.sort(), [
    "snapshots/alpha/2026-10-01.snapshot.json",
    "snapshots/alpha/2026-10-01/part-00000.json",
    "snapshots/alpha/orphan/part-00000.json",
    "snapshots/beta/2026-10-01.snapshot.json",
  ].sort());
  assert.equal(expired.includes("snapshots/alpha/2026-10-20/part-00000.json"), false);
  assert.equal(expired.includes("snapshots/beta/2026-10-02/part-00000.json"), false);
});
