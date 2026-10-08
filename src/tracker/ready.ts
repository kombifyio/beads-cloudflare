// The ready-work rule, ported from upstream Beads v1.3.1 (see docs/semantics.md for the citations).
// One SQL statement per request: a blocked closure over the dependency graph, then the candidate filter.
import { METADATA_KEY } from "./body";
import { DEFAULT_EXCLUDED_TYPES, all, issuesWithCounts, one, type IssueRow, type IssueWithCounts } from "./model";
import { invalid } from "./problem";
import { compileLabelRegex, labelMatches } from "./safe-regex";
import { activeCustomStatuses, loadVocab } from "./vocab";

/**
 * json_extract / json_type over a stored JSON column that may hold text which is not JSON (edge metadata
 * is stored as given, and rows predate today's validation): SQLite raises "malformed JSON" for such a
 * row, which would fail the whole read. A row that does not parse has no members.
 */
export const jx = (column: string, path: string) => `CASE WHEN json_valid(${column}) THEN json_extract(${column}, ${path}) END`;
export const jt = (column: string, path: string) => `CASE WHEN json_valid(${column}) THEN json_type(${column}, ${path}) END`;

export interface ReadyFilter {
  assignee?: string;
  unassigned?: boolean;
  type?: string;
  excludeType?: string[];
  label?: string[];
  labelAny?: string[];
  excludeLabel?: string[];
  /** A glob (`*`, `?`) matched against labels, as upstream's `label_pattern`. */
  labelPattern?: string;
  /** A regular expression matched against labels, as upstream's `label_regex`. */
  labelRegex?: string;
  priority?: number;
  parent?: string;
  metadataFields?: Record<string, string>;
  hasMetadataKey?: string;
  includeEphemeral?: boolean;
  includeDeferred?: boolean;
  sort?: "priority" | "oldest" | "hybrid";
  limit?: number;
  brief?: boolean;
}

export const DEFAULT_READY_LIMIT = 100;

const DONE = "('closed','pinned')";

/** Placeholders are numbered: ?1 is the tracker; further values append. */
export class Params {
  readonly values: unknown[] = [];
  /** Filters that cannot be expressed in SQL (a regular expression) read the store through this. */
  constructor(readonly sql: SqlStorage, ...initial: unknown[]) {
    this.values.push(...initial);
  }
  add(value: unknown): string {
    this.values.push(value);
    return `?${this.values.length}`;
  }
}

/**
 * True when the issue behind alias `i` has a live direct blocker (blocks, conditional-blocks, or a
 * waits-for gate that is still closed). Upstream: internal/storage/issueops/blocked_state.go:206-294.
 */
export function directBlockedPredicate(i: string): string {
  const childOf = (statusTest: string) => `EXISTS (
      SELECT 1 FROM dependencies cd JOIN issues c ON c.tracker = cd.tracker AND c.id = cd.issue_id
      WHERE cd.tracker = ?1 AND cd.type = 'parent-child' AND cd.depends_on_id = d.depends_on_id AND ${statusTest})`;
  return `(${i}.status NOT IN ${DONE} AND (
    EXISTS (SELECT 1 FROM dependencies d JOIN issues t ON t.tracker = d.tracker AND t.id = d.depends_on_id
            WHERE d.tracker = ?1 AND d.issue_id = ${i}.id AND d.type IN ('blocks','conditional-blocks')
              AND t.status NOT IN ${DONE})
    OR EXISTS (SELECT 1 FROM dependencies d WHERE d.tracker = ?1 AND d.issue_id = ${i}.id AND d.type = 'waits-for' AND (
         (${childOf(`c.status NOT IN ${DONE}`)}
          AND NOT (COALESCE(${jx("d.metadata", "'$.gate'")}, 'all-children') = 'any-children'
                   AND ${childOf("c.status = 'closed'")}))
         OR (COALESCE(${jx("d.metadata", "'$.also_blocks'")}, 'false') IN ('true', 1)
             AND EXISTS (SELECT 1 FROM issues sp WHERE sp.tracker = ?1 AND sp.id = d.depends_on_id AND sp.status NOT IN ${DONE}))
    ))))`;
}

/**
 * The transitive blocked set: rows with a live direct blocker plus children of blocked parents.
 * Placed after `WITH RECURSIVE`; the first placeholder, ?1, is the tracker.
 */
export const BLOCKED_CTES = `direct_blocked(id) AS (SELECT i.id FROM issues i WHERE i.tracker = ?1 AND ${directBlockedPredicate("i")}),
    blocked(id) AS (
      SELECT id FROM direct_blocked
      UNION
      SELECT d.issue_id FROM dependencies d
        JOIN blocked b ON b.id = d.depends_on_id
        JOIN issues c ON c.tracker = d.tracker AND c.id = d.issue_id
      WHERE d.tracker = ?1 AND d.type = 'parent-child' AND c.status NOT IN ${DONE}
    )`;

/**
 * The close policy's blocker test, which is not the readiness predicate. Upstream refuses a close only
 * when the issue is blocked (the transitive flag above) AND has at least one direct `blocks`,
 * `waits-for` or `conditional-blocks` edge to an existing target that is not closed or pinned:
 * `IsBlockedInTx`, internal/storage/issueops/dependency_queries.go:906-987, gate at close.go:145-157.
 * A waiter whose waits-for spawner is closed has no such edge, so it can be closed even while its
 * gate still holds it out of the ready set.
 */
/** The ids of every issue the dependency graph blocks (the stored `is_blocked` flag, derived on read). */
export const blockedIds = (sql: SqlStorage, tracker: string): Set<string> =>
  new Set(all<{ id: string }>(sql, `WITH RECURSIVE ${BLOCKED_CTES} SELECT id FROM blocked`, tracker).map((r) => r.id));

/**
 * The rows a verdict about `ids` can depend on: the ids themselves and, climbing parent-child edges,
 * every ancestor reached through rows that exist and are not done. A row that is done (or absent) is
 * never blocked and so never passes blockedness on to a child, which is why the climb stops at it.
 * A recursive CTE with UNION (distinct) terminates on any graph, cyclic ones included, and has no
 * stack depth of its own. CROSS JOIN pins the order (queue first, then the primary key of the edges): left
 * to itself the planner scans the edge index for every queued row, which is quadratic on a long chain.
 * Placeholders: ?1 is the tracker, ?2 the JSON array of ids.
 */
const LIVE_ANCESTORS = `live(id) AS (
      SELECT i.id FROM issues i WHERE i.tracker = ?1 AND i.id IN (SELECT value FROM json_each(?2)) AND i.status NOT IN ${DONE}
      UNION
      SELECT d.depends_on_id FROM live l
        CROSS JOIN dependencies d ON d.tracker = ?1 AND d.issue_id = l.id AND d.type = 'parent-child'
        CROSS JOIN issues p ON p.tracker = ?1 AND p.id = d.depends_on_id
      WHERE p.status NOT IN ${DONE}
    )`;

/**
 * The blocked members of a given set of ids: exactly `blockedIds` restricted to them, for every graph and
 * whatever the order of `ids`. Blocked is the least fixed point of "has a live direct blocker, or is a
 * child (parent-child edge, row not done) of a blocked row". That is computed over the gathered ancestor
 * subgraph only, so the cost follows the set and not the tracker: the live direct blockers are seeds and
 * blockedness flows from parent to child along the gathered edges by an iterative breadth-first pass, which
 * handles cycles (every row of a cycle holding a blocked row is blocked) and chains of any depth.
 */
export function blockedAmong(sql: SqlStorage, tracker: string, ids: readonly string[]): Set<string> {
  const out = new Set<string>();
  if (ids.length === 0) return out;
  const wanted = JSON.stringify([...new Set(ids)]);
  const live = new Set<string>();
  const seeds: string[] = [];
  for (const r of all<{ id: string; direct: number }>(
    sql,
    `WITH RECURSIVE ${LIVE_ANCESTORS}
     SELECT l.id AS id, ${directBlockedPredicate("i")} AS direct FROM live l CROSS JOIN issues i ON i.tracker = ?1 AND i.id = l.id`,
    tracker, wanted,
  )) {
    live.add(r.id);
    if (r.direct) seeds.push(r.id);
  }
  if (seeds.length === 0) return out;
  // parent -> children, over the parent-child edges of live rows whose parent is live as well.
  const children = new Map<string, string[]>();
  for (const e of all<{ issue_id: string; depends_on_id: string }>(
    sql,
    `WITH RECURSIVE ${LIVE_ANCESTORS}
     SELECT d.issue_id AS issue_id, d.depends_on_id AS depends_on_id FROM live l
       CROSS JOIN dependencies d ON d.tracker = ?1 AND d.issue_id = l.id AND d.type = 'parent-child'`,
    tracker, wanted,
  )) {
    if (!live.has(e.depends_on_id)) continue;
    (children.get(e.depends_on_id) ?? children.set(e.depends_on_id, []).get(e.depends_on_id)!).push(e.issue_id);
  }
  const blocked = new Set(seeds);
  const queue = [...seeds];
  for (let at = 0; at < queue.length; at++) {
    for (const child of children.get(queue[at]!) ?? []) {
      if (blocked.has(child)) continue;
      blocked.add(child);
      queue.push(child);
    }
  }
  for (const id of ids) if (blocked.has(id)) out.add(id);
  return out;
}

export const hasLiveBlocker = (sql: SqlStorage, tracker: string, id: string) =>
  all(
    sql,
    `WITH RECURSIVE ${BLOCKED_CTES}
     SELECT 1 WHERE ?2 IN (SELECT id FROM blocked)
       AND EXISTS (SELECT 1 FROM dependencies d JOIN issues t ON t.tracker = d.tracker AND t.id = d.depends_on_id
                   WHERE d.tracker = ?1 AND d.issue_id = ?2 AND d.type IN ('blocks', 'waits-for', 'conditional-blocks')
                     AND t.status NOT IN ${DONE})`,
    tracker,
    id,
  ).length > 0;

/** `column` starts with `parent` and a dot: a plain prefix test, since LIKE patterns have a small size limit. */
export const hasDottedPrefix = (p: Params, column: string, parent: string) =>
  `substr(${column}, 1, ${[...parent].length + 1}) = ${p.add(`${parent}.`)}`;

const ALIASES: Record<string, string> = {
  mr: "merge-request",
  feat: "feature",
  mol: "molecule",
  enhancement: "feature",
  dec: "decision",
  adr: "decision",
};
export const normalizeType = (type: string) => ALIASES[type.toLowerCase()] ?? type;

/** A metadata value as text; JSON booleans compare as 'true' / 'false', like upstream's JSON_UNQUOTE. */
export function metadataExpr(params: Params, key: string, param: string, alias = "i"): string {
  if (!METADATA_KEY.test(key)) throw invalid(param, `invalid metadata field key: invalid metadata key "${key}"`);
  const path = params.add(`$."${key}"`);
  const col = `${alias}.metadata`;
  return `CASE ${jt(col, path)} WHEN 'true' THEN 'true' WHEN 'false' THEN 'false' ELSE CAST(${jx(col, path)} AS TEXT) END`;
}

/** Label and metadata conditions shared by the ready and list queries. */
export function commonConditions(
  f: Pick<ReadyFilter, "label" | "labelAny" | "excludeLabel" | "labelPattern" | "labelRegex" | "hasMetadataKey" | "metadataFields">,
  p: Params,
  where: string[],
): void {
  if (f.labelPattern) {
    // sqlbuild/filter.go:377-394 globToLikePattern, with the same `|` escape.
    const like = [...f.labelPattern].map((c) => (c === "%" || c === "_" || c === "|" ? `|${c}` : c === "*" ? "%" : c === "?" ? "_" : c)).join("");
    where.push(`i.id IN (SELECT issue_id FROM labels WHERE tracker = ?1 AND label LIKE ${p.add(like)} ESCAPE '|')`);
  }
  if (f.labelRegex) {
    const re = compileLabelRegex(f.labelRegex);
    // SQLite has no REGEXP here: the labels are matched in code and handed over as one JSON array.
    const labels = all<{ label: string }>(p.sql, "SELECT DISTINCT label FROM labels WHERE tracker = ?1", p.values[0]).map((r) => r.label).filter((l) => labelMatches(re, l));
    where.push(`i.id IN (SELECT issue_id FROM labels WHERE tracker = ?1 AND label IN (SELECT value FROM json_each(${p.add(JSON.stringify(labels))})))`);
  }
  for (const label of f.label ?? []) {
    where.push(`i.id IN (SELECT issue_id FROM labels WHERE tracker = ?1 AND label = ${p.add(label)})`);
  }
  if (f.labelAny?.length) {
    where.push(`i.id IN (SELECT issue_id FROM labels WHERE tracker = ?1 AND label IN (${f.labelAny.map((l) => p.add(l)).join(",")}))`);
  }
  if (f.excludeLabel?.length) {
    where.push(`i.id NOT IN (SELECT issue_id FROM labels WHERE tracker = ?1 AND label IN (${f.excludeLabel.map((l) => p.add(l)).join(",")}))`);
  }
  if (f.hasMetadataKey !== undefined) {
    if (!METADATA_KEY.test(f.hasMetadataKey)) {
      throw invalid("has_metadata_key", `invalid metadata key filter: invalid metadata key "${f.hasMetadataKey}"`);
    }
    where.push(`${jx("i.metadata", p.add(`$."${f.hasMetadataKey}"`))} IS NOT NULL`);
  }
  for (const [key, value] of Object.entries(f.metadataFields ?? {}).sort(([a], [b]) => (a < b ? -1 : 1))) {
    where.push(`${metadataExpr(p, key, "metadata_field")} = ${p.add(value)}`);
  }
}

export interface ReadyQuery {
  sql: string;
  params: unknown[];
}

/** The first batch of candidates tested for blocking when the whole list is wanted; later batches grow, up to BLOCK_BATCH_MAX. */
const BLOCK_BATCH = 200;
const BLOCK_BATCH_MAX = 5000;

/**
 * The first `want` candidates (all of them without it) that no live blocker holds out, in candidate order.
 * The ready query leaves blocking out, because walking the whole dependency graph for a handful of rows
 * dominated the cost of a read that wants three; the candidates are tested in batches instead. A batch costs
 * about its ancestor subgraph, so the batches grow fourfold: a short answer stays cheap and a scan of the
 * whole tracker is a handful of statements, not hundreds that each climb the same parent chains again.
 */
export function unblocked(sql: SqlStorage, tracker: string, candidates: readonly string[], want?: number): string[] {
  const out: string[] = [];
  let size = want === undefined ? BLOCK_BATCH : Math.min(BLOCK_BATCH, Math.max(25, want * 2));
  for (let at = 0; at < candidates.length; at += size, size = Math.min(size * 4, BLOCK_BATCH_MAX)) {
    const part = candidates.slice(at, at + size);
    const blocked = blockedAmong(sql, tracker, part);
    for (const id of part) {
      if (blocked.has(id)) continue;
      out.push(id);
      if (want !== undefined && out.length >= want) return out;
    }
  }
  return out;
}

/**
 * `claim` mode is what claimNext scans: unassigned open rows, plus in_progress rows whose lease has
 * expired (extension), in the same order the listing uses.
 */
export function readyQuery(
  sql: SqlStorage,
  tracker: string,
  f: ReadyFilter,
  now: string,
  mode: "list" | "claim",
): ReadyQuery {
  const p = new Params(sql, tracker);
  const nowP = p.add(now);
  const where: string[] = ["i.tracker = ?1"];
  const vocab = loadVocab(sql, tracker);

  if (mode === "claim") {
    where.push(
      `((i.status = 'open' AND i.assignee = '') OR (i.status = 'in_progress' AND i.lease_expires_at IS NOT NULL AND i.lease_expires_at <= ${nowP}))`,
    );
  } else {
    // `open`, plus the custom statuses of category active (sqlbuild/ready.go:96-114).
    const active = activeCustomStatuses(vocab);
    where.push(active.length > 0 ? `i.status IN ('open', ${active.map((n) => p.add(n)).join(",")})` : "i.status = 'open'");
    if (f.unassigned) where.push("i.assignee = ''");
    else if (f.assignee !== undefined) where.push(`i.assignee = ${p.add(f.assignee)}`);
  }
  where.push("COALESCE(i.pinned, 0) = 0");
  if (!f.includeEphemeral) where.push("COALESCE(i.ephemeral, 0) = 0");
  if (f.priority !== undefined) where.push(`i.priority = ${p.add(f.priority)}`);

  if (f.type !== undefined) {
    where.push(`i.issue_type = ${p.add(normalizeType(f.type))}`);
  } else {
    const excluded = [...new Set([...DEFAULT_EXCLUDED_TYPES, ...vocab.infraTypes, ...(f.excludeType ?? []).map(normalizeType)])];
    where.push(`i.issue_type NOT IN (${excluded.map((t) => p.add(t)).join(",")})`);
  }
  if (!f.includeDeferred) {
    where.push(`(i.defer_until IS NULL OR i.defer_until <= ${nowP})`);
    where.push(`i.id NOT IN (SELECT d.issue_id FROM dependencies d JOIN issues parent ON parent.tracker = d.tracker AND parent.id = d.depends_on_id
      WHERE d.tracker = ?1 AND d.type = 'parent-child' AND parent.defer_until IS NOT NULL AND parent.defer_until > ${nowP})`);
  }
  commonConditions(f, p, where);
  let descendants = "";
  if (f.parent !== undefined) {
    const parent = p.add(f.parent);
    descendants = `WITH RECURSIVE descendants(id) AS (
      SELECT issue_id FROM dependencies WHERE tracker = ?1 AND type = 'parent-child' AND depends_on_id = ${parent}
      UNION
      SELECT d.issue_id FROM dependencies d JOIN descendants x ON d.depends_on_id = x.id WHERE d.tracker = ?1 AND d.type = 'parent-child')`;
    where.push(
      `((${hasDottedPrefix(p, "i.id", f.parent)} AND i.id NOT IN (SELECT issue_id FROM dependencies WHERE tracker = ?1 AND type = 'parent-child')) OR i.id IN (SELECT id FROM descendants))`,
    );
  }

  const sort = f.sort ?? "priority";
  let order = "i.priority ASC, i.created_at ASC, i.id ASC";
  if (sort === "oldest") order = "i.created_at ASC, i.id ASC";
  if (sort === "hybrid") {
    const cutoff = p.add(new Date(Date.parse(now) - 48 * 3600_000).toISOString());
    order = `CASE WHEN i.created_at >= ${cutoff} THEN 0 ELSE 1 END, CASE WHEN i.created_at >= ${cutoff} THEN i.priority ELSE 999 END, i.created_at ASC, i.id ASC`;
  }

  return { sql: `${descendants} SELECT i.id AS id FROM issues i WHERE ${where.join(" AND ")} ORDER BY ${order}`, params: p.values };
}

/** The ids the ready filter selects, in listing order, before blocking is considered. */
export function readyCandidates(sql: SqlStorage, tracker: string, f: ReadyFilter, now: string, mode: "list" | "claim"): string[] {
  const q = readyQuery(sql, tracker, f, now, mode);
  return all<{ id: string }>(sql, q.sql, ...q.params).map((r) => r.id);
}

/** Full rows for ids, in the order of `ids`. */
export function rowsInOrder(sql: SqlStorage, tracker: string, ids: readonly string[]): IssueRow[] {
  const byId = new Map<string, IssueRow>();
  for (let at = 0; at < ids.length; at += 90) {
    const part = ids.slice(at, at + 90);
    const marks = part.map((_, i) => `?${i + 2}`).join(",");
    for (const r of all<IssueRow>(sql, `SELECT * FROM issues WHERE tracker = ?1 AND id IN (${marks})`, tracker, ...part)) byId.set(r.id, r);
  }
  return ids.map((id) => byId.get(id)).filter((r): r is IssueRow => r !== undefined);
}

export function listReady(
  sql: SqlStorage,
  tracker: string,
  f: ReadyFilter,
  now: string,
): { items: IssueWithCounts[]; has_more: boolean } {
  const limit = f.limit ?? DEFAULT_READY_LIMIT;
  const picked = unblocked(sql, tracker, readyCandidates(sql, tracker, f, now, "list"), limit === 0 ? undefined : limit + 1);
  const has_more = limit > 0 && picked.length > limit;
  const rows = rowsInOrder(sql, tracker, has_more ? picked.slice(0, limit) : picked);
  return { items: issuesWithCounts(sql, tracker, rows, { brief: f.brief }), has_more };
}

/** The size of the unbounded listing, counted by the database rather than by loading every row. */
export function countReady(sql: SqlStorage, tracker: string, f: ReadyFilter, now: string): { total: number } {
  return { total: unblocked(sql, tracker, readyCandidates(sql, tracker, f, now, "list")).length };
}
