import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { SCOPE_IMPORT, SCOPE_READ, SCOPE_WRITE } from "../src/auth/scopes";
import { call, tokenFor, tracker } from "./helpers";

const stub = () => env.TEAM_STORE.get(env.TEAM_STORE.idFromName(env.TEAM));
const ids = (r: { body: { items: { id: string }[] } }) => r.body.items.map((i) => i.id);

/** Rows a test needs by the thousand are written straight to storage; everything it asserts goes through HTTP. */
async function seedClosed(name: string, count: number): Promise<void> {
  await runInDurableObject(stub(), async (_instance, state) => {
    const base = Date.parse("2025-01-01T00:00:00.000Z");
    for (let i = 0; i < count; i++) {
      // Many rows share one second, which is what a mirrored tracker looks like.
      const at = new Date(base + Math.floor(i / 7) * 1000).toISOString();
      state.storage.sql.exec(
        `INSERT INTO issues (tracker, id, title, status, priority, issue_type, created_at, updated_at, closed_at)
         VALUES (?1, ?2, ?3, 'closed', 2, 'task', ?4, ?4, ?4)`,
        name, `${name}-${String(i).padStart(5, "0")}`, `row ${i}`, at,
      );
    }
    // Rows mirrored from other stores carry timestamps in whatever spelling the source used; paging must
    // still step over them rather than refuse the cursor that names one.
    for (const [n, at] of [["odd-1", "2024-03-01 10:00:00"], ["odd-2", "0001-01-01T00:00:00Z"], ["odd-3", ""], ["odd-4", "2025-99-99T00:00:00Z"]] as const) {
      state.storage.sql.exec(
        `INSERT INTO issues (tracker, id, title, status, priority, issue_type, created_at, updated_at) VALUES (?1, ?2, 'odd', 'closed', 2, 'task', ?3, ?3)`,
        name, `${name}-${n}`, at,
      );
    }
  });
}

describe("paging", () => {
  it("walks thousands of closed rows with the keyset cursor, each exactly once, under both orders", async () => {
    const t = tracker("paging", await tokenFor("pager@example.com"));
    await seedClosed("paging", 4600);
    // A cursor minted at a row whose timestamp no parser reads must still resume.
    const first = await t.get("/issues?status=closed&limit=1");
    expect(ids(first)).toEqual(["paging-odd-4"]);
    expect((await t.get(`/issues?status=closed&limit=1&cursor=${encodeURIComponent(first.body.next_cursor)}`)).status).toBe(200);
    for (const sort of ["created", "priority"]) {
      const seen: string[] = [];
      let cursor = "";
      for (let page = 0; page < 200; page++) {
        const r = await t.get(`/issues?status=closed&limit=100&sort=${sort}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
        expect(r.status).toBe(200);
        seen.push(...ids(r));
        if (!r.body.has_more) break;
        cursor = r.body.next_cursor;
      }
      expect(new Set(seen).size).toBe(4604);
      expect(seen).toHaveLength(4604);
    }
  });
});

describe("summaries", () => {
  it("answers stats and counts by status, grouped, with blocked work counted by the graph", async () => {
    const t = tracker("stats", await tokenFor("stats@example.com"));
    const a = await t.create("a", { labels: ["x"] });
    const b = await t.create("b", { labels: ["x", "y"], priority: 0 });
    const c = await t.create("c");
    await t.post("/dependencies:add", { edges: [{ issue_id: b, depends_on_id: a, type: "blocks" }] });
    await t.post(`/issues/${c}:close`, { reason: "done" });

    const stats = await t.get("/stats");
    expect(stats.body).toEqual({
      summary: {
        total_issues: 3, open_issues: 2, in_progress_issues: 0, closed_issues: 1, deferred_issues: 0,
        blocked_issues: 1, ready_issues: 1, pinned_issues: 0, epics_eligible_for_closure: 0, average_lead_time_hours: 0,
      },
      blocked_count_skipped: false,
    });
    expect((await t.get("/stats?skip_blocked=true")).body).toMatchObject({ summary: { blocked_issues: null, ready_issues: null }, blocked_count_skipped: true });
    expect((await t.get("/stats?assignee=")).status).toBe(400);

    expect((await t.get("/issues:count")).body).toEqual({ total: 3 });
    expect((await t.get("/issues:count?label=x&group_by=priority")).body).toEqual({ total: 2, groups: { P0: 1, P2: 1 } });
    const byLabel = (await t.get("/issues:count?group_by=label")).body;
    expect(byLabel).toEqual({ total: 3, groups: { x: 2, y: 1, "(no labels)": 1 } });
    expect((await t.get("/issues:count?group_by=nope")).body).toMatchObject({ code: "invalid_argument", param: "group_by" });
  });

  it("marks exactly the blocked open issues in a listing and agrees with ready work", async () => {
    const t = tracker("blocked", await tokenFor("blocked@example.com"));
    const blocker = await t.create("blocker");
    const waiting = await t.create("waiting");
    const done = await t.create("done");
    await t.post("/dependencies:add", { edges: [{ issue_id: waiting, depends_on_id: blocker, type: "blocks" }] });
    await t.post(`/issues/${done}:close`, {});

    const listed = (await t.get("/issues?all=true")).body.items as { id: string; is_blocked: boolean; status: string }[];
    expect(Object.fromEntries(listed.map((i) => [i.id, i.is_blocked]))).toEqual({ [blocker]: false, [waiting]: true, [done]: false });
    const open = listed.filter((i) => i.status === "open");
    const ready = ids(await t.get("/ready"));
    expect(open.filter((i) => !i.is_blocked).map((i) => i.id).sort()).toEqual(ready.sort());
  });
});

describe("listing filters", () => {
  it("hides gates, infra types, ephemeral and template rows until asked, and accepts custom vocabulary", async () => {
    const token = await tokenFor("tiers@example.com");
    const t = tracker("tiers", token);
    expect((await call("PUT", "/t/tiers/v0/beads/config/types.custom", token, { value: "agent,merge-request" })).status).toBe(200);
    expect((await call("PUT", "/t/tiers/v0/beads/config/status.custom", token, { value: "review:active,parked:frozen" })).status).toBe(200);

    const plain = await t.create("plain");
    const gate = await t.create("gate", { issue_type: "gate" });
    const agent = await t.create("agent", { issue_type: "agent" });
    const wisp = await t.create("wisp", { ephemeral: true });
    const review = await t.create("in review", { status: "review" });
    const parked = await t.create("parked", { status: "parked" });
    expect((await t.post("/issues", { title: "bad", issue_type: "nonsense" })).status).toBe(400);

    expect(ids(await t.get("/issues")).sort()).toEqual([plain, review].sort());
    expect(ids(await t.get("/issues?include_gates=true"))).toContain(gate);
    expect(ids(await t.get("/issues?type=agent"))).toEqual([agent]);
    expect(ids(await t.get("/issues?include_ephemeral=true"))).toContain(wisp);
    expect(ids(await t.get("/issues?include_infra=true"))).toEqual(expect.arrayContaining([agent, wisp]));
    expect(ids(await t.get("/issues?status=parked"))).toEqual([parked]);
    // A custom status of category active is ready work; a frozen one is not.
    expect(ids(await t.get("/ready"))).toEqual(expect.arrayContaining([plain, review]));
    expect(ids(await t.get("/ready"))).not.toContain(parked);
    expect((await t.get("/issues?type=mr")).status).toBe(200);
  });

  it("filters ready work by label pattern and label regex", async () => {
    const t = tracker("labelfilter", await tokenFor("labels@example.com"));
    const a = await t.create("a", { labels: ["area:ui"] });
    const b = await t.create("b", { labels: ["area:api"] });
    await t.create("c", { labels: ["other"] });
    expect(ids(await t.get("/ready?label_pattern=area:*")).sort()).toEqual([a, b].sort());
    expect(ids(await t.get("/ready?label_regex=%5Earea:(ui)%24"))).toEqual([a]);
    expect((await t.get("/ready?label_regex=%28")).body).toMatchObject({ param: "label_regex" });
    expect((await t.get("/ready:count?label_pattern=area:*")).body).toEqual({ total: 2 });
  });

  it("accepts a 258-character title and refuses one past the storage bound", async () => {
    const t = tracker("longtitle", await tokenFor("long@example.com"));
    const ok = await t.post("/issues", { title: "t".repeat(258), issue_type: "task" });
    expect(ok.status).toBe(200);
    expect((await t.post("/issues", { title: "t".repeat(501), issue_type: "task" })).body).toMatchObject({ param: "title" });
  });
});

describe("query language", () => {
  it("evaluates a disjunction no combination of list filters can express", async () => {
    const t = tracker("query", await tokenFor("query@example.com"));
    const bug = await t.create("a bug", { issue_type: "bug" });
    const urgent = await t.create("urgent thing", { labels: ["urgent"] });
    await t.create("neither");
    const closedBug = await t.create("old bug", { issue_type: "bug" });
    await t.post(`/issues/${closedBug}:close`, {});

    const hit = await t.get(`/issues:query?q=${encodeURIComponent("type=bug OR label=urgent")}`);
    expect(ids(hit).sort()).toEqual([bug, urgent].sort());
    expect(ids(await t.get(`/issues:query?q=${encodeURIComponent("type=bug OR label=urgent")}&all=true`))).toContain(closedBug);
    expect(ids(await t.get(`/issues:query?q=${encodeURIComponent("NOT (type=bug) AND title=thing")}`))).toEqual([urgent]);
    expect(ids(await t.get(`/issues:query?q=${encodeURIComponent("created<1h")}`))).toEqual([]);
    expect((await t.get(`/issues:query?q=${encodeURIComponent("nosuch=1")}`)).body).toMatchObject({ code: "invalid_argument", param: "q" });
    expect((await t.get("/issues:query?q=")).status).toBe(400);
  });
});

describe("dependency reads", () => {
  it("lists, counts, annotates, walks and relates the edges of a small graph", async () => {
    const t = tracker("graph", await tokenFor("graph@example.com"));
    const [a, b, c] = [await t.create("a"), await t.create("b"), await t.create("c")];
    await t.post("/dependencies:add", {
      edges: [
        { issue_id: b, depends_on_id: a, type: "blocks" },
        { issue_id: c, depends_on_id: b, type: "blocks" },
        { issue_id: c, depends_on_id: "external:other", type: "related" },
      ],
    });

    const listed = await t.get(`/dependencies?issue_id=${c}&issue_id=ghost-1`);
    expect(listed.body.missing).toEqual(["ghost-1"]);
    expect(listed.body.items.map((e: { depends_on_id: string }) => e.depends_on_id)).toEqual(["external:other", b]);
    expect((await t.get(`/dependencies?issue_id=${c}&type=blocks`)).body.items).toHaveLength(1);

    expect((await t.get(`/dependencies:count?issue_id=${b}&issue_id=nope-9&direction=in`)).body).toEqual({
      anchors: [{ id: b, count: 1, missing: false }, { id: "nope-9", count: 0, missing: true }],
    });
    expect((await t.get(`/dependencies:count?issue_id=${b}&direction=out&status=open`)).body).toMatchObject({ param: "status" });

    expect((await t.get(`/dependencies/blocking?issue_id=${b}`)).body).toEqual({ items: [{ id: b, blocked_by: [a], blocks: [c] }] });

    const tree = await t.get(`/dependencies/tree?root_id=${c}`);
    expect(tree.body.items.map((n: { id: string; depth: number }) => [n.id, n.depth])).toEqual([[c, 0], [b, 1], [a, 2]]);
    expect(tree.body.items[1]).toMatchObject({ parent_id: c, edge_from_parent: "blocks", truncated: false });
    expect((await t.get(`/dependencies/tree?root_id=${c}&max_depth=1`)).body.items).toHaveLength(1);
    expect(ids(await t.get(`/dependencies/tree?root_id=${b}&direction=up`))).toEqual([b, c]);
    expect((await t.get("/dependencies/tree?root_id=ghost-1")).status).toBe(404);

    const related = await t.get(`/issues/${b}/related?direction=in`);
    expect(related.body.items).toMatchObject([{ id: c, dependency_type: "blocks" }]);
    expect((await t.get(`/issues/${b}/related`)).body).toMatchObject({ param: "direction" });
    expect((await t.get("/dependencies/cycles")).body).toEqual({ items: [], has_more: false });
  });

  it("reports a cycle the import let through, lowest id first", async () => {
    const key = await keyWithImport("cycles");
    const t = tracker("cyc", key);
    const record = (id: string, target: string) => ({
      id, title: id, priority: 2, status: "open", issue_type: "task", created_at: "2025-01-01T00:00:00Z",
      dependencies: [{ depends_on_id: target, type: "blocks", created_at: "2025-01-01T00:00:00Z" }],
    });
    const r = await t.post("/issues:import", { issues: [record("cyc-b", "cyc-a"), record("cyc-a", "cyc-b")] });
    expect(r.body.bypassed).toMatchObject({ cycle_edges: 2 });
    const cycles = await t.get("/dependencies/cycles");
    expect(cycles.body.items).toHaveLength(1);
    expect(cycles.body.items[0].members.map((m: { id: string }) => m.id)).toEqual(["cyc-a", "cyc-b"]);
  });
});

describe("settings", () => {
  it("sets, reads, lists, redacts and unsets a setting on the upstream paths", async () => {
    const token = await tokenFor("settings@example.com");
    const base = "/t/settings/v0/beads/config";
    expect((await call("PUT", `${base}/ui.theme`, token, { value: "dark" })).body).toEqual({ key: "ui.theme", value: "dark", redacted: false });
    expect((await call("PUT", `${base}/github.token`, token, { value: "s3cret" })).body).toEqual({ key: "github.token", redacted: true });
    expect((await call("GET", `${base}/ui.theme`, token)).body).toEqual({ key: "ui.theme", value: "dark", redacted: false });
    expect((await call("GET", `${base}/missing`, token)).body).toEqual({ key: "missing", redacted: false });
    expect((await call("GET", base, token)).body).toEqual({
      items: [{ key: "github.token", redacted: true }, { key: "ui.theme", value: "dark", redacted: false }],
      has_more: false,
    });
    expect((await call("PUT", `${base}/issue_prefix`, token, { value: "x" })).status).toBe(400);
    expect((await call("PUT", `${base}/status.custom`, token, { value: "Bad Name" })).status).toBe(400);
    expect((await call("DELETE", `${base}/ui.theme`, token)).body).toEqual({ key: "ui.theme" });
    expect((await call("GET", `${base}/ui.theme`, token)).body).toEqual({ key: "ui.theme", redacted: false });
    expect((await call("PUT", `${base}/ui.theme`, token, { value: "x", other: 1 })).status).toBe(400);
  });
});

describe("batches", () => {
  it("creates a batch in order, each item with its own id, and refuses the whole batch for one bad item", async () => {
    const t = tracker("bcreate", await tokenFor("bc@example.com"));
    const first = await t.post("/issues:batchCreate", {
      items: [{ title: "one", labels: ["l"] }, { title: "two", priority: 0, issue_type: "bug" }],
    });
    expect(first.status).toBe(200);
    expect(first.body.items.map((i: { title: string }) => i.title)).toEqual(["one", "two"]);
    expect(first.body.items[0].id).not.toBe(first.body.items[1].id);

    const refused = await t.post("/issues:batchCreate", { items: [{ title: "fine" }, { title: "", priority: 9 }] });
    expect(refused.body).toMatchObject({ code: "invalid_argument", param: "items[1].title" });
    expect(ids(await t.get("/issues"))).toHaveLength(2);
  });

  it("closes what it can, reports each refusal in its outcome and keeps the survivors", async () => {
    const t = tracker("bclose", await tokenFor("bclose@example.com"));
    const parent = await t.create("parent");
    const child = await t.create("child", { parent_id: parent });
    const lone = await t.create("lone");
    const r = await t.post("/issues:batchClose", { items: [{ id: parent }, { id: lone, reason: "ok" }, { id: "ghost-1" }, { id: lone }] });
    expect(r.status).toBe(200);
    expect(r.body.outcomes).toMatchObject([
      { issue_id: parent, code: "not_closable", open_children: 1 },
      { issue_id: lone, already_closed: false },
      { issue_id: "ghost-1", code: "not_found" },
      { issue_id: lone, already_closed: true },
    ]);
    expect((await t.get(`/issues/${lone}`)).body).toMatchObject({ status: "closed", close_reason: "ok" });
    expect((await t.get(`/issues/${child}`)).body.status).toBe("open");
  });

  it("applies a plan atomically: keys bind ids, and a refused item rolls everything back", async () => {
    const t = tracker("apply", await tokenFor("apply@example.com"));
    const existing = await t.create("existing");
    const plan = {
      items: [
        { kind: "create", create: { key: "a", title: "step a" } },
        { kind: "create", create: { key: "b", title: "step b", metadata_refs: { first: { key: "a" } } } },
        { kind: "dep_add", dep_add: { source: { key: "b" }, target: { key: "a" }, type: "blocks" } },
        { kind: "update", update: { target: { key: "a" }, patch: { priority: 0, labels: { add: ["x"] } } } },
        { kind: "close", close: { target: { id: existing }, reason: "planned" } },
      ],
    };
    const ok = await t.post("/issues:batchApply", plan);
    expect(ok.status).toBe(200);
    const { a, b } = ok.body.keys;
    expect(ok.body.items.map((i: { kind: string; changed: boolean }) => [i.kind, i.changed])).toEqual([
      ["create", true], ["create", true], ["dep_add", true], ["update", true], ["close", true],
    ]);
    expect((await t.get(`/issues/${b}`)).body).toMatchObject({ metadata: { first: a }, dependencies: [{ id: a, dependency_type: "blocks" }] });
    expect((await t.get(`/issues/${a}`)).body).toMatchObject({ priority: 0, labels: ["x"] });
    expect((await t.get(`/issues/${existing}`)).body.status).toBe("closed");

    const before = (await t.get("/issues:count")).body.total;
    const bad = await t.post("/issues:batchApply", {
      items: [
        { kind: "create", create: { title: "never lands" } },
        { kind: "update", update: { target: { id: "ghost-1" }, patch: { priority: 1 } } },
      ],
    });
    expect(bad.status).toBe(404);
    const later = await t.post("/issues:batchApply", {
      items: [{ kind: "close", close: { target: { key: "z" } } }, { kind: "create", create: { key: "z", title: "z" } }],
    });
    expect(later.body).toMatchObject({ code: "invalid_argument", declared_later: true, param: "items[0].close.target.key" });
    expect((await t.get("/issues:count")).body.total).toBe(before);
  });

  it("carries a whole bd transaction in one plan: a child under a parent, core members no create has, edge removal, comments and settings", async () => {
    const t = tracker("xapply", await tokenFor("xapply@example.com"));
    const parent = await t.create("parent", { labels: ["p"] });
    const other = await t.create("other");
    await t.post("/dependencies:add", { edges: [{ issue_id: other, depends_on_id: parent, type: "blocks" }] });

    const ok = await t.post("/issues:batchApply", {
      items: [
        { kind: "create", create: { key: "kid", title: "kid", x_parent_id: { id: parent }, x_inherit_labels_from_parent: true, x_extra: { spec_id: "SPEC-1", pinned: true, wisp_type: "patrol" } } },
        { kind: "x_dep_remove", x_dep_remove: { source: { id: other }, target: { id: parent } } },
        { kind: "x_comment", x_comment: { target: { key: "kid" }, text: "from the plan" } },
        { kind: "x_set_config", x_set_config: { key: "ui.note", value: "hi" } },
        { kind: "update", update: { target: { id: other }, patch: { x_extra: { mol_type: "swarm" } } } },
      ],
    });
    expect(ok.status).toBe(200);
    expect(ok.body.items.map((i: { kind: string; changed: boolean }) => [i.kind, i.changed])).toEqual([
      ["create", true], ["x_dep_remove", true], ["x_comment", true], ["x_set_config", true], ["update", true],
    ]);
    const kid = ok.body.keys.kid as string;
    expect(kid.startsWith(`${parent}.`)).toBe(true);
    expect((await t.get(`/issues/${kid}?include_comments=true`)).body).toMatchObject({
      spec_id: "SPEC-1", wisp_type: "patrol", pinned: true, ephemeral: true, labels: ["p"], comments: [{ text: "from the plan" }],
    });
    expect((await t.get(`/issues/${other}`)).body).toMatchObject({ mol_type: "swarm" });
    expect((await t.get(`/dependencies?issue_id=${other}`)).body.items).toEqual([]);
    expect((await t.get("/config/ui.note")).body).toMatchObject({ value: "hi" });

    // Atomic with the rest of the plan: a refused item takes the setting down with it.
    const bad = await t.post("/issues:batchApply", {
      items: [{ kind: "x_set_config", x_set_config: { key: "ui.other", value: "v" } }, { kind: "x_comment", x_comment: { target: { id: "ghost-1" }, text: "x" } }],
    });
    expect(bad.status).toBe(404);
    expect((await t.get("/config/ui.other")).body.value).toBeUndefined();
    // Only the core members named by the spec's Issue are accepted inside x_extra, and the single update takes them too.
    expect((await t.patch(`/issues/${other}`, { patch: { x_extra: { nope: 1 } } })).body).toMatchObject({ code: "invalid_argument", param: "patch.x_extra.nope" });
    expect((await t.patch(`/issues/${other}`, { patch: { x_extra: { mol_type: null, is_template: true } } })).body).toMatchObject({ changed: true });
    expect((await t.get(`/issues/${other}`)).body).toMatchObject({ is_template: true });
    expect((await t.get(`/issues/${other}`)).body.mol_type).toBeUndefined();
  });
});

describe("destructive writes", () => {
  it("deletes with a dependents guard, previews, cascades and rewrites references", async () => {
    const t = tracker("delete", await tokenFor("delete@example.com"));
    const base = await t.create("base");
    const dependent = await t.create("dependent", { description: `see ${base} and ${base}-other` });
    await t.post("/dependencies:add", { edges: [{ issue_id: dependent, depends_on_id: base, type: "blocks" }] });

    expect((await t.post("/issues:delete", { ids: [base] })).body).toMatchObject({ code: "invalid_argument" });
    expect((await t.post("/issues:delete", { ids: ["ghost-1"] })).status).toBe(404);
    const preview = await t.post("/issues:delete", { ids: [base], force: true, dry_run: true });
    expect(preview.body).toMatchObject({ dry_run: true, deleted: 1, dependencies: 1, orphaned: [dependent] });
    expect((await t.get(`/issues/${base}`)).status).toBe(200);

    const forced = await t.post("/issues:delete", { ids: [base], force: true });
    expect(forced.body).toMatchObject({ deleted: 1, references_updated: 1, orphaned: [dependent] });
    expect((await t.get(`/issues/${base}`)).status).toBe(404);
    expect((await t.get(`/issues/${dependent}`)).body.description).toBe(`see [deleted:${base}] and ${base}-other`);

    const x = await t.create("x");
    const y = await t.create("y");
    await t.post("/dependencies:add", { edges: [{ issue_id: y, depends_on_id: x, type: "blocks" }] });
    expect((await t.post("/issues:delete", { ids: [x], cascade: true })).body).toMatchObject({ deleted: 2 });
    expect((await t.get(`/issues/${y}`)).status).toBe(404);
  });

  it("sweeps closed beads of one tier, protecting pinned and still-cited ones, and refuses an unfiltered durable sweep", async () => {
    const t = tracker("sweep", await tokenFor("sweep@example.com"));
    const old = await t.create("old");
    const cited = await t.create("cited");
    await t.create("live", { description: `follow up on ${cited}` });
    for (const id of [old, cited]) await t.post(`/issues/${id}:close`, {});

    expect((await t.post("/issues:sweep", { tier: "durable" })).status).toBe(400);
    expect((await t.post("/issues:sweep", { tier: "durable", pattern: "[" })).body).toMatchObject({ param: "pattern" });
    const dry = await t.post("/issues:sweep", { tier: "durable", pattern: "*", dry_run: true });
    expect(dry.body).toMatchObject({ dry_run: true, swept: 1, skipped: { referenced: 1 }, referenced_ids: [cited] });
    expect((await t.post("/issues:sweep", { tier: "durable", pattern: "*" })).body).toMatchObject({ swept: 1 });
    expect((await t.get(`/issues/${old}`)).status).toBe(404);
    expect((await t.get(`/issues/${cited}`)).status).toBe(200);
  });
});

describe("compare-and-set metadata", () => {
  it("swaps only when the key holds what was expected, and tells absent from null", async () => {
    const t = tracker("cas", await tokenFor("cas@example.com"));
    const id = await t.create("locked");
    const cas = (body: object) => t.post(`/issues/${id}:casMetadata`, { key: "lease", ...body });

    expect((await cas({ value: "alice" })).body).toEqual({ swapped: true, current: "alice" });
    expect((await cas({ value: "bob" })).body).toEqual({ swapped: false, current: "alice" });
    expect((await cas({ expected: "alice", value: { b: 1, a: 2 } })).body).toEqual({ swapped: true, current: { b: 1, a: 2 } });
    expect((await cas({ expected: { a: 2, b: 1 }, value: null })).body).toEqual({ swapped: true, current: null });
    expect((await cas({ expected: null })).body).toEqual({ swapped: true });
    expect((await t.get(`/issues/${id}`)).body.metadata).toBeUndefined();
    expect((await cas({ key: "9bad", value: 1 })).body).toMatchObject({ param: "key" });
    expect((await t.post("/issues/ghost-1:casMetadata", { key: "k", value: 1 })).status).toBe(404);
  });
});

async function keyWithImport(label: string): Promise<string> {
  const admin = await call("POST", "/admin/keys", env.ADMIN_TOKEN, { label, scopes: [SCOPE_READ, SCOPE_WRITE, SCOPE_IMPORT] });
  expect(admin.status).toBe(201);
  return admin.body.key;
}

describe("import", () => {
  it("stores records verbatim and idempotently, replaces a changed record and gates the route behind its scope", async () => {
    const key = await keyWithImport("import");
    const t = tracker("imp", key, "migrator");
    const records = [
      {
        id: "imp-aaa", title: "first", description: "d", priority: 1, status: "closed", issue_type: "bug", owner: "o@example.com",
        created_at: "2024-03-01T10:00:00Z", created_by: "alice", updated_at: "2024-03-05T10:00:00Z", closed_at: "2024-03-05T10:00:00Z",
        close_reason: "fixed upstream", closed_by_session: "sess-1", pinned: true, labels: ["b", "a"], spec_id: "SPEC-1",
        comments: [{ author: "bob", text: "hello", created_at: "2024-03-02T10:00:00Z" }, { author: "alice", text: "bye", created_at: "2024-03-04T10:00:00Z" }],
        dependencies: [{ depends_on_id: "imp-zzz", type: "blocks", created_at: "2024-03-01T11:00:00Z", created_by: "alice", metadata: "{\"why\":\"x\"}" }],
      },
      { id: "imp-bbb", title: "second", priority: 2, status: "open", issue_type: "task", created_at: "2024-04-01T10:00:00Z", metadata: { k: "v" } },
    ];
    const body = { issues: records, memories: [{ key: "note", value: "kept" }], settings: [{ key: "status.custom", value: "review:active" }] };

    const first = await t.post("/issues:import", body);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ issues: { created: 2, updated: 0, unchanged: 0 }, memories: { created: 1 }, settings: { created: 1 }, bypassed: { dangling_edges: 1 } });

    const read = (await t.get("/issues/imp-aaa?include_comments=true")).body;
    expect(read).toMatchObject({
      created_at: "2024-03-01T10:00:00.000Z", updated_at: "2024-03-05T10:00:00.000Z", closed_at: "2024-03-05T10:00:00.000Z",
      created_by: "alice", close_reason: "fixed upstream", closed_by_session: "sess-1", owner: "o@example.com", pinned: true,
      labels: ["a", "b"], spec_id: "SPEC-1",
      comments: [{ author: "bob", text: "hello", created_at: "2024-03-02T10:00:00.000Z" }, { author: "alice", text: "bye", created_at: "2024-03-04T10:00:00.000Z" }],
    });
    expect((await t.get("/dependencies?issue_id=imp-aaa")).body.items).toEqual([
      { issue_id: "imp-aaa", depends_on_id: "imp-zzz", type: "blocks", created_at: "2024-03-01T11:00:00.000Z", created_by: "alice", metadata: "{\"why\":\"x\"}" },
    ]);
    expect((await t.get("/memories/note")).body).toMatchObject({ value: "kept" });

    const events = (await t.get("/events?since=0")).body.records.length;
    const again = await t.post("/issues:import", body);
    expect(again.body).toMatchObject({ issues: { created: 0, updated: 0, unchanged: 2 } });
    expect((await t.get("/events?since=0")).body.records).toHaveLength(events);

    const changed = await t.post("/issues:import", { issues: [{ ...records[0], labels: ["z"], comments: [], dependencies: [] }] });
    expect(changed.body).toMatchObject({ issues: { updated: 1 } });
    expect((await t.get("/issues/imp-aaa?include_comments=true")).body).toMatchObject({ labels: ["z"], comment_count: 0 });
    expect((await t.get("/dependencies?issue_id=imp-aaa")).body.items).toEqual([]);

    // Ordinary keys and users cannot rewrite history.
    const plain = await tokenFor("plain@example.com");
    const denied = await call("POST", "/t/imp/v0/beads/issues:import", plain, { actor: "x", issues: [] });
    expect(denied.status).toBe(403);
  });
});

describe("operator surfaces", () => {
  it("lists tracker sizes for administrators only and honours a stored project id", async () => {
    const t = tracker("ops", await tokenFor("ops@example.com"));
    await t.create("one");
    const admin = await call("GET", "/admin/trackers", env.ADMIN_TOKEN);
    expect(admin.status).toBe(200);
    expect(admin.body.items.find((x: { tracker: string }) => x.tracker === "ops")).toMatchObject({ issues: 1, by_status: { open: 1 } });
    expect((await call("GET", "/admin/trackers", await tokenFor("nobody@example.com"))).status).toBe(403);

    const key = await keyWithImport("project");
    await tracker("ops", key).post("/issues:import", { project_id: "0F3A-UUID" });
    expect((await t.get("/context")).body.project_id).toBe("0F3A-UUID");
    expect((await t.get("/ready", { "Bd-Project-Id": "0F3A-UUID" })).status).toBe(200);
    expect((await t.get("/ready", { "Bd-Project-Id": "ops" })).status).toBe(200);
    expect((await t.get("/ready", { "Bd-Project-Id": "other" })).body).toMatchObject({ reason: "project_mismatch", server_project_id: "0F3A-UUID" });
    const caps = (await t.get("/context")).body.capabilities as string[];
    expect(caps).toEqual(expect.arrayContaining(["issues.batchApply", "stats.get", "profile.import", "profile.heartbeat"]));
  });
});

describe("hardening", () => {
  it("keeps every read working when a stored edge holds metadata that is not JSON, and imports it as given", async () => {
    const key = await keyWithImport("legacy");
    const t = tracker("legacy", key);
    const at = "2025-01-01T00:00:00Z";
    const rec = (id: string, extra: object = {}) => ({ id, title: id, priority: 2, status: "open", issue_type: "task", created_at: at, ...extra });
    const r = await t.post("/issues:import", {
      issues: [
        rec("legacy-spawner"),
        rec("legacy-waiter", { dependencies: [{ depends_on_id: "legacy-spawner", type: "waits-for", metadata: "not json", created_at: at }] }),
      ],
    });
    expect(r.status).toBe(200);
    // A gate nobody can read is no gate: the waiter is ready, and nothing throws.
    expect(ids(await t.get("/ready")).sort()).toEqual(["legacy-spawner", "legacy-waiter"]);
    expect((await t.get("/ready:count")).body).toEqual({ total: 2 });
    expect(ids(await t.get("/issues")).length).toBe(2);
    expect((await t.get("/stats")).status).toBe(200);
    expect((await t.post("/issues/legacy-waiter:close", {})).status).toBe(200);
    expect((await t.get("/dependencies?issue_id=legacy-waiter")).body.items[0].metadata).toBe("not json");
  });

  it("refuses label regexes that can backtrack and answers the safe ones", async () => {
    const t = tracker("regex", await tokenFor("regex@example.com"));
    await t.create("a", { labels: ["a".repeat(32) + "!"] });
    for (const bad of ["^(a%2B)%2B$", "(a|a)*", "(a)%5C1", "(%3F=a)a", "(%3Fi)a", "a*b*c*d*"]) {
      expect((await t.get(`/ready?label_regex=${bad}`)).body).toMatchObject({ code: "invalid_argument", param: "label_regex" });
    }
    expect((await t.get(`/ready?label_regex=${encodeURIComponent("x".repeat(129))}`)).status).toBe(400);
    expect(ids(await t.get(`/ready?label_regex=${encodeURIComponent("^a+!$")}`))).toHaveLength(1);
  });

  it("gives every item of a batch of identical titles its own id", async () => {
    const t = tracker("samebatch", await tokenFor("same@example.com"));
    const items = Array.from({ length: 100 }, () => ({ title: "same" }));
    const created = await t.post("/issues:batchCreate", { items });
    expect(created.status).toBe(200);
    expect(new Set(created.body.items.map((i: { id: string }) => i.id)).size).toBe(100);
    const applied = await t.post("/issues:batchApply", { items: items.map((c) => ({ kind: "create", create: c })) });
    expect(applied.status).toBe(200);
    expect(new Set(applied.body.items.map((i: { issue_id: string }) => i.issue_id)).size).toBe(100);
  });

  it("stores a metadata key named __proto__ like any other", async () => {
    const t = tracker("proto", await tokenFor("proto@example.com"), "p");
    const id = await t.create("p", { labels: ["__proto__"] });
    expect((await t.post(`/issues/${id}:casMetadata`, { key: "__proto__", value: "x" })).body).toEqual({ swapped: true, current: "x" });
    const read = (await t.get(`/issues/${id}`)).body;
    expect(Object.getOwnPropertyDescriptor(read.metadata, "__proto__")?.value).toBe("x");
    expect((await t.get("/issues:count?group_by=label")).body.groups).toMatchObject({ ["__proto__"]: 1 });
    expect((await t.get(`/issues?metadata_field=${encodeURIComponent("__proto__=x")}`)).body.items).toHaveLength(1);
  });

  it("rewrites adjacent references to a deleted bead, not every other one", async () => {
    const t = tracker("adjacent", await tokenFor("adjacent@example.com"));
    const gone = await t.create("gone");
    const keeper = await t.create("keeper", { description: `${gone} ${gone}, (${gone}) ${gone}x` });
    await t.post("/dependencies:add", { edges: [{ issue_id: keeper, depends_on_id: gone, type: "related" }] });
    await t.post("/issues:delete", { ids: [gone], force: true });
    expect((await t.get(`/issues/${keeper}`)).body.description).toBe(`[deleted:${gone}] [deleted:${gone}], ([deleted:${gone}]) ${gone}x`);
  });

  it("treats owner=none like assignee=none in a query", async () => {
    const t = tracker("owners", await tokenFor("owners@example.com"));
    const owned = await t.create("owned", { owner: "boss" });
    const free = await t.create("free");
    expect(ids(await t.get(`/issues:query?q=${encodeURIComponent("owner=none")}`))).toEqual([free]);
    expect(ids(await t.get(`/issues:query?q=${encodeURIComponent("owner!=null")}`))).toEqual([owned]);
  });
});

describe("scale", () => {
  const seed = async (name: string, count: number, bytes: number) =>
    runInDurableObject(stub(), async (_instance, state) => {
      state.storage.sql.exec(
        `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?2)
         INSERT INTO issues (tracker, id, title, description, status, priority, issue_type, created_at, updated_at)
         SELECT ?1, ?1 || '-' || i, 't' || i, substr(hex(zeroblob(?3)), 1, ?3), 'open', 2, 'task',
                '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z' FROM n`,
        name, count - 1, bytes,
      );
      state.storage.sql.exec(
        `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?2)
         INSERT INTO dependencies (tracker, issue_id, depends_on_id, type, created_at)
         SELECT ?1, ?1 || '-' || i, ?1 || '-' || (i + 1), 'blocks', '2025-01-01T00:00:00.000Z' FROM n`,
        name, count - 2,
      );
    });

  it("imports 200 records with 5,000 edges into a 5,500-issue tracker in seconds, and queries it without reading every description", async () => {
    await seed("big", 5500, 8192);
    const key = await keyWithImport("big");
    const t = tracker("big", key);
    const at = "2025-01-01T00:00:00Z";
    const issues = Array.from({ length: 200 }, (_, i) => ({
      id: `big-${i}`, title: `renamed ${i}`, priority: 2, status: "open", issue_type: "task", created_at: at,
      dependencies: Array.from({ length: 25 }, (_, k) => ({ depends_on_id: `big-${i + k + 1}`, type: "blocks", created_at: at })),
    }));
    const started = Date.now();
    const r = await t.post("/issues:import", { issues });
    const elapsed = Date.now() - started;
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ issues: { updated: 200 }, edges: 5000, bypassed: { cycle_edges: 0, dangling_edges: 0 } });
    expect(elapsed).toBeLessThan(10_000);
    // An unchanged re-import runs no diagnostics at all.
    expect((await t.post("/issues:import", { issues })).body).toMatchObject({ issues: { unchanged: 200 } });

    // Selective, and limited, and over the text: none of them needs 5,500 descriptions in memory.
    expect(ids(await t.get(`/issues:query?q=${encodeURIComponent("id=big-77")}&limit=1`))).toEqual(["big-77"]);
    const hit = await t.get(`/issues:query?q=${encodeURIComponent("description=0000 AND priority=2")}&limit=3`);
    expect(hit.body.items).toHaveLength(3);
    expect(hit.body.has_more).toBe(true);
  });
});

describe("bulk export", () => {
  async function exportAll(t: ReturnType<typeof tracker>, query = ""): Promise<any[]> {
    const items: any[] = [];
    let cursor: string | undefined;
    do {
      const page = await t.get(`/issues:export?limit=2${query}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      expect(page.status).toBe(200);
      items.push(...page.body.items);
      cursor = page.body.has_more ? page.body.next_cursor : undefined;
    } while (cursor);
    return items;
  }

  it("reads whole records page by page and imports into an empty tracker as the same records", async () => {
    const key = await keyWithImport("export-roundtrip");
    const source = tracker("exp-a", key, "migrator");
    await source.post("/issues:import", {
      issues: [
        {
          id: "x-1", title: "one", description: "body", priority: 1, status: "closed", issue_type: "bug", created_at: "2024-03-01T10:00:00Z",
          updated_at: "2024-03-05T10:00:00Z", closed_at: "2024-03-05T10:00:00Z", close_reason: "done", labels: ["b", "a"], spec_id: "SPEC-1",
          comments: [{ id: "c-1", author: "bob", text: "hello", created_at: "2024-03-02T10:00:00Z" }],
          dependencies: [{ depends_on_id: "x-2", type: "blocks", created_at: "2024-03-01T11:00:00Z", created_by: "alice", metadata: "{\"why\":\"x\"}" }],
        },
        { id: "x-2", title: "two", priority: 2, status: "open", issue_type: "task", created_at: "2024-04-01T10:00:00Z", updated_at: "2024-04-02T10:00:00Z", metadata: { k: "v" } },
        { id: "x-3", title: "three", priority: 3, status: "open", issue_type: "task", created_at: "2024-05-01T10:00:00Z", updated_at: "2024-05-02T10:00:00Z", pinned: true },
      ],
    });
    // A native comment carries a generated id, which must survive the trip as well.
    expect((await call("POST", "/t/exp-a/v0/beads/issues/x-2/comments", key, { author: "someone", text: "native" })).status).toBe(200);

    const first = await exportAll(source);
    expect(first.map((r) => r.id)).toEqual(["x-1", "x-2", "x-3"]);
    expect(first[0]).toMatchObject({ labels: ["a", "b"], comments: [{ id: "c-1", author: "bob", text: "hello" }], dependencies: [{ depends_on_id: "x-2", type: "blocks" }], dependency_count: 1 });
    expect((await exportAll(source, "&status=open")).map((r) => r.id)).toEqual(["x-2"]);
    expect((await exportAll(source, "&updated_after=2024-04-10T00:00:00Z")).map((r) => r.id)).toEqual(["x-3"]);
    expect((await source.get("/issues:export?limit=501")).status).toBe(400);

    const target = tracker("exp-b", key, "migrator");
    for (let at = 0; at < first.length; at += 2) {
      expect((await target.post("/issues:import", { issues: first.slice(at, at + 2) })).status).toBe(200);
    }
    expect(await exportAll(target)).toEqual(first);
    // Re-importing what was exported changes nothing.
    expect((await target.post("/issues:import", { issues: first })).body).toMatchObject({ issues: { created: 0, updated: 0, unchanged: 3 } });
  });

  it("carries every stored nullable state, so importing an export page into the same tracker changes nothing", async () => {
    const key = await keyWithImport("export-states");
    const t = tracker("exp-m", key, "migrator");
    const at = "2024-06-01T10:00:00Z";
    const leases = [{}, { lease_expires_at: "2030-01-01T00:00:00Z" }, { heartbeat_at: "2029-12-31T23:00:00Z" }, { lease_expires_at: "2030-01-01T00:00:00Z", heartbeat_at: "2029-12-31T23:00:00Z" }];
    const refs = [{}, { external_ref: "" }, { external_ref: "gh-9" }];
    const records = ["open", "in_progress", "blocked", "deferred", "closed", "pinned", "hooked"].flatMap((status, s) =>
      leases.map((lease, l) => ({
        id: `exp-m-${s}-${l}`, title: `${status} ${l}`, priority: 2, status, issue_type: "task", created_at: at, updated_at: at,
        ...(status === "closed" ? { closed_at: at } : {}), ...lease, ...refs[(s + l) % refs.length],
      })),
    );
    expect((await t.post("/issues:import", { issues: records })).body).toMatchObject({ issues: { created: records.length } });

    const exported = await exportAll(t);
    expect(exported).toHaveLength(records.length);
    // A lease on a row that is not in progress, a lone heartbeat and an empty external_ref are all stored states.
    expect(exported.find((r) => r.id === "exp-m-0-3")).toMatchObject({ status: "open", lease_expires_at: "2030-01-01T00:00:00.000Z", heartbeat_at: "2029-12-31T23:00:00.000Z" });
    expect(exported.find((r) => r.id === "exp-m-4-2")).toMatchObject({ status: "closed", heartbeat_at: "2029-12-31T23:00:00.000Z" });
    expect(exported.find((r) => r.id === "exp-m-0-1")).toMatchObject({ external_ref: "" });
    expect(exported.find((r) => r.id === "exp-m-0-0")).not.toHaveProperty("external_ref");

    for (let from = 0; from < exported.length; from += 2) {
      const again = await t.post("/issues:import", { issues: exported.slice(from, from + 2) });
      expect(again.body).toMatchObject({ issues: { created: 0, updated: 0, unchanged: Math.min(2, exported.length - from) } });
    }
  });
});

describe("merge import", () => {
  const rec = (id: string, extra: object = {}) => ({
    id, title: id, priority: 2, status: "open", issue_type: "task", created_at: "2025-01-01T00:00:00Z", updated_at: "2025-03-01T00:00:00Z", ...extra,
  });

  it("keeps deleted issues gone on delayed shadow imports while allowing newer records and authority restores", async () => {
    const t = tracker("mrg-deleted", await keyWithImport("merge-deleted"), "importer");
    const id = "mrg-deleted-1";
    const original = rec(id);
    expect((await t.post("/issues:import", { issues: [original] })).status).toBe(200);
    expect((await t.post("/issues:delete", { ids: [id], force: true })).status).toBe(200);
    const events = (await t.get("/events?since=0")).body.records;
    const deletedAt = events.findLast((event: { op: string; issue_id: string }) => event.op === "delete" && event.issue_id === id).ts;

    for (const updated_at of [original.updated_at, deletedAt]) {
      const replay = await t.post("/issues:import", { mode: "merge", reject_stale: true, issues: [rec(id, { updated_at })] });
      expect(replay.status).toBe(200);
      expect(replay.body.skipped_stale_ids).toEqual([id]);
      expect((await t.get(`/issues/${id}`)).status).toBe(404);
    }

    const newer = rec(id, { title: "Created after deletion", updated_at: new Date(Date.parse(deletedAt) + 1000).toISOString() });
    expect((await t.post("/issues:import", { mode: "merge", reject_stale: true, issues: [newer] })).status).toBe(200);
    expect((await t.get(`/issues/${id}`)).body).toMatchObject({ title: newer.title });
    expect((await t.post("/issues:delete", { ids: [id], force: true })).status).toBe(200);
    expect((await t.post("/issues:import", { mode: "replace", issues: [original] })).status).toBe(200);
    expect((await t.get(`/issues/${id}`)).body).toMatchObject({ title: original.title, status: original.status });
  });

  it("merges additively under beads:write, keeps newer local columns, skips a stale record and is one transaction", async () => {
    const importer = tracker("mrg", await keyWithImport("merge-seed"), "seeder");
    expect((await importer.post("/issues:import", {
      issues: [
        rec("mrg-eq", { title: "local", notes: "local notes", labels: ["a", "b"], comments: [{ id: "c1", author: "bob", text: "old", created_at: "2025-02-01T00:00:00Z" }] }),
        rec("mrg-stale", { title: "newer local", updated_at: "2025-06-01T00:00:00Z" }),
        rec("mrg-older", { title: "will change" }),
      ],
    })).status).toBe(200);

    // No import scope: an ordinary write token merges, and cannot replace.
    const token = await tokenFor("merger@example.com");
    const t = tracker("mrg", token, "merger");
    expect((await t.post("/issues:import", { issues: [rec("mrg-eq")] })).status).toBe(403);

    const merged = await t.post("/issues:import", {
      mode: "merge",
      reject_stale: true,
      issues: [
        rec("mrg-eq", {
          title: "incoming", notes: "", labels: ["b", "c"],
          comments: [{ id: "c1", author: "bob", text: "old", created_at: "2025-02-01T00:00:00Z" }, { author: "eve", text: "new", created_at: "2025-02-02T00:00:00Z" }],
          dependencies: [{ depends_on_id: "mrg-fresh", type: "blocks" }, { depends_on_id: "mrg-ghost", type: "blocks" }],
        }),
        rec("mrg-stale", { title: "older incoming", updated_at: "2024-01-01T00:00:00Z", labels: ["never"] }),
        rec("mrg-older", { title: "rewritten", updated_at: "2025-04-01T00:00:00Z" }),
        rec("mrg-fresh", { title: "created verbatim", created_by: "alice", labels: ["x"] }),
      ],
    });
    expect(merged.status).toBe(200);
    expect(merged.body).toMatchObject({
      mode: "merge",
      issues: { created: 1, updated: 2, unchanged: 0, skipped_stale: 1 },
      skipped_stale_ids: ["mrg-stale"],
      skipped_dependencies: [{ issue_id: "mrg-eq", depends_on_id: "mrg-ghost", reason: "target not found" }],
    });

    // Equal timestamps keep the local columns, but labels, comments and edges still merge, and nothing is removed.
    expect((await t.get("/issues/mrg-eq?include_comments=true")).body).toMatchObject({
      title: "local", notes: "local notes", labels: ["a", "b", "c"],
      // Without beads:import the added comment is the verified principal's, never the author the record names.
      comments: [{ author: "bob", text: "old" }, { author: "merger@example.com", text: "new" }],
      dependencies: [{ id: "mrg-fresh", dependency_type: "blocks" }],
    });
    expect((await t.get("/dependencies?issue_id=mrg-eq")).body.items[0]).toMatchObject({ created_by: "merger@example.com" });
    // The same merge again adds nothing, and a record created by it is the principal's, made now.
    const repeat = await t.post("/issues:import", { mode: "merge", reject_stale: true, issues: [rec("mrg-eq", { comments: [{ author: "eve", text: "new", created_at: "2025-02-02T00:00:00Z" }] })] });
    expect(repeat.body).toMatchObject({ issues: { unchanged: 1 } });
    expect((await t.get("/issues/mrg-eq")).body).toMatchObject({ comment_count: 2 });
    // A strictly newer record rewrites the columns; a strictly newer stored one is kept whole, labels included.
    expect((await t.get("/issues/mrg-older")).body).toMatchObject({ title: "rewritten", updated_at: "2025-04-01T00:00:00.000Z" });
    expect((await t.get("/issues/mrg-stale")).body).toMatchObject({ title: "newer local" });
    expect((await t.get("/issues/mrg-stale")).body.labels).toBeUndefined();
    const fresh = (await t.get("/issues/mrg-fresh")).body;
    expect(fresh).toMatchObject({ created_by: "merger@example.com", labels: ["x"] });
    expect(fresh.created_at).not.toBe("2025-01-01T00:00:00.000Z");
    // With beads:import the provenance is kept as given.
    expect((await importer.post("/issues:import", { mode: "merge", issues: [rec("mrg-kept", { created_by: "alice", comments: [{ author: "eve", text: "hi", created_at: "2025-02-02T00:00:00Z" }] })] })).status).toBe(200);
    expect((await t.get("/issues/mrg-kept?include_comments=true")).body).toMatchObject({ created_by: "alice", created_at: "2025-01-01T00:00:00.000Z", comments: [{ author: "eve", created_at: "2025-02-02T00:00:00.000Z" }] });

    // One transaction: a record refused for its prefix takes the records before it down with it.
    const refused = await t.post("/issues:import", { mode: "merge", issues: [rec("mrg-lost"), rec("other-1")] });
    expect(refused.status).toBe(400);
    expect((await t.get("/issues/mrg-lost")).status).toBe(404);
    // ...unless the caller skips the prefix check, as `bd import` does; an identical record then changes nothing.
    const again = await t.post("/issues:import", { mode: "merge", skip_prefix_validation: true, issues: [rec("other-1")] });
    expect(again.body).toMatchObject({ issues: { created: 1 } });
    expect((await t.post("/issues:import", { mode: "merge", skip_prefix_validation: true, issues: [rec("other-1")] })).body).toMatchObject({ issues: { created: 0 } });

    // A merge that ends another principal's live claim goes through the claim guard: refused and reported unless
    // the request says `override_claims`, and then the previous holder's fencing token is stale.
    const alice = tracker("mrg", await tokenFor("alice-mrg@example.com"), "worker-a");
    await importer.post("/issues:import", { issues: [rec("mrg-held")] });
    const claim = await alice.post("/issues/mrg-held:claim", {});
    expect(claim.status).toBe(200);
    const reopen = { issues: [rec("mrg-held", { updated_at: "2099-01-01T00:00:00Z" })] };
    const kept = await t.post("/issues:import", { mode: "merge", ...reopen });
    expect(kept.body.claim_conflicts).toMatchObject([{ issue_id: "mrg-held", assignee: "worker-a" }]);
    expect((await t.get("/issues/mrg-held")).body).toMatchObject({ status: "in_progress" });
    const forced = await t.post("/issues:import", { mode: "merge", override_claims: true, ...reopen });
    expect(forced.body.claim_conflicts).toEqual([]);
    expect((await t.get("/issues/mrg-held")).body).toMatchObject({ status: "open" });
    const stale = await alice.post("/issues/mrg-held:close", { x_fencing_token: claim.body.x_fencing_token });
    expect(stale.body).toMatchObject({ code: "precondition_failed", reason: "stale_claim" });
  });
});

describe("claim fence on the claimant's own update", () => {
  it("lets the live claimant change its assignee and status without a force, and still refuses everyone else", async () => {
    const alice = tracker("ownclaim", await tokenFor("alice-own@example.com"), "worker-a");
    const bob = tracker("ownclaim", await tokenFor("bob-own@example.com"), "worker-b");
    const id = await alice.create("held");
    expect((await alice.post(`/issues/${id}:claim`, {})).status).toBe(200);

    const refused = await bob.patch(`/issues/${id}`, { patch: { assignee: "worker-b" } });
    expect(refused.body).toMatchObject({ code: "already_claimed" });

    const released = await alice.patch(`/issues/${id}`, { patch: { assignee: "" } });
    expect(released.status).toBe(200);
    expect((await alice.get(`/issues/${id}`)).body.assignee).toBeUndefined();

    const second = await alice.create("held again");
    expect((await alice.post(`/issues/${second}:claim`, {})).status).toBe(200);
    const moved = await alice.patch(`/issues/${second}`, { patch: { status: "open", assignee: "" } });
    expect(moved.status).toBe(200);
    expect((await alice.get(`/issues/${second}`)).body).toMatchObject({ status: "open" });
  });
});
