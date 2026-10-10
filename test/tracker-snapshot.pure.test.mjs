import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertEmptyDestination, main, restoreBatches, sealSnapshot, verifySnapshot, writePrivateSnapshot } from "../scripts/tracker-snapshot.mjs";
import { credentialFilePrivate } from "../cli/github-auth.mjs";

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
