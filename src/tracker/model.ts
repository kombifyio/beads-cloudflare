// Rows, vocabularies and the row -> wire mapping of an issue.
import type { components } from "../generated/openapi.v0";
import { safeObject, type Json } from "./util";

export interface ClaimInspection {
  state: "none" | "unleased" | "live" | "expired";
  verified_principal: string | null;
  assignee: string;
  lease_expires_at: string | null;
  heartbeat_at: string | null;
  fencing_token: number;
  reclaimable: boolean;
}
export type Issue = components["schemas"]["Issue"] & { x_claim?: ClaimInspection };
export type IssueWithCounts = components["schemas"]["IssueWithCounts"];
export type Dependency = components["schemas"]["Dependency"];
export type Comment = components["schemas"]["Comment"];

// The built-in vocabularies; a tracker's own custom statuses and types come from ./vocab.
export const STATUSES = ["open", "in_progress", "blocked", "deferred", "closed", "pinned", "hooked"] as const;
export const ISSUE_TYPES = [
  "bug", "feature", "task", "epic", "chore", "decision", "message", "molecule", "gate", "spike", "story", "milestone", "event",
] as const;
export const DEFAULT_EXCLUDED_TYPES = ["merge-request", "gate", "molecule", "rig", "agent", "role", "message"];
// Edge types whose targets gate scheduling: cycles among them are refused.
export const SCHEDULING_TYPES = ["blocks", "conditional-blocks", "parent-child"];

export interface IssueRow {
  [column: string]: SqlStorageValue;
  tracker: string;
  id: string;
  title: string;
  description: string;
  design: string;
  acceptance_criteria: string;
  notes: string;
  status: string;
  priority: number;
  issue_type: string;
  assignee: string;
  owner: string;
  estimated_minutes: number | null;
  created_at: string;
  created_by: string;
  updated_at: string;
  started_at: string | null;
  closed_at: string | null;
  close_reason: string;
  closed_by_session: string;
  external_ref: string | null;
  due_at: string | null;
  defer_until: string | null;
  sender: string;
  metadata: string;
  ephemeral: number;
  no_history: number;
  pinned: number;
  version: number;
  lease_expires_at: string | null;
  heartbeat_at: string | null;
  claimed_by: string;
  fencing: number;
  extra: string;
}

export const all = <T extends Record<string, SqlStorageValue>>(sql: SqlStorage, query: string, ...bindings: unknown[]) =>
  sql.exec<T>(query, ...(bindings as SqlStorageValue[])).toArray();

export const one = <T extends Record<string, SqlStorageValue>>(sql: SqlStorage, query: string, ...bindings: unknown[]) =>
  all<T>(sql, query, ...bindings)[0];

export const loadIssue = (sql: SqlStorage, tracker: string, id: string) =>
  one<IssueRow>(sql, "SELECT * FROM issues WHERE tracker = ?1 AND id = ?2", tracker, id);

export const labelsOf = (sql: SqlStorage, tracker: string, id: string) =>
  all<{ label: string }>(sql, "SELECT label FROM labels WHERE tracker = ?1 AND issue_id = ?2 ORDER BY label", tracker, id).map(
    (r) => r.label,
  );

export interface EdgeRow {
  issue_id: string;
  depends_on_id: string;
  type: string;
  created_at: string;
  created_by: string;
  metadata: string;
}

/** Wire form of a stored edge record. The surrogate `id` and `thread_id` are never stored, so never emitted. */
export const edgeJson = (e: EdgeRow): Dependency => ({
  issue_id: e.issue_id,
  depends_on_id: e.depends_on_id,
  type: e.type,
  created_at: e.created_at,
  ...(e.created_by ? { created_by: e.created_by } : {}),
  metadata: e.metadata,
});

export function edgesOf(sql: SqlStorage, tracker: string, id: string): Dependency[] {
  return all<EdgeRow & Record<string, SqlStorageValue>>(
    sql,
    "SELECT issue_id, depends_on_id, type, created_at, created_by, metadata FROM dependencies WHERE tracker = ?1 AND issue_id = ?2 ORDER BY depends_on_id",
    tracker,
    id,
  ).map(edgeJson);
}

export const parentOf = (sql: SqlStorage, tracker: string, id: string) =>
  one<{ target: string | null }>(
    sql,
    "SELECT MIN(depends_on_id) AS target FROM dependencies WHERE tracker = ?1 AND issue_id = ?2 AND type = 'parent-child'",
    tracker,
    id,
  )?.target ?? undefined;

/** Wire form of a row: absent members are omitted, booleans appear only as true. */
export function issueJson(row: IssueRow, labels: string[] = [], extra: { brief?: boolean; isBlocked?: boolean } = {}): Issue {
  // Core members this server stores without querying them (see the `extra` column): emitted verbatim,
  // and never over a member computed below.
  const out: Issue = { ...(safeObject(row.extra) as Issue), id: row.id, title: row.title, priority: row.priority, created_at: row.created_at, updated_at: row.updated_at, status: row.status };
  const text = (key: "description" | "design" | "acceptance_criteria" | "notes") => {
    if (row[key] && !extra.brief) out[key] = row[key];
  };
  text("description");
  text("design");
  text("acceptance_criteria");
  text("notes");
  if (row.issue_type) out.issue_type = row.issue_type;
  if (row.assignee) out.assignee = row.assignee;
  if (row.owner) out.owner = row.owner;
  if (row.estimated_minutes !== null) out.estimated_minutes = row.estimated_minutes;
  if (row.created_by) out.created_by = row.created_by;
  if (row.started_at) out.started_at = row.started_at;
  if (row.closed_at) out.closed_at = row.closed_at;
  if (row.close_reason) out.close_reason = row.close_reason;
  if (row.closed_by_session) out.closed_by_session = row.closed_by_session;
  // The lease of a live claim is the core member `lease_expires_at`, with its core meaning.
  if (row.status === "in_progress" && row.lease_expires_at) out.lease_expires_at = row.lease_expires_at;
  // When the holder last proved it is alive. Carried on a live claim only, next to the lease.
  if (row.status === "in_progress" && row.heartbeat_at) out.heartbeat_at = row.heartbeat_at;
  // In progress without a live lease is "unleased" (a status set by hand) or "expired" (a lapsed lease the next
  // request releases); neither holds the issue, both can be claimed by anyone.
  const inProgress = row.status === "in_progress";
  const expired = inProgress && row.lease_expires_at !== null && row.lease_expires_at <= new Date().toISOString();
  out.x_claim = {
    state: !inProgress ? "none" : row.lease_expires_at === null ? "unleased" : expired ? "expired" : "live",
    verified_principal: row.claimed_by || null,
    assignee: row.assignee,
    lease_expires_at: row.lease_expires_at,
    heartbeat_at: row.heartbeat_at,
    fencing_token: row.fencing,
    reclaimable: inProgress && (row.lease_expires_at === null || expired),
  };
  if (row.due_at) out.due_at = row.due_at;
  if (row.defer_until) out.defer_until = row.defer_until;
  if (row.external_ref) out.external_ref = row.external_ref;
  const metadata = safeObject(row.metadata);
  if (Object.keys(metadata).length > 0) out.metadata = metadata;
  if (labels.length > 0) out.labels = labels;
  if (row.sender) out.sender = row.sender;
  if (row.ephemeral) out.ephemeral = true;
  if (row.no_history) out.no_history = true;
  if (row.pinned) out.pinned = true;
  if (extra.isBlocked !== undefined) out.is_blocked = extra.isBlocked;
  return out;
}

export const chunks = <T>(items: readonly T[], size = 90): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

/**
 * Issues plus the counts, labels and edge records a listing carries, for a whole page at once: one
 * grouped read per kind instead of five per row. Durable Object SQLite binds at most 100 values to a
 * statement, so ids go in chunks.
 */
export function issuesWithCounts(
  sql: SqlStorage,
  tracker: string,
  rows: IssueRow[],
  o: { brief?: boolean; blocked?: Set<string> } = {},
): IssueWithCounts[] {
  const labels = new Map<string, string[]>();
  const edges = new Map<string, Dependency[]>();
  const comments = new Map<string, number>();
  const blocksOut = new Map<string, number>();
  const blocksIn = new Map<string, number>();
  for (const part of chunks(rows.map((r) => r.id))) {
    const marks = part.map((_, i) => `?${i + 2}`).join(",");
    for (const l of all<{ issue_id: string; label: string }>(
      sql, `SELECT issue_id, label FROM labels WHERE tracker = ?1 AND issue_id IN (${marks}) ORDER BY issue_id, label`, tracker, ...part)) {
      (labels.get(l.issue_id) ?? labels.set(l.issue_id, []).get(l.issue_id)!).push(l.label);
    }
    for (const e of all<{ issue_id: string; depends_on_id: string; type: string; created_at: string; created_by: string; metadata: string }>(
      sql,
      `SELECT issue_id, depends_on_id, type, created_at, created_by, metadata FROM dependencies
       WHERE tracker = ?1 AND issue_id IN (${marks}) ORDER BY issue_id, depends_on_id`,
      tracker, ...part)) {
      (edges.get(e.issue_id) ?? edges.set(e.issue_id, []).get(e.issue_id)!).push(edgeJson(e));
      if (e.type === "blocks") blocksOut.set(e.issue_id, (blocksOut.get(e.issue_id) ?? 0) + 1);
    }
    for (const e of all<{ depends_on_id: string; n: number }>(
      sql,
      `SELECT depends_on_id, COUNT(*) AS n FROM dependencies WHERE tracker = ?1 AND type = 'blocks' AND depends_on_id IN (${marks}) GROUP BY depends_on_id`,
      tracker, ...part)) blocksIn.set(e.depends_on_id, e.n);
    for (const c of all<{ issue_id: string; n: number }>(
      sql, `SELECT issue_id, COUNT(*) AS n FROM comments WHERE tracker = ?1 AND issue_id IN (${marks}) GROUP BY issue_id`, tracker, ...part)) {
      comments.set(c.issue_id, c.n);
    }
  }
  return rows.map((row) => {
    const dependencies = edges.get(row.id) ?? [];
    const parent = dependencies.filter((d) => d.type === "parent-child").map((d) => d.depends_on_id).sort()[0];
    return {
      ...issueJson(row, labels.get(row.id) ?? [], { brief: o.brief, isBlocked: o.blocked ? o.blocked.has(row.id) : undefined }),
      ...(dependencies.length > 0 ? { dependencies } : {}),
      dependency_count: blocksOut.get(row.id) ?? 0,
      dependent_count: blocksIn.get(row.id) ?? 0,
      comment_count: comments.get(row.id) ?? 0,
      ...(parent ? { parent } : {}),
    };
  });
}

export const issueWithCounts = (sql: SqlStorage, row: IssueRow, brief = false): IssueWithCounts =>
  issuesWithCounts(sql, row.tracker, [row], { brief })[0]!;

/** Issue with its edge records, labels and no comments: what mutations answer with. */
export function hydratedIssue(sql: SqlStorage, tracker: string, id: string, withDependencies = true): Issue {
  const row = loadIssue(sql, tracker, id);
  if (!row) throw new Error(`issue ${id} vanished inside its own transaction`);
  const dependencies = withDependencies ? edgesOf(sql, tracker, id) : [];
  return { ...issueJson(row, labelsOf(sql, tracker, id)), ...(dependencies.length > 0 ? { dependencies } : {}) };
}
