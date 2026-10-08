import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { SCOPE_READ } from "../src/auth/scopes";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { migrateColumns, normalizeRows, ROWS_NORMALIZED } from "../src/tracker/schema";
import { call, tokenFor, tracker } from "./helpers";

describe("tracker store behaviors", () => {
  it("lets exactly one of 20 concurrent claimNext requests win the single ready item", async () => {
    const owner = await tokenFor("owner@example.com");
    await tracker("race", owner).create("only item");

    const racers = await Promise.all(Array.from({ length: 20 }, (_, i) => tokenFor(`racer${i}@example.com`)));
    const replies = await Promise.all(racers.map((token, i) => tracker("race", token, `racer${i}`).post("/issues:claimNext", {})));

    const winners = replies.filter((r) => r.body.claimed);
    const nothing = replies.filter((r) => r.status === 200 && r.body.claimed === undefined);
    expect(winners).toHaveLength(1);
    expect(nothing).toHaveLength(19);
    // The assignee is the name the winner allocated the work to; the credential that
    // won is recorded separately as the claim holder.
    expect(winners[0]!.body.claimed.assignee).toMatch(/^racer\d+$/);
  });

  it("answers a retried create once: same key replays, a different body under that key is refused", async () => {
    const token = await tokenFor("writer@example.com");
    const t = tracker("idem", token);
    const body = { title: "write once", issue_type: "task", priority: 1 };
    const headers = { "Idempotency-Key": "k-1" };

    const first = await t.post("/issues", body, headers);
    const second = await t.post("/issues", body, headers);
    expect(first.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(second.headers.get("Idempotency-Replayed")).toBe("true");

    const reused = await t.post("/issues", { ...body, title: "something else" }, headers);
    expect(reused.status).toBe(409);
    expect(reused.body).toMatchObject({ code: "precondition_failed", reason: "idempotency_key_reused" });
    expect(reused.headers.get("Content-Type")).toContain("application/problem+json");

    const issues = await t.get("/issues");
    expect(issues.body.items.map((i: { id: string }) => i.id)).toEqual([first.body.id]);
    const events = await t.get("/events?since=0");
    expect(events.body.records.filter((e: { op: string }) => e.op === "create")).toHaveLength(1);
  });

  it("keeps a blocked item out of the ready set until its blocker closes", async () => {
    const token = await tokenFor("planner@example.com");
    const t = tracker("ready", token);
    const blocker = await t.create("blocker");
    const blocked = await t.create("blocked");
    const added = await t.post("/dependencies:add", { edges: [{ issue_id: blocked, depends_on_id: blocker, type: "blocks" }] });
    expect(added.status).toBe(200);

    const ids = async () => (await t.get("/ready")).body.items.map((i: { id: string }) => i.id);
    expect(await ids()).toEqual([blocker]);

    const closed = await t.post(`/issues/${blocker}:close`, { reason: "done" });
    expect(closed.status).toBe(200);
    expect(await ids()).toEqual([blocked]);
    expect((await t.get("/ready:count")).body).toEqual({ total: 1 });
  });

  it("refuses a stale claimant: after the lease expires and another principal reclaims, the old fencing token cannot close", async () => {
    const alice = tracker("lease", await tokenFor("alice@example.com"), "alice");
    const bob = tracker("lease", await tokenFor("bob@example.com"), "bob");
    const id = await alice.create("contended");

    const first = await alice.post(`/issues/${id}:claim`, { x_lease_seconds: 1 });
    expect(first.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 1200));

    const second = await bob.post(`/issues/${id}:claim`, {});
    expect(second.status).toBe(200);
    expect(second.body.x_fencing_token).toBeGreaterThan(first.body.x_fencing_token);

    const stale = await alice.post(`/issues/${id}:close`, { x_fencing_token: first.body.x_fencing_token });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: "precondition_failed", reason: "stale_claim" });
    const after = await alice.get(`/issues/${id}`);
    expect(after.body).toMatchObject({ status: "in_progress", assignee: "bob" });
  });
});

describe("claim and hierarchy invariants", () => {
  it("does not let a principal without the live claim close the item through PATCH or close", async () => {
    const alice = tracker("claimguard", await tokenFor("alice2@example.com"), "alice");
    const bob = tracker("claimguard", await tokenFor("bob2@example.com"), "bob");
    const id = await alice.create("contended");

    expect((await alice.post(`/issues/${id}:claim`, { x_lease_seconds: 1 })).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect((await bob.post(`/issues/${id}:claim`, {})).status).toBe(200);

    const patched = await alice.patch(`/issues/${id}`, { patch: { status: "closed" } });
    expect(patched.status).toBe(409);
    expect(patched.body).toMatchObject({ code: "already_claimed", reason: "claimed_by_other", assignee: "bob", x_claimed_by: "bob2@example.com" });
    const closed = await alice.post(`/issues/${id}:close`, {});
    expect(closed.body).toMatchObject({ code: "already_claimed", reason: "claimed_by_other" });
    expect((await alice.get(`/issues/${id}`)).body).toMatchObject({ status: "in_progress", assignee: "bob" });
  });

  it("refuses a create whose blocking edge only becomes an ancestor block through its own parent-child edge", async () => {
    const t = tracker("deadlock", await tokenFor("planner2@example.com"));
    const a = await t.create("ancestor");
    const p = await t.create("parent", { parent_id: a });

    const refused = await t.post("/issues", {
      title: "x",
      issue_type: "task",
      dependencies: [
        { target_id: a, type: "blocks" },
        { target_id: p, type: "parent-child" },
      ],
    });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: "dependency_cycle", blocker_id: a, blocker_is_ancestor: true });
    const titles = (await t.get("/issues")).body.items.map((i: { title: string }) => i.title);
    expect(titles).not.toContain("x");
  });
});

describe("mirroring an existing tracker", () => {
  it("carries the original age and creator across, and refuses them without asking for it", async () => {
    const t = tracker("mirror", await tokenFor("migrator@example.com"));
    const created = new Date("2026-01-02T03:04:05.000Z");
    const closed = new Date("2026-02-03T04:05:06.000Z");

    const mirrored = await t.post("/issues", {
      id: "mirror-old",
      force_id_prefix: true,
      title: "carried over",
      issue_type: "task",
      status: "closed",
      preserve_timestamps: true,
      created_at: created.toISOString(),
      closed_at: closed.toISOString(),
      original_created_by: "Original Author",
    });
    expect(mirrored.status).toBe(200);
    expect(mirrored.body).toMatchObject({
      id: "mirror-old",
      created_at: created.toISOString(),
      closed_at: closed.toISOString(),
      created_by: "Original Author",
    });

    // The same field without the opt-in is a client bug, not something to
    // accept and drop: a mirror that believed it had preserved the age of a
    // tracker would rewrite that tracker's history silently.
    const dropped = await t.post("/issues", {
      id: "mirror-silent",
      force_id_prefix: true,
      title: "silently restamped",
      issue_type: "task",
      created_at: created.toISOString(),
    });
    expect(dropped.status).toBe(400);
    expect(dropped.body).toMatchObject({ param: "created_at" });
  });
});

describe("authentication and scopes", () => {
  it("challenges unauthenticated requests and asks for step-up when a write lacks beads:write", async () => {
    const anonymousApi = await call("GET", "/t/auth/v0/beads/ready", undefined);
    expect(anonymousApi.status).toBe(401);
    expect(anonymousApi.headers.get("WWW-Authenticate")).toMatch(/^Bearer/);

    const anonymousMcp = await exports.default.fetch(new Request("https://beads.test/mcp", { method: "POST", body: "{}" }));
    expect(anonymousMcp.status).toBe(401);
    expect(anonymousMcp.headers.get("WWW-Authenticate")).toMatch(/^Bearer/);

    const readOnly = await tokenFor("reader@example.com", [SCOPE_READ]);
    expect((await call("GET", "/t/auth/v0/beads/ready", readOnly)).status).toBe(200);
    const write = await call("POST", "/t/auth/v0/beads/issues", readOnly, { actor: "reader", title: "nope", issue_type: "task" });
    expect(write.status).toBe(403);
    expect(write.headers.get("WWW-Authenticate")).toMatch(/error="insufficient_scope"/);
    expect(write.headers.get("WWW-Authenticate")).toContain("beads:write");

    const mcpWrite = await exports.default.fetch(
      new Request("https://beads.test/mcp", {
        method: "POST",
        headers: { Authorization: `Bearer ${readOnly}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "bead_create", arguments: { tracker: "auth", title: "nope" } } }),
      }),
    );
    expect(mcpWrite.status).toBe(403);
  });
});

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
