// Persisted storage format upgrades (migration): an object created by an older release gains
// the current columns and row shape, and a guarded tracker migration has no partial effects.
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { SCOPE_IMPORT, SCOPE_READ, SCOPE_WRITE } from "../src/auth/scopes";
import { migrateColumns, normalizeRows, ROWS_NORMALIZED } from "../src/tracker/schema";
import { call, tokenFor, tracker } from "./helpers";

const LEGACY_ISSUES = `CREATE TABLE IF NOT EXISTS issues (
  tracker TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  design TEXT NOT NULL DEFAULT '', acceptance_criteria TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 0, issue_type TEXT NOT NULL,
  assignee TEXT NOT NULL DEFAULT '', owner TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL, started_at TEXT, closed_at TEXT,
  close_reason TEXT NOT NULL DEFAULT '', closed_by_session TEXT NOT NULL DEFAULT '',
  external_ref TEXT, due_at TEXT, defer_until TEXT, sender TEXT NOT NULL DEFAULT '',
  metadata TEXT NOT NULL DEFAULT '{}', ephemeral INTEGER NOT NULL DEFAULT 0,
  no_history INTEGER NOT NULL DEFAULT 0, pinned INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1, lease_expires_at TEXT, fencing INTEGER NOT NULL DEFAULT 0,
  estimated_minutes INTEGER,
  PRIMARY KEY (tracker, id)) WITHOUT ROWID`;

describe("schema evolution", () => {
  /**
   * An object created before a column existed must gain it.
   *
   * SCHEMA is CREATE TABLE IF NOT EXISTS throughout, so it creates a missing table
   * and never touches one that already exists. That gap shipped: adding
   * heartbeat_at and claimed_by left every claim in the deployed Worker failing
   * with an opaque SQL error, while every other test here passed, because a fresh
   * local object is built from the current SCHEMA. Only an object that already
   * holds the old shape exercises the migration, so the test builds that shape.
   */
  it("adds a column to an object that was created before it existed", async () => {
    const owner = await tokenFor("schema@example.com");
    const t = tracker("schema", owner);

    // The pre-migration issues table: every column but heartbeat_at and claimed_by.
    // Put the object back into the shape it had before the columns were added, then
    // force its constructor to run again. Creating the legacy table first does not
    // work: runInDurableObject instantiates the object, whose constructor has
    // already created the current shape by the time the test can touch storage.
    const stub = env.TEAM_STORE.get(env.TEAM_STORE.idFromName(env.TEAM));
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec("DROP TABLE IF EXISTS issues");
      state.storage.sql.exec(LEGACY_ISSUES);
      // The step an object runs when it is constructed after a deploy. It is invoked
      // here rather than left to construction because a Durable Object's constructor
      // runs once per object: by the time this test can reach storage, the object has
      // already been constructed by the current code, so waiting for it to happen
      // again would never reproduce the state a real upgrade starts from.
      migrateColumns(state.storage.sql);
    });

    const created = await t.create("migrated row");
    const claim = await t.post(`/issues/${created}:claim`, { actor: "worker" });
    expect(claim.status).toBe(200);

    const after = await t.get(`/issues/${created}`);
    expect(after.body).toMatchObject({ assignee: "worker", status: "in_progress" });
    expect(after.body.heartbeat_at).toBeTruthy();
  });
});

describe("rows written by the first releases", () => {
  // Their flag and JSON columns can hold NULL, text or numbers other than 0 and 1. The default tier filter compares the
  // flags with 0, so such a row vanished from every default list, count, stats and export (5,520 rows on one store).
  const LOOSE_ISSUES = `CREATE TABLE issues (
    tracker TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL, description TEXT, design TEXT, acceptance_criteria TEXT, notes TEXT,
    status TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 2, issue_type TEXT NOT NULL, assignee TEXT, owner TEXT,
    created_at TEXT NOT NULL, created_by TEXT, updated_at TEXT NOT NULL, started_at TEXT, closed_at TEXT, close_reason TEXT,
    closed_by_session TEXT, external_ref TEXT, due_at TEXT, defer_until TEXT, sender TEXT, metadata TEXT,
    ephemeral, no_history, pinned, version INTEGER, lease_expires_at TEXT, fencing INTEGER, estimated_minutes INTEGER,
    PRIMARY KEY (tracker, id)) WITHOUT ROWID`;

  it("shows rows with NULL or non-numeric flags in the default list, count, stats and export", async () => {
    const owner = await tokenFor("legacyrows@example.com");
    const t = tracker("legacyrows", owner);
    const stub = env.TEAM_STORE.get(env.TEAM_STORE.idFromName(env.TEAM));
    await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec("DROP TABLE IF EXISTS issues");
      sql.exec(LOOSE_ISSUES);
      const at = "2025-01-01T00:00:00Z";
      const insert = (id: string, noHistory: unknown, pinned: unknown, metadata: unknown) =>
        sql.exec(
          `INSERT INTO issues (tracker, id, title, status, issue_type, created_at, updated_at, ephemeral, no_history, pinned, metadata)
           VALUES ('legacyrows', ?, ?, 'open', 'task', ?, ?, NULL, ?, ?, ?)`,
          id, id, at, at, noHistory, pinned, metadata,
        );
      insert("old-null", null, null, null);
      insert("old-text", "false", 7, "");
      sql.exec("DELETE FROM meta WHERE key = ?", ROWS_NORMALIZED);
      migrateColumns(sql);
    });

    const ids = (reply: { body: { items?: { id: string }[] } }) => (reply.body.items ?? []).map((i) => i.id).sort();
    const everyRead = async (expected: string[]) => {
      expect(ids(await t.get("/issues?status=all&limit=10"))).toEqual(expected);
      expect((await t.get("/issues:count")).body.total).toBe(expected.length);
      expect((await t.get("/stats")).body.summary.total_issues).toBe(expected.length);
      expect(ids(await t.get("/issues:export?limit=10"))).toEqual(expected);
    };

    // Before any normalization the NULL flags alone must not hide a row.
    expect(ids(await t.get("/issues?status=all&limit=10"))).toContain("old-null");
    expect((await t.get("/issues:count")).body.total).toBeGreaterThanOrEqual(1);

    // The start-up step makes every such row look like a freshly created one, and a second run changes nothing.
    await runInDurableObject(stub, async (_instance, state) => {
      normalizeRows(state.storage.sql);
      normalizeRows(state.storage.sql);
    });
    await everyRead(["old-null", "old-text"]);
  });
});

async function keyWithImport(label: string): Promise<string> {
  const admin = await call("POST", "/admin/keys", env.ADMIN_TOKEN, { label, scopes: [SCOPE_READ, SCOPE_WRITE, SCOPE_IMPORT] });
  expect(admin.status).toBe(201);
  return admin.body.key;
}

describe("guarded tracker migration", () => {
  const rec = (id: string, extra: object = {}) => ({
    id, title: id, priority: 2, status: "open", issue_type: "task", created_at: "2025-01-01T00:00:00Z", updated_at: "2025-03-01T00:00:00Z", ...extra,
  });

  it("guards migration batches against intervening claims and deletion without partial effects", async () => {
    const t = tracker("mrg-guard", await keyWithImport("migration-guard"), "importer");
    const worker = tracker("mrg-guard", await tokenFor("migration-worker@example.com"), "worker");
    const held = "mrg-guard-held", deleted = "mrg-guard-deleted", admitted = "mrg-guard-admitted", created = "mrg-guard-created";
    const first = "mrg-guard-first";
    const head = async () => (await t.get("/events?since=0&limit=1")).body.head as number;
    const guarded = (expected_event_head: number, issues: object[], extra: object = {}) => ({
      mode: "merge", reject_stale: true, migration_guard: { schema_version: 1, expected_event_head }, issues, ...extra,
    });
    const post = (body: object) => t.post("/issues:import", body);
    const capabilities = (await t.get("/context")).body.capabilities as string[];
    if (!capabilities.includes("profile.import_migration_guard_v1")) throw new Error("Guarded migration is not supported");
    expect((await post({ issues: [rec(held), rec(deleted), rec(admitted)] })).status).toBe(200);

    const planned = await head();
    expect((await worker.post(`/issues/${held}:claim`, {})).status).toBe(200);
    const claimBefore = (await t.get(`/issues/${held}?include_comments=true`)).body;
    const attemptedClaim = rec(held, { status: claimBefore.status, assignee: claimBefore.assignee,
      updated_at: "2099-01-01T00:00:00Z", notes: "must not overwrite", labels: ["must-not-add"],
      comments: [{ author: "source", text: "must not append", created_at: "2099-01-01T00:00:00Z" }] });
    const firstRow = rec(first);
    const raced = await post(guarded(planned, [firstRow, attemptedClaim]));
    expect(raced.status).toBe(409);
    expect(raced.body).toMatchObject({ code: "precondition_failed", reason: "migration_event_head_changed" });
    const claimedHead = await head();
    const claimed = await post(guarded(claimedHead, [firstRow, attemptedClaim]));
    expect(claimed.status).toBe(409);
    expect(claimed.body).toMatchObject({ reason: "migration_claimed_issue", x_issue_id: held });
    expect((await t.get(`/issues/${held}?include_comments=true`)).body).toEqual(claimBefore);
    expect((await t.get(`/issues/${first}`)).status).toBe(404);
    expect(await head()).toBe(claimedHead);

    const beforeDelete = await head();
    expect((await t.post("/issues:delete", { ids: [deleted], force: true })).status).toBe(200);
    const futureDeleted = rec(deleted, { updated_at: "2099-01-01T00:00:00Z" });
    const deletionRace = await post(guarded(beforeDelete, [firstRow, futureDeleted]));
    expect(deletionRace.status).toBe(409);
    expect(deletionRace.body).toMatchObject({ reason: "migration_event_head_changed" });
    const deletedHead = await head();
    const tombstoned = await post(guarded(deletedHead, [firstRow, futureDeleted]));
    expect(tombstoned.status).toBe(409);
    expect(tombstoned.body).toMatchObject({ reason: "migration_tombstoned_issue", x_issue_id: deleted });
    expect((await t.get(`/issues/${deleted}`)).status).toBe(404);
    expect((await t.get(`/issues/${first}`)).status).toBe(404);
    expect(await head()).toBe(deletedHead);

    const before = (await t.get(`/issues/${admitted}`)).body;
    const equalTime = await post(guarded(deletedHead, [firstRow, rec(admitted, { labels: ["must-not-add"] })]));
    expect(equalTime.status).toBe(409);
    expect(equalTime.body).toMatchObject({ reason: "migration_record_not_newer" });
    expect((await t.get(`/issues/${admitted}`)).body).toEqual(before);
    expect((await t.get(`/issues/${first}`)).status).toBe(404);

    const foreign = "foreign-migration-identity";
    const prefixBypass = await post(guarded(deletedHead, [firstRow, rec(foreign)], { skip_prefix_validation: true }));
    expect(prefixBypass.status).toBe(400);
    expect((await t.get(`/issues/${foreign}`)).status).toBe(404);
    expect((await t.get(`/issues/${first}`)).status).toBe(404);
    expect(await head()).toBe(deletedHead);

    const candidates = [rec(created, { description: "created by admitted migration" }), rec(admitted, {
      updated_at: "2025-04-01T00:00:00Z", notes: "migrated", labels: ["migrated"],
      comments: [{ author: "source-author", text: "preserved provenance", created_at: "2025-04-01T00:00:00Z" }],
    })];
    for (const extra of [{ memories: [] }, { sync_issue_prefix: "other" }, { override_claims: true }, { reject_stale: false },
      { migration_guard: { schema_version: 1, expected_event_head: -1 } },
      { migration_guard: { schema_version: 1, expected_event_head: deletedHead, unsafe: true } }]) {
      expect((await post(guarded(deletedHead, candidates, extra))).status).toBe(400);
    }
    expect((await worker.post("/issues:import", guarded(deletedHead, candidates))).status).toBe(403);
    expect((await t.get(`/issues/${admitted}`)).body).toEqual(before);
    expect((await t.get(`/issues/${created}`)).status).toBe(404);
    expect(await head()).toBe(deletedHead);

    const accepted = await post(guarded(deletedHead, candidates));
    expect(accepted.status).toBe(200);
    expect(accepted.body.migration_guard).toEqual({ schema_version: 1, expected_event_head: deletedHead, event_head: await head() });
    expect(accepted.body.migration_guard.event_head).toBeGreaterThan(deletedHead);
    expect((await t.get(`/issues/${created}`)).body.description).toBe("created by admitted migration");
    expect((await t.get(`/issues/${admitted}?include_comments=true`)).body).toMatchObject({ notes: "migrated", labels: ["migrated"],
      comments: [{ author: "source-author", text: "preserved provenance" }] });
    expect((await t.get(`/issues/${held}?include_comments=true`)).body).toEqual(claimBefore);
    expect((await t.get(`/issues/${deleted}`)).status).toBe(404);
  });
});
