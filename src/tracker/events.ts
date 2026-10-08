// The append-only events journal. Every mutation appends its rows inside the same transaction.
import type { components } from "../generated/openapi.v0";
import { all, hydratedIssue, loadIssue, one } from "./model";
import { invalid } from "./problem";
import type { Out } from "./problem";
import { isObject, safeJson, type Json } from "./util";

type EventsPage = components["schemas"]["EventsPage"];

/** What a mutation runs under: the verified principal is the only actor that is ever recorded. */
export interface Ctx {
  sql: SqlStorage;
  tracker: string;
  /** Verified principal (email). */
  actor: string;
  /** The actor the caller asserted, kept for provenance only. */
  clientActor?: string;
  /** The agent or session name from the X-Beads-Agent header: provenance only, never the principal. */
  agent?: string;
  /** A merge import by a caller holding beads:import: provenance (authors, creators, timestamps, leases) is kept as given. */
  preserveProvenance?: boolean;
  now: string;
}

export interface EventInput {
  op: "create" | "update" | "close" | "delete" | "dep_add" | "dep_remove" | "comment";
  /** The upstream audit event type: created, claimed, unclaimed, closed, reopened, ... */
  kind: string;
  issueId: string;
  /** The event carries a snapshot of the issue after the mutation unless this is false (delete). */
  withIssue?: boolean;
  dep?: { kind: string; target: string; metadata: string };
  comment?: { id: string; author: string; text: string; created_at: string; source: string };
}

export function recordEvent(ctx: Ctx, e: EventInput): void {
  const issue = e.withIssue !== false && loadIssue(ctx.sql, ctx.tracker, e.issueId) ? JSON.stringify(hydratedIssue(ctx.sql, ctx.tracker, e.issueId)) : null;
  ctx.sql.exec(
    "INSERT INTO events (tracker, ts, op, kind, issue_id, actor, client_actor, issue, dep, comment) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ctx.tracker,
    ctx.now,
    e.op,
    e.kind,
    e.issueId,
    ctx.actor,
    ctx.agent ?? ctx.clientActor ?? null,
    issue,
    e.dep ? JSON.stringify(e.dep) : null,
    e.comment ? JSON.stringify(e.comment) : null,
  );
}

interface EventRow {
  [column: string]: SqlStorageValue;
  seq: number;
  ts: string;
  op: string;
  kind: string;
  issue_id: string;
  actor: string;
  client_actor: string | null;
  issue: string | null;
  dep: string | null;
  comment: string | null;
}

export function listEvents(sql: SqlStorage, tracker: string, since: number | undefined, limit: number | undefined): Out {
  if (since === undefined || since < 0) {
    throw invalid("since", "since is required and must be zero or a positive sequence number; use 0 to read from the beginning");
  }
  const max = limit ?? 1000;
  if (!Number.isInteger(max) || max < 1 || max > 10000) {
    throw invalid("limit", "limit must be between 1 and 10000 (default 1000); this operation has no unlimited read");
  }
  const rows = all<EventRow>(sql, "SELECT * FROM events WHERE tracker = ?1 AND seq > ?2 ORDER BY seq LIMIT ?3", tracker, since, max);
  const head = one<{ head: number | null }>(sql, "SELECT MAX(seq) AS head FROM events WHERE tracker = ?1", tracker)?.head ?? 0;
  // The generated dep/comment/issue member types are empty object types; the real shapes are built here.
  const records = rows.map((r) => ({
    seq: r.seq,
    ts: r.ts,
    op: r.op,
    issue_id: r.issue_id,
    actor: r.actor,
    // `issue` is always present on the wire: the snapshot after the mutation, or null.
    issue: r.issue ? (safeJson(r.issue, null) as Json | null) : null,
    ...(r.dep && isObject(safeJson(r.dep, null)) ? { dep: safeJson(r.dep, null) as Json } : {}),
    ...(r.comment && isObject(safeJson(r.comment, null)) ? { comment: safeJson(r.comment, null) as Json } : {}),
    x_event_type: r.kind,
    ...(r.client_actor ? { x_client_actor: r.client_actor } : {}),
  }));
  return { status: 200, body: { head, records } as unknown as EventsPage };
}
