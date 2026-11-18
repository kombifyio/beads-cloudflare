// Dependency graph reads: edge listing and counts, blocking annotations, the tree walk, cycles and neighbors.
//
// Upstream: internal/httpapi/{edges,blocking,tree,cycles,related}.go; internal/storage/issueops/
// {edge_counts,blocking_annotation,dependency_tree,tree_walk,cycle_report,cycles,relations}.go and
// dependency_queries.go:531-760. This server holds one dependency table, so the two-plane unions upstream
// describes collapse to a single read.
import { all, chunks, edgeJson, issueJson, labelsOf, loadIssue, one, type EdgeRow, type IssueRow } from "./model";
import { invalid, issueNotFound } from "./problem";
import type { Out } from "./problem";
import { idIsAddressable } from "./issues";

export const MAX_ANCHORS = 100;
const MAX_TYPE_BYTES = 32;

export interface AnchorParams {
  ids: string[];
  types: string[];
}

/** `issue_id` and `type` of the three batched reads: distinct, bounded, never empty. */
export function checkAnchors(rawIds: string[], rawTypes: string[]): AnchorParams {
  if (rawIds.some((id) => id === "")) throw invalid("issue_id", "an issue_id must not be empty");
  const ids = [...new Set(rawIds)];
  if (ids.length === 0) throw invalid("issue_id", "name at least one issue_id");
  if (ids.length > MAX_ANCHORS) throw invalid("issue_id", `at most ${MAX_ANCHORS} issue_id values per request, got ${ids.length}`);
  for (const t of rawTypes) {
    if (t === "" || new TextEncoder().encode(t).length > MAX_TYPE_BYTES) {
      throw invalid("type", `an edge type must be 1 to ${MAX_TYPE_BYTES} bytes`);
    }
  }
  return { ids, types: [...new Set(rawTypes)] };
}

const typeClause = (types: string[], first: number) =>
  types.length === 0 ? "" : ` AND type IN (${types.map((_, i) => `?${first + i}`).join(",")})`;

const EDGE_COLUMNS = "issue_id, depends_on_id, type, created_at, created_by, metadata";

/** The ids among `ids` that name an issue. */
function existing(sql: SqlStorage, tracker: string, ids: string[]): Set<string> {
  const found = new Set<string>();
  for (const part of chunks(ids)) {
    for (const r of all<{ id: string }>(sql, `SELECT id FROM issues WHERE tracker = ?1 AND id IN (${part.map((_, i) => `?${i + 2}`).join(",")})`, tracker, ...part)) {
      found.add(r.id);
    }
  }
  return found;
}

// ---------------------------------------------------------------------------------------------
// listDependencies

export function listDependencies(sql: SqlStorage, tracker: string, q: AnchorParams): Out {
  const present = existing(sql, tracker, q.ids);
  const items: unknown[] = [];
  const missing: string[] = [];
  for (const id of q.ids) {
    if (!present.has(id)) {
      missing.push(id);
      continue;
    }
    for (const e of all<EdgeRow & Record<string, SqlStorageValue>>(
      sql,
      `SELECT ${EDGE_COLUMNS} FROM dependencies WHERE tracker = ?1 AND issue_id = ?2${typeClause(q.types, 3)} ORDER BY depends_on_id`,
      tracker, id, ...q.types,
    )) items.push(edgeJson(e));
  }
  return { status: 200, body: { items, missing } };
}

// ---------------------------------------------------------------------------------------------
// countDependencyEdges

export function countDependencyEdges(sql: SqlStorage, tracker: string, q: AnchorParams & { direction: "out" | "in"; status?: string }): Out {
  const present = existing(sql, tracker, q.ids);
  const anchors = q.ids.map((id) => {
    if (!present.has(id)) return { id, count: 0, missing: true };
    const column = q.direction === "out" ? "d.issue_id" : "d.depends_on_id";
    const typed = q.types.length === 0 ? "" : ` AND d.type IN (${q.types.map((_, i) => `?${i + 3}`).join(",")})`;
    // `status` narrows by the dependent (the source end), so it is legal only for `in`.
    const status = q.status ? ` AND EXISTS (SELECT 1 FROM issues s WHERE s.tracker = d.tracker AND s.id = d.issue_id AND s.status = ?${q.types.length + 3})` : "";
    const count = one<{ n: number }>(
      sql,
      `SELECT COUNT(*) AS n FROM dependencies d WHERE d.tracker = ?1 AND ${column} = ?2${typed}${status}`,
      tracker, id, ...q.types, ...(q.status ? [q.status] : []),
    )!.n;
    return { id, count, missing: false };
  });
  return { status: 200, body: { anchors } };
}

// ---------------------------------------------------------------------------------------------
// listBlockingAnnotations

export function listBlockingAnnotations(sql: SqlStorage, tracker: string, ids: string[]): Out {
  const statusOf = (id: string) => one<{ status: string }>(sql, "SELECT status FROM issues WHERE tracker = ?1 AND id = ?2", tracker, id)?.status;
  const items = ids.map((id) => {
    const blockedBy = new Set<string>();
    let parent: string | undefined;
    for (const e of all<{ depends_on_id: string; type: string }>(
      sql, "SELECT depends_on_id, type FROM dependencies WHERE tracker = ?1 AND issue_id = ?2 AND type IN ('blocks', 'parent-child')", tracker, id)) {
      // A blocker this workspace holds no row for still blocks: an unreadable status is not `closed`.
      if (statusOf(e.depends_on_id) === "closed") continue;
      if (e.type === "parent-child") parent = e.depends_on_id;
      else blockedBy.add(e.depends_on_id);
    }
    const blocks = new Set<string>();
    if (statusOf(id) !== "closed") {
      for (const e of all<{ issue_id: string }>(sql, "SELECT issue_id FROM dependencies WHERE tracker = ?1 AND depends_on_id = ?2 AND type = 'blocks'", tracker, id)) {
        blocks.add(e.issue_id);
      }
    }
    return { id, blocked_by: [...blockedBy].sort(), blocks: [...blocks].sort(), ...(parent ? { parent } : {}) };
  });
  return { status: 200, body: { items } };
}

// ---------------------------------------------------------------------------------------------
// neighbors, tree

const byIdThenType = (a: { id: string; type: string }, b: { id: string; type: string }) =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : a.type < b.type ? -1 : a.type > b.type ? 1 : 0;

/** The issues on the far end of `id`'s edges (an edge whose far end names no issue contributes nothing). */
function neighbors(sql: SqlStorage, tracker: string, id: string, direction: "out" | "in", types: string[] = []): { row: IssueRow; type: string }[] {
  const [near, far] = direction === "out" ? ["issue_id", "depends_on_id"] : ["depends_on_id", "issue_id"];
  const edges = all<{ far: string; type: string }>(
    sql,
    `SELECT ${far} AS far, type FROM dependencies WHERE tracker = ?1 AND ${near} = ?2${typeClause(types, 3)}`,
    tracker, id, ...types,
  );
  return edges
    .map((e) => ({ id: e.far, type: e.type }))
    .sort(byIdThenType)
    .flatMap((e) => {
      const row = loadIssue(sql, tracker, e.id);
      return row ? [{ row, type: e.type }] : [];
    });
}

export function listRelatedIssues(sql: SqlStorage, tracker: string, id: string, q: { direction: "out" | "in"; types: string[] }): Out {
  if (!idIsAddressable(id) || !loadIssue(sql, tracker, id)) throw issueNotFound();
  const items = neighbors(sql, tracker, id, q.direction, q.types).map(({ row, type }) => ({
    ...issueJson(row, labelsOf(sql, tracker, row.id)),
    dependency_type: type,
  }));
  return { status: 200, body: { items } };
}

interface TreeNode {
  row: IssueRow;
  depth: number;
  parentId: string;
  edge: string;
}

/** GetDependencyTreeInTx (dependency_tree.go:12-80): depth-first pre-order, every node once, `relates-to` not followed. */
function walk(sql: SqlStorage, tracker: string, rootId: string, maxDepth: number, up: boolean): TreeNode[] {
  const out: TreeNode[] = [];
  const visited = new Set<string>();
  const stack: { id: string; depth: number; parentId: string; edge: string }[] = [{ id: rootId, depth: 0, parentId: "", edge: "" }];
  while (stack.length > 0) {
    const f = stack.pop()!;
    if (f.depth >= maxDepth || visited.has(f.id)) continue;
    visited.add(f.id);
    const row = loadIssue(sql, tracker, f.id);
    if (!row) continue;
    out.push({ row, depth: f.depth, parentId: f.parentId, edge: f.edge });
    const next = neighbors(sql, tracker, f.id, up ? "in" : "out").filter((n) => n.type !== "relates-to");
    for (let i = next.length - 1; i >= 0; i--) stack.push({ id: next[i]!.row.id, depth: f.depth + 1, parentId: f.id, edge: next[i]!.type });
  }
  return out;
}

/** PruneTreeByStatus (tree_walk.go:41-75): the matching nodes and the ancestor chain of each. */
function prune(nodes: TreeNode[], status: string): TreeNode[] {
  const parentOf = new Map<string, string>();
  for (const n of nodes) if (n.parentId !== "" && n.parentId !== n.row.id) parentOf.set(n.row.id, n.parentId);
  const keep = new Set<string>();
  for (const n of nodes) {
    if (n.row.status !== status || keep.has(n.row.id)) continue;
    keep.add(n.row.id);
    for (let cur = n.row.id; ; ) {
      const parent = parentOf.get(cur);
      if (parent === undefined || parent === cur || keep.has(parent)) break;
      keep.add(parent);
      cur = parent;
    }
  }
  return nodes.filter((n) => keep.has(n.row.id));
}

export interface TreeParams {
  rootId: string;
  direction: "down" | "up" | "both";
  maxDepth: number;
  status?: string;
}

export function getDependencyTree(sql: SqlStorage, tracker: string, q: TreeParams): Out {
  if (q.rootId === "") throw invalid("root_id", "root_id is required and must be an exact issue id");
  if (q.maxDepth < 1) throw invalid("max_depth", `max depth must be at least 1, got ${q.maxDepth}`);
  if (!idIsAddressable(q.rootId) || !loadIssue(sql, tracker, q.rootId)) throw issueNotFound();

  let nodes: TreeNode[];
  if (q.direction !== "both") {
    nodes = walk(sql, tracker, q.rootId, q.maxDepth, q.direction === "up");
    if (q.status) nodes = prune(nodes, q.status);
  } else {
    let down = walk(sql, tracker, q.rootId, q.maxDepth, false);
    let upward = walk(sql, tracker, q.rootId, q.maxDepth, true);
    if (q.status) {
      const fullDown = down;
      down = prune(down, q.status);
      upward = prune(upward, q.status);
      // tree_walk.go:155-177: a surviving up half keeps the root so the answer still has one.
      if (upward.length > 0 && !down.some((n) => n.row.id === q.rootId)) {
        const root = fullDown.find((n) => n.row.id === q.rootId);
        if (root) down = [root, ...down];
      }
    }
    nodes = [...upward.filter((n) => n.row.id !== q.rootId), ...down];
  }
  const items = nodes.map((n) => ({
    ...issueJson(n.row, labelsOf(sql, tracker, n.row.id)),
    depth: n.depth,
    parent_id: n.parentId,
    ...(n.edge ? { edge_from_parent: n.edge } : {}),
    truncated: false,
  }));
  return { status: 200, body: { items, has_more: false } };
}

// ---------------------------------------------------------------------------------------------
// cycles

/** CanonicalCyclePaths (cycle_report.go:15-70): lowest id first, cycles sorted against each other. */
export function canonicalCyclePaths(graph: Map<string, string[]>): string[][] {
  const adjacency = new Map<string, string[]>();
  for (const [node, targets] of graph) adjacency.set(node, [...new Set(targets)].sort());
  const roots = [...graph.keys()].sort();
  const cycles: string[][] = [];
  const visited = new Set<string>();
  const onPath = new Set<string>();
  const path: string[] = [];

  const visit = (start: string) => {
    // Iterative form of the recursive walk, so a long chain cannot exhaust the stack.
    const frames: { node: string; next: number }[] = [];
    const enter = (node: string) => {
      visited.add(node);
      onPath.add(node);
      path.push(node);
      frames.push({ node, next: 0 });
    };
    enter(start);
    while (frames.length > 0) {
      const frame = frames[frames.length - 1]!;
      const targets = adjacency.get(frame.node) ?? [];
      if (frame.next < targets.length) {
        const target = targets[frame.next++]!;
        if (!visited.has(target)) enter(target);
        else if (onPath.has(target)) {
          const at = path.indexOf(target);
          if (at >= 0) cycles.push(rotateToLowest(path.slice(at)));
        }
      } else {
        path.pop();
        onPath.delete(frame.node);
        frames.pop();
      }
    }
  };
  for (const root of roots) if (!visited.has(root)) visit(root);
  return cycles.sort((a, b) => {
    for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
    return a.length - b.length;
  });
}

function rotateToLowest(path: string[]): string[] {
  let lowest = 0;
  path.forEach((id, i) => {
    if (id < path[lowest]!) lowest = i;
  });
  return [...path.slice(lowest), ...path.slice(0, lowest)];
}

export function listDependencyCycles(sql: SqlStorage, tracker: string): Out {
  // cycles.go:131-160: `blocks` and `conditional-blocks` only; waits-for and parent-child are not walked.
  const graph = new Map<string, string[]>();
  for (const e of all<{ issue_id: string; depends_on_id: string }>(
    sql, "SELECT issue_id, depends_on_id FROM dependencies WHERE tracker = ?1 AND type IN ('blocks', 'conditional-blocks')", tracker)) {
    (graph.get(e.issue_id) ?? graph.set(e.issue_id, []).get(e.issue_id)!).push(e.depends_on_id);
  }
  const cycles = canonicalCyclePaths(graph).map((path) => {
    const members = path.map((id) => {
      const row = loadIssue(sql, tracker, id);
      return row ? { id, issue: issueJson(row, labelsOf(sql, tracker, id)) } : { id };
    });
    return { members, partial: members.some((m) => !("issue" in m)) };
  });
  return { status: 200, body: { items: cycles, has_more: false } };
}
