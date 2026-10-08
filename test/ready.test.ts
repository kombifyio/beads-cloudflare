// The ready-work rule at the HTTP boundary, against a straightforward reference closure computed here.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { SCOPE_IMPORT, SCOPE_READ, SCOPE_WRITE } from "../src/auth/scopes";
import { call, tracker } from "./helpers";

const AT = "2025-01-01T00:00:00Z";
const DONE = ["closed", "pinned"];

interface Edge { to: string; type: string; metadata?: Record<string, unknown> }
interface Rec { id: string; status: string; pinned: boolean; edges: Edge[] }

/**
 * The blocking rule as written in docs/semantics.md, solved by plain iteration to a fixed point: a row that is
 * not done is blocked when it has a live direct blocker or a parent-child edge to a blocked row.
 */
function reference(recs: Rec[]): Set<string> {
  const byId = new Map(recs.map((r) => [r.id, r]));
  const done = (r: Rec | undefined) => r !== undefined && DONE.includes(r.status);
  const childrenOf = (spawner: string) => recs.filter((r) => r.edges.some((e) => e.type === "parent-child" && e.to === spawner));
  const direct = (r: Rec): boolean => {
    if (done(r)) return false;
    return r.edges.some((e) => {
      if (e.type === "blocks" || e.type === "conditional-blocks") {
        const target = byId.get(e.to);
        return target !== undefined && !done(target);
      }
      if (e.type !== "waits-for") return false;
      const children = childrenOf(e.to);
      const anyChildren = e.metadata?.gate === "any-children";
      const held = children.some((c) => !done(c)) && !(anyChildren && children.some((c) => c.status === "closed"));
      const spawner = byId.get(e.to);
      return held || (e.metadata?.also_blocks === true && spawner !== undefined && !done(spawner));
    });
  };
  const blocked = new Set<string>();
  for (let changed = true; changed; ) {
    changed = false;
    for (const r of recs) {
      if (blocked.has(r.id) || done(r)) continue;
      if (direct(r) || r.edges.some((e) => e.type === "parent-child" && blocked.has(e.to))) {
        blocked.add(r.id);
        changed = true;
      }
    }
  }
  return blocked;
}

const wire = (r: Rec) => ({
  id: r.id, title: r.id, priority: 2, status: r.status, issue_type: "task", created_at: AT, pinned: r.pinned || undefined,
  dependencies: r.edges.map((e) => ({ depends_on_id: e.to, type: e.type, created_at: AT, ...(e.metadata ? { metadata: e.metadata } : {}) })),
});

async function importKey(label: string): Promise<string> {
  const admin = await call("POST", "/admin/keys", env.ADMIN_TOKEN, { label, scopes: [SCOPE_READ, SCOPE_WRITE, SCOPE_IMPORT] });
  expect(admin.status).toBe(201);
  return admin.body.key;
}

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomGraph(name: string, rand: () => number): Rec[] {
  const n = 3 + Math.floor(rand() * 9);
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;
  const recs: Rec[] = Array.from({ length: n }, (_, i) => ({
    id: `${name}-${i}`,
    status: pick(["open", "open", "open", "in_progress", "blocked", "deferred", "closed", "pinned", "hooked"]),
    pinned: rand() < 0.1,
    edges: [],
  }));
  for (const from of recs) {
    for (const to of recs) {
      if (from === to || rand() > 0.28) continue;
      const type = pick(["parent-child", "parent-child", "blocks", "conditional-blocks", "waits-for", "related"]);
      const metadata = type === "waits-for" ? pick([undefined, { gate: "any-children" }, { also_blocks: true }, { gate: "all-children", also_blocks: true }]) : undefined;
      from.edges.push({ to: to.id, type, ...(metadata ? { metadata } : {}) });
    }
  }
  return recs;
}

/** The fixed case of the review: parent-child a->b, b->a, a->d and a blocks edge d->x. */
const CYCLE_CASE = (name: string): Rec[] => [
  { id: `${name}-a`, status: "open", pinned: false, edges: [{ to: `${name}-b`, type: "parent-child" }, { to: `${name}-d`, type: "parent-child" }] },
  { id: `${name}-b`, status: "open", pinned: false, edges: [{ to: `${name}-a`, type: "parent-child" }] },
  { id: `${name}-d`, status: "open", pinned: false, edges: [{ to: `${name}-x`, type: "blocks" }] },
  { id: `${name}-x`, status: "open", pinned: false, edges: [] },
];

describe("ready work", () => {
  it("agrees with the reference closure on random graphs, cycles included, across ready, count, the blocked flag and claimNext", async () => {
    const key = await importKey("ready-property");
    const rand = mulberry32(20261007);
    for (let round = 0; round < 30; round++) {
      const name = `rdy${round}`;
      const recs = round === 0 ? CYCLE_CASE(name) : randomGraph(name, rand);
      // Importing in two shuffled halves makes the order in which rows and edges arrive irrelevant too.
      const t = tracker(name, key, "importer");
      const order = [...recs].sort(() => rand() - 0.5);
      for (const part of [order.slice(0, Math.ceil(order.length / 2)), order.slice(Math.ceil(order.length / 2))]) {
        if (part.length > 0) expect((await t.post("/issues:import", { issues: part.map(wire) })).status).toBe(200);
      }

      const blocked = reference(recs);
      const ready = recs.filter((r) => r.status === "open" && !r.pinned && !blocked.has(r.id)).map((r) => r.id).sort();
      const listed = ((await t.get("/ready?limit=100")).body.items as { id: string }[]).map((i) => i.id).sort();
      expect(listed, `ready, round ${round}`).toEqual(ready);
      expect((await t.get("/ready:count")).body, `count, round ${round}`).toEqual({ total: ready.length });

      const exported = (await t.get("/issues:export?blocked=true&limit=500")).body.items as { id: string; is_blocked: boolean }[];
      expect(exported.filter((i) => i.is_blocked).map((i) => i.id).sort(), `blocked flag, round ${round}`).toEqual([...blocked].sort());
      const listing = (await t.get("/issues?all=true&limit=100")).body.items as { id: string; is_blocked: boolean }[];
      expect(listing.filter((i) => i.is_blocked).map((i) => i.id).sort(), `listing flag, round ${round}`).toEqual([...blocked].sort());

      const claimed: string[] = [];
      for (;;) {
        const next = (await t.post("/issues:claimNext", {})).body as { claimed?: { id: string } };
        if (!next.claimed) break;
        claimed.push(next.claimed.id);
      }
      expect(claimed.sort(), `claimNext, round ${round}`).toEqual(ready);
    }
  });

  it("evaluates a 6,500-row parent chain without a stack of its own", async () => {
    const key = await importKey("ready-deep");
    const t = tracker("deep", key, "importer");
    const length = 6500;
    // deep-0 is the root; deep-i is a child of deep-(i-1). The root waits on an open blocker, so the whole chain is blocked.
    const rows = Array.from({ length }, (_, i) => ({
      id: `deep-${i}`, title: `d${i}`, priority: 2, status: "open", issue_type: "task", created_at: AT,
      dependencies: i === 0 ? [{ depends_on_id: "deep-blocker", type: "blocks", created_at: AT }] : [{ depends_on_id: `deep-${i - 1}`, type: "parent-child", created_at: AT }],
    }));
    rows.push({ id: "deep-blocker", title: "blocker", priority: 2, status: "open", issue_type: "task", created_at: AT, dependencies: [] });
    for (let at = 0; at < rows.length; at += 200) expect((await t.post("/issues:import", { issues: rows.slice(at, at + 200) })).status).toBe(200);

    expect((await t.get("/ready:count")).body).toEqual({ total: 1 });
    expect(((await t.get("/ready?limit=5")).body.items as { id: string }[]).map((i) => i.id)).toEqual(["deep-blocker"]);
    const tail = (await t.get(`/issues:export?ids=deep-${length - 1}&blocked=true`)).body.items as { is_blocked: boolean }[];
    expect(tail[0]!.is_blocked).toBe(true);
  });
});
