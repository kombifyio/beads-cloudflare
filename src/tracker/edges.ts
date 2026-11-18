// Dependency edges: validation, cycle and hierarchy gates, and the add/remove operations.
import { checkMembers, boundedText, nameMember } from "./body";
import { recordEvent, type Ctx } from "./events";
import { all, loadIssue, one } from "./model";
import { SCHEDULING_TYPES } from "./model";
import { invalid, refuse } from "./problem";
import type { Out } from "./problem";
import { runeLength, type Json } from "./util";

export interface EdgeInput {
  issue_id: string;
  depends_on_id: string;
  type: string;
  metadata?: string;
}

/** Where a refusal is attributed: an explicit-verb request names the edge member, a create names `dependencies`. */
export interface EdgeSite {
  mode: "verb" | "create";
  index?: number;
  /** `applyBatch` with skip_per_edge_cycle_check: the cycle probes are left to its end gate. */
  skipCycleProbe?: boolean;
}

const MAX_TYPE_BYTES = 32;

export function checkEdgeType(type: unknown, param: string): string {
  if (typeof type !== "string") throw invalid(param, `\`${param}\` must be a string`);
  const bytes = new TextEncoder().encode(type).length;
  if (type === "" || bytes > MAX_TYPE_BYTES) throw invalid(param, `\`${param}\` must be 1 to ${MAX_TYPE_BYTES} bytes`);
  return type;
}

export const prefixOf = (id: string) => id.slice(0, id.indexOf("-") + 1);

export function reaches(sql: SqlStorage, tracker: string, from: string, to: string, types: readonly string[]): boolean {
  const list = types.map((t) => `'${t}'`).join(",");
  return (
    all(
      sql,
      `WITH RECURSIVE reach(id) AS (
         SELECT ?2
         UNION
         SELECT d.depends_on_id FROM dependencies d JOIN reach r ON d.issue_id = r.id
         WHERE d.tracker = ?1 AND d.type IN (${list}))
       SELECT 1 FROM reach WHERE id = ?3`,
      tracker,
      from,
      to,
    ).length > 0
  );
}

/** Whether an edge was inserted, had its stored metadata replaced, or was already exactly as requested. */
export type EdgeResult = "added" | "changed" | "unchanged";

/** Inserts one edge after the gates upstream applies. */
export function insertEdge(ctx: Ctx, edge: EdgeInput, site: EdgeSite): EdgeResult {
  const { sql, tracker } = ctx;
  const where = site.mode === "verb" ? `edges[${site.index ?? 0}]` : "dependencies";
  const sourceParam = site.mode === "verb" ? `${where}.issue_id` : where;
  const targetParam = site.mode === "verb" ? `${where}.depends_on_id` : where;
  const nothing = site.mode === "verb" ? "nothing was written" : "nothing was created";

  if (edge.issue_id === edge.depends_on_id) {
    throw invalid(targetParam, "an issue cannot depend on itself" + (site.mode === "create" ? "; nothing was created" : ""));
  }
  if (!loadIssue(sql, tracker, edge.issue_id)) {
    throw invalid(sourceParam, `an edge's source names no issue in this workspace; ${nothing}`);
  }
  const target = loadIssue(sql, tracker, edge.depends_on_id);
  const mayBeForeign = edge.depends_on_id.startsWith("external:") || prefixOf(edge.depends_on_id) !== prefixOf(edge.issue_id);
  if (!target && !mayBeForeign) {
    throw invalid(targetParam, `an edge's target names no issue this workspace can see; ${nothing}`);
  }

  const existing = one<{ type: string; metadata: string }>(
    sql,
    "SELECT type, metadata FROM dependencies WHERE tracker = ?1 AND issue_id = ?2 AND depends_on_id = ?3",
    tracker,
    edge.issue_id,
    edge.depends_on_id,
  );
  if (existing) {
    if (existing.type !== edge.type) {
      throw refuse("dependency_exists", "this pair already carries an edge of a different type; remove it before re-adding", {
        existing_type: existing.type,
        requested_type: edge.type,
      });
    }
    // Re-adding replaces the stored metadata (upstream resets it to {}); only a real change is journaled.
    const metadata = edge.metadata ?? "{}";
    if (metadata === existing.metadata) return "unchanged";
    sql.exec(
      "UPDATE dependencies SET metadata = ?4 WHERE tracker = ?1 AND issue_id = ?2 AND depends_on_id = ?3",
      tracker,
      edge.issue_id,
      edge.depends_on_id,
      metadata,
    );
    return "changed";
  }

  if (!site.skipCycleProbe && target && (edge.type === "blocks" || edge.type === "conditional-blocks")) {
    const ancestor = reaches(sql, tracker, edge.issue_id, edge.depends_on_id, ["parent-child"]);
    const descendant = reaches(sql, tracker, edge.depends_on_id, edge.issue_id, ["parent-child"]);
    if (ancestor || descendant) {
      throw refuse("dependency_cycle", "a blocking edge against the issue's own ancestor or descendant would never clear", {
        issue_id: edge.issue_id,
        blocker_id: edge.depends_on_id,
        blocker_is_ancestor: ancestor,
      });
    }
  }
  if (!site.skipCycleProbe && SCHEDULING_TYPES.includes(edge.type) && reaches(sql, tracker, edge.depends_on_id, edge.issue_id, SCHEDULING_TYPES)) {
    throw refuse("dependency_cycle", `the requested edges would create a dependency cycle; ${nothing}`, {
      ...(site.mode === "create" ? { param: "dependencies" } : {}),
    });
  }

  sql.exec(
    "INSERT INTO dependencies (tracker, issue_id, depends_on_id, type, metadata, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)",
    tracker,
    edge.issue_id,
    edge.depends_on_id,
    edge.type,
    edge.metadata ?? "{}",
    ctx.now,
    ctx.actor,
  );
  return "added";
}

export function recordEdgeAdded(ctx: Ctx, edge: EdgeInput): void {
  recordEvent(ctx, {
    op: "dep_add",
    kind: "dependency_added",
    issueId: edge.issue_id,
    dep: { kind: edge.type, target: edge.depends_on_id, metadata: edge.metadata ?? "{}" },
  });
}

export function recordEdgeRemoved(ctx: Ctx, issueId: string, target: string, type: string, metadata: string): void {
  recordEvent(ctx, { op: "dep_remove", kind: "dependency_removed", issueId, dep: { kind: type, target, metadata } });
}

function endpoint(value: unknown, param: string): string {
  if (typeof value !== "string") throw invalid(param, `\`${param}\` must be a string`);
  if (value === "") throw invalid(param, `\`${param}\` must not be empty`);
  if (runeLength(value) > 255) throw invalid(param, `\`${param}\` is longer than 255 characters`);
  return boundedText(value, param);
}

export function addDependencies(ctx: Ctx, body: Json): Out {
  checkMembers(body, ["actor", "edges"]);
  ctx.clientActor = nameMember(body, "actor");
  const edges = body.edges;
  if (edges === undefined || edges === null) throw invalid("edges", "`edges` is required");
  if (!Array.isArray(edges)) throw invalid("edges", "`edges` must be an array of objects");
  if (edges.length === 0 || edges.length > 100) throw invalid("edges", "`edges` must carry 1 to 100 edges");

  const parsed = edges.map((raw: unknown, i): EdgeInput => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw invalid(`edges[${i}]`, "`edges` must be an array of objects");
    const e = raw as Json;
    checkMembers(e, ["issue_id", "depends_on_id", "type"], "this member");
    const issue_id = endpoint(e.issue_id, `edges[${i}].issue_id`);
    const depends_on_id = endpoint(e.depends_on_id, `edges[${i}].depends_on_id`);
    return { issue_id, depends_on_id, type: checkEdgeType(e.type, `edges[${i}].type`) };
  });

  // Parent-child edges first, like upstream, so later gates see the hierarchy.
  const order = parsed.map((edge, index) => ({ edge, index })).sort((a, b) => Number(b.edge.type === "parent-child") - Number(a.edge.type === "parent-child"));
  for (const { edge, index } of order) {
    if (insertEdge(ctx, edge, { mode: "verb", index }) !== "unchanged") recordEdgeAdded(ctx, edge);
  }
  return { status: 200, body: { added: parsed.map(({ issue_id, depends_on_id, type }) => ({ issue_id, depends_on_id, type })) } };
}

export function removeDependency(ctx: Ctx, body: Json): Out {
  checkMembers(body, ["actor", "issue_id", "depends_on_id"]);
  ctx.clientActor = nameMember(body, "actor");
  const issue_id = endpoint(body.issue_id, "issue_id");
  const depends_on_id = endpoint(body.depends_on_id, "depends_on_id");
  const existing = one<{ type: string; metadata: string }>(
    ctx.sql,
    "SELECT type, metadata FROM dependencies WHERE tracker = ?1 AND issue_id = ?2 AND depends_on_id = ?3",
    ctx.tracker,
    issue_id,
    depends_on_id,
  );
  if (!existing) return { status: 200, body: { removed: false } };
  ctx.sql.exec("DELETE FROM dependencies WHERE tracker = ?1 AND issue_id = ?2 AND depends_on_id = ?3", ctx.tracker, issue_id, depends_on_id);
  recordEdgeRemoved(ctx, issue_id, depends_on_id, existing.type, existing.metadata);
  return { status: 200, body: { removed: true } };
}
