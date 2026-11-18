// Bulk full-record reads: the read twin of `POST .../issues:import`.
//
//  - `exportIssues` pages the issues of a tracker in id order, each as the record the import accepts
//    (the `Issue` members plus `labels`, `dependencies` and `comments`) together with the derived
//    members a listing carries (`dependency_count`, `dependent_count`, `comment_count`, `parent`);
//  - `exportDependencies` pages every stored edge in (issue, target) order.
//
// Both are keyset paged and bounded: a page never holds more than `limit` rows, and an issues page
// stops early once its text reaches PAGE_TEXT_BYTES, so a tracker with very large bodies is read in
// more, smaller pages instead of one that exhausts the object's memory.
import { b64, listConditions, unb64, type ListQuery } from "./issues";
import { all, chunks, edgeJson, issuesWithCounts, type EdgeRow, type IssueRow } from "./model";
import { invalid, refuse } from "./problem";
import type { Out } from "./problem";
import { blockedAmong } from "./ready";

export const EXPORT_DEFAULT_LIMIT = 200;
export const EXPORT_MAX_LIMIT = 500;
export const EDGE_EXPORT_DEFAULT_LIMIT = 1000;
export const EDGE_EXPORT_MAX_LIMIT = 5000;
export const MAX_EXPORT_IDS = 100;
/** UTF-8 bytes of text an export page may carry (every text column, labels, edges and comments) before it is cut short. */
const PAGE_TEXT_BYTES = 4 << 20;
/** What a member, a label, an edge or a comment costs in JSON beyond its text: keys, quotes, timestamps and separators. */
const ITEM_OVERHEAD = 1024;
const PART_OVERHEAD = 192;

/** SQL: the UTF-8 byte length of a text expression (SQLite's length() counts characters on TEXT). */
const bytes = (expr: string) => `COALESCE(length(CAST(${expr} AS BLOB)), 0)`;

export interface ExportQuery extends Omit<ListQuery, "sort" | "brief" | "all"> {
  updatedAfter?: string;
  updatedBefore?: string;
  /** Exact ids to read; the others filters still apply. */
  ids?: string[];
  /** Also emit `is_blocked`, which costs a graph walk. */
  blocked?: boolean;
  /** Also emit `revision`, the optimistic-concurrency token `getIssue` carries. */
  revision?: boolean;
}

const badCursor = () => refuse("invalid_cursor", "cursor is not valid for this server; restart paging without it");

function decode(token: string): unknown {
  if (!token.startsWith("x1.")) throw badCursor();
  try {
    return JSON.parse(unb64(token.slice(3)));
  } catch {
    throw badCursor();
  }
}

export function limitOf(limit: number | undefined, fallback: number, max: number): number {
  if (limit === undefined) return fallback;
  if (limit < 1 || limit > max) throw invalid("limit", `limit must be from 1 to ${max}`);
  return limit;
}

/** The logical id of a stored comment: an import prefixes the id it was given, and a round trip must not stack prefixes. */
export const commentIdOut = (tracker: string, id: string) => (id.startsWith(`imp:${tracker}:`) ? id.slice(`imp:${tracker}:`.length) : id);

/**
 * The stored state a listing projection hides, so that importing an export page changes nothing. The
 * listing shows a lease only on an in-progress row and leaves out an empty `external_ref`; an export is
 * the record `issues:import` accepts, so every nullable column that holds a value is carried with its exact
 * state: `null` is absent, an empty string is an empty string, and a lease or heartbeat is carried whatever
 * the status (an import stores them as given).
 */
function storedState(row: IssueRow): Record<string, string> {
  return {
    ...(row.lease_expires_at !== null ? { lease_expires_at: row.lease_expires_at } : {}),
    ...(row.heartbeat_at !== null ? { heartbeat_at: row.heartbeat_at } : {}),
    ...(row.external_ref !== null ? { external_ref: row.external_ref } : {}),
  };
}

export function exportIssues(sql: SqlStorage, tracker: string, q: ExportQuery): Out {
  const limit = limitOf(q.limit, EXPORT_DEFAULT_LIMIT, EXPORT_MAX_LIMIT);
  let after: string | undefined;
  if (q.cursor !== undefined) {
    const c = decode(q.cursor);
    if (typeof c !== "string") throw badCursor();
    after = c;
  }
  if (q.ids !== undefined && q.ids.length > MAX_EXPORT_IDS) throw invalid("ids", `at most ${MAX_EXPORT_IDS} ids per request`);

  // No status named means every status, pinned and closed rows included; naming one narrows as the list does.
  const { where, p } = listConditions(sql, tracker, { ...q, all: !q.status || q.status.length === 0 });
  if (q.updatedAfter) where.push(`i.updated_at > ${p.add(q.updatedAfter)}`);
  if (q.updatedBefore) where.push(`i.updated_at < ${p.add(q.updatedBefore)}`);
  if (q.ids !== undefined) where.push(`i.id IN (SELECT value FROM json_each(${p.add(JSON.stringify(q.ids))}))`);
  if (after !== undefined) where.push(`i.id > ${p.add(after)}`);

  // Sizes first, so the page can be cut by weight before any large text is read. The weight is the UTF-8
  // bytes of every emitted text: all text columns of the row (title, bodies, metadata, extra, ...), its
  // labels, every edge (target, type, metadata, creator) and every comment (id, author, text), plus a fixed
  // allowance per member for the JSON around them.
  const sized = all<{ id: string; size: number }>(
    sql,
    `SELECT i.id AS id,
            ${ITEM_OVERHEAD}
              + ${["title", "description", "design", "acceptance_criteria", "notes", "assignee", "owner", "created_by", "close_reason", "closed_by_session", "external_ref", "sender", "metadata", "extra"].map((c) => bytes(`i.${c}`)).join(" + ")}
              + COALESCE((SELECT SUM(${bytes("l.label")} + ${PART_OVERHEAD}) FROM labels l WHERE l.tracker = ?1 AND l.issue_id = i.id), 0)
              + COALESCE((SELECT SUM(${bytes("d.depends_on_id")} + ${bytes("d.type")} + ${bytes("d.metadata")} + ${bytes("d.created_by")} + ${PART_OVERHEAD})
                            FROM dependencies d WHERE d.tracker = ?1 AND d.issue_id = i.id), 0)
              + COALESCE((SELECT SUM(${bytes("c.id")} + ${bytes("c.author")} + ${bytes("c.text")} + ${PART_OVERHEAD})
                            FROM comments c WHERE c.tracker = ?1 AND c.issue_id = i.id), 0) AS size
       FROM issues i WHERE ${where.join(" AND ")} ORDER BY i.id ASC LIMIT ${p.add(limit + 1)}`,
    ...p.values,
  );
  let take = 0;
  let weight = 0;
  for (const row of sized.slice(0, limit)) {
    if (take > 0 && weight + row.size > PAGE_TEXT_BYTES) break;
    weight += row.size;
    take++;
  }
  const picked = sized.slice(0, take);
  const hasMore = sized.length > take;

  const byId = new Map<string, IssueRow>();
  for (const part of chunks(picked.map((r) => r.id))) {
    const marks = part.map((_, i) => `?${i + 2}`).join(",");
    for (const r of all<IssueRow>(sql, `SELECT * FROM issues WHERE tracker = ?1 AND id IN (${marks})`, tracker, ...part)) byId.set(r.id, r);
  }
  const rows = picked.map((r) => byId.get(r.id)!).filter((r) => r !== undefined);

  const comments = new Map<string, { id: string; author: string; text: string; created_at: string }[]>();
  for (const part of chunks(rows.map((r) => r.id))) {
    const marks = part.map((_, i) => `?${i + 2}`).join(",");
    for (const c of all<{ id: string; issue_id: string; author: string; text: string; created_at: string }>(
      sql,
      `SELECT id, issue_id, author, text, created_at FROM comments WHERE tracker = ?1 AND issue_id IN (${marks}) ORDER BY issue_id, created_at, rowid`,
      tracker, ...part,
    )) {
      (comments.get(c.issue_id) ?? comments.set(c.issue_id, []).get(c.issue_id)!).push({ id: commentIdOut(tracker, c.id), author: c.author, text: c.text, created_at: c.created_at });
    }
  }

  const items = issuesWithCounts(sql, tracker, rows, { blocked: q.blocked ? blockedAmong(sql, tracker, rows.map((r) => r.id)) : undefined }).map((item) => {
    const stored = byId.get(item.id)!;
    const thread = comments.get(item.id);
    const withThread = thread ? { ...item, ...storedState(stored), comments: thread } : { ...item, ...storedState(stored) };
    return q.revision ? { ...withThread, revision: String(stored.version) } : withThread;
  });
  const last = rows[rows.length - 1];
  return { status: 200, body: { items, has_more: hasMore, ...(hasMore && last ? { next_cursor: `x1.${b64(JSON.stringify(last.id))}` } : {}) } };
}

export interface EdgeExportQuery {
  cursor?: string;
  limit?: number;
  types?: string[];
}

export function exportDependencies(sql: SqlStorage, tracker: string, q: EdgeExportQuery): Out {
  const limit = limitOf(q.limit, EDGE_EXPORT_DEFAULT_LIMIT, EDGE_EXPORT_MAX_LIMIT);
  const bindings: unknown[] = [tracker];
  const add = (v: unknown) => `?${bindings.push(v)}`;
  const where = ["d.tracker = ?1"];
  if (q.cursor !== undefined) {
    const c = decode(q.cursor);
    if (!Array.isArray(c) || c.length !== 2 || typeof c[0] !== "string" || typeof c[1] !== "string") throw badCursor();
    where.push(`(d.issue_id, d.depends_on_id) > (${add(c[0])}, ${add(c[1])})`);
  }
  if (q.types && q.types.length > 0) where.push(`d.type IN (${q.types.map(add).join(",")})`);
  // Edge metadata and the creator are unbounded text, so a page is cut by UTF-8 weight as well as by count.
  const rows = all<EdgeRow & { size: number } & Record<string, SqlStorageValue>>(
    sql,
    `SELECT d.issue_id, d.depends_on_id, d.type, d.created_at, d.created_by, d.metadata,
            ${PART_OVERHEAD} + ${bytes("d.issue_id")} + ${bytes("d.depends_on_id")} + ${bytes("d.type")} + ${bytes("d.metadata")} + ${bytes("d.created_by")} AS size
       FROM dependencies d WHERE ${where.join(" AND ")} ORDER BY d.issue_id, d.depends_on_id LIMIT ${add(limit + 1)}`,
    ...bindings,
  );
  let take = 0;
  let weight = 0;
  for (const row of rows.slice(0, limit)) {
    if (take > 0 && weight + row.size > PAGE_TEXT_BYTES) break;
    weight += row.size;
    take++;
  }
  const hasMore = rows.length > take;
  const page = rows.slice(0, take);
  const last = page[page.length - 1];
  return {
    status: 200,
    body: { items: page.map(edgeJson), has_more: hasMore, ...(hasMore && last ? { next_cursor: `x1.${b64(JSON.stringify([last.issue_id, last.depends_on_id]))}` } : {}) },
  };
}
