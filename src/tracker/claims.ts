// The claim guard: who may change a claimed issue. See "Claims" in docs/profile.md.
import { recordEvent, type Ctx } from "./events";
import { all, type IssueRow } from "./model";
import { refuse } from "./problem";
import { advanceTrackerRevision } from "./revision";

/** How long a claim lives when the caller names no `x_lease_seconds`. Holder writes and heartbeats push it out again. */
export const DEFAULT_LEASE_SECONDS = 2 * 3600;
export const MAX_LEASE_SECONDS = 24 * 3600;

/** The actor recorded for the events the store writes by itself (lapsed leases, the claims migration). */
export const EXPIRY_ACTOR = "system:lease-expiry";
export const MIGRATION_ACTOR = "system:claims-migration";

export function staleClaim(presented: number, current: number) {
  return refuse(
    "precondition_failed",
    "the claim this request acts on is no longer the current one: the lease expired and the issue was claimed again; re-read the row",
    { param: "x_fencing_token", reason: "stale_claim", x_fencing_token: presented, x_current_fencing_token: current },
  );
}

/** A claim is held while the issue is in progress with an assignee and a lease. */
const heldClaim = (row: IssueRow) => row.status === "in_progress" && row.assignee !== "" && row.lease_expires_at !== null;

/**
 * The principal the guard holds a claim to.
 *
 * This is the verified principal recorded when the claim was taken. Rows claimed before the column existed
 * fall back to the assignee, which is what the guard compared against then.
 */
export const claimHolder = (row: IssueRow) => (row.claimed_by !== "" ? row.claimed_by : row.assignee);

/**
 * The worker a request acts as: the name the caller asserts (`actor`, the native `--actor` or `BEADS_ACTOR`,
 * the MCP `worker_actor`), else the principal. It is an allocation name, not an identity: it can be chosen
 * freely, so it never replaces the verified principal. It does separate two sessions that share one
 * credential principal (every session of one GitHub user does), which is what lets a claim lock them apart.
 */
export const workerOf = (ctx: Ctx): string => ctx.clientActor ?? ctx.actor;

/**
 * No lease holds the row: it is in progress and its lease lapsed, or it never had one (a status set by hand,
 * or an assignment imported before leases existed). Such a row blocks nobody.
 */
export const leaseExpired = (row: IssueRow, now: string) =>
  row.status === "in_progress" && (row.lease_expires_at === null || row.lease_expires_at <= now);

/** A live claim: in progress, assigned, with an unexpired lease. */
export const liveClaim = (row: IssueRow, now: string) =>
  row.status === "in_progress" && row.assignee !== "" && row.lease_expires_at !== null && row.lease_expires_at > now;

/**
 * The claim is this caller's: the same worker name and the same verified principal. A row that records no principal
 * is either an assignment by name with no lease (the named worker's, whoever's credential it uses) or a lease from
 * before holders were recorded or restored by an import, which only the principal named as its assignee can act on.
 */
export const isHolder = (ctx: Ctx, row: IssueRow) => {
  if (row.claimed_by !== "") return row.claimed_by === ctx.actor && row.assignee === workerOf(ctx);
  return row.lease_expires_at === null ? row.assignee === workerOf(ctx) : row.assignee === ctx.actor;
};

/** The 409 that tells a caller who holds the row, until when and what to do about it. */
export function heldByOther(ctx: Ctx, row: IssueRow, via = "change") {
  const samePrincipal = claimHolder(row) === ctx.actor;
  const until = row.lease_expires_at ?? "an unknown time";
  const hint = samePrincipal
    ? `Your credential holds it as worker "${row.assignee}": act with that worker name (--actor or BEADS_ACTOR), or wait for the lease to lapse.`
    : "Wait for the lease to lapse or ask the holder to release it; a deliberate takeover is `release` with `force`.";
  return refuse("already_claimed", `this issue is claimed by "${row.assignee}" until ${until}, so you cannot ${via} it. ${hint}`, {
    reason: "claimed_by_other",
    assignee: row.assignee,
    // The holder is named separately: the assignee is the name work is allocated to, which the caller
    // chooses, so it does not by itself identify who may act on the claim.
    x_claimed_by: claimHolder(row),
    x_same_principal: samePrincipal,
    x_lease_expires_at: row.lease_expires_at,
    issue_status: row.status,
  });
}

export interface ClaimGuard {
  /** The fencing number the caller presented, if any. */
  token?: number;
  /** An explicit override of another worker's live claim (release `force`, `force_assignee_transfer`). */
  force?: boolean;
}

/**
 * Checks a claim-sensitive change (status, assignee, close, release) against the claim on the row and
 * returns how much to raise the fencing number: 1 when the change ends or takes over a claim whose
 * lease expired or is overridden, so the previous holder's number goes stale; otherwise 0.
 *
 * - A presented fencing number that is not the current one is refused as `stale_claim`.
 * - While another worker's lease is live the change is refused as `claimed_by_other`.
 * - Once the lease has expired anyone may act, as in upstream Beads where claims are advisory.
 */
export function guardClaim(ctx: Ctx, row: IssueRow, guard: ClaimGuard = {}, via?: string): number {
  if (guard.token !== undefined && guard.token !== row.fencing) throw staleClaim(guard.token, row.fencing);
  if (!heldClaim(row)) return 0;
  if (leaseExpired(row, ctx.now)) return 1;
  if (isHolder(ctx, row)) return 0;
  if (!guard.force) throw heldByOther(ctx, row, via);
  return 1;
}

/**
 * The holder's lease, pushed out by a write of the holder's own: a long piece of work that keeps writing to its
 * bead stays locked without anyone remembering to renew. It only ever extends, and only for the live holder.
 */
export function renewedLease(ctx: Ctx, row: IssueRow): { lease_expires_at: string; heartbeat_at: string } | undefined {
  if (!liveClaim(row, ctx.now) || !isHolder(ctx, row)) return undefined;
  const target = new Date(Date.parse(ctx.now) + DEFAULT_LEASE_SECONDS * 1000).toISOString();
  return { lease_expires_at: target > row.lease_expires_at! ? target : row.lease_expires_at!, heartbeat_at: ctx.now };
}

/**
 * Releases every claim of a tracker whose lease has lapsed: the row is open and unassigned again, the fencing
 * number is raised so the lapsed holder's token is stale, and a `lease_expired` event names the worker that held
 * it. Every read and write of a tracker runs this first, so no caller ever sees a claim that has already lapsed.
 */
export function releaseExpiredClaims(sql: SqlStorage, tracker: string, now: string): number {
  const due = all<IssueRow>(
    sql,
    "SELECT * FROM issues WHERE tracker = ?1 AND status = 'in_progress' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?2 ORDER BY lease_expires_at, id",
    tracker, now,
  );
  if (due.length === 0) return 0;
  const ctx: Ctx = { sql, tracker, actor: EXPIRY_ACTOR, now };
  for (const row of due) {
    sql.exec(
      `UPDATE issues SET assignee = '', status = 'open', started_at = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
         claimed_by = '', updated_at = ?3, version = version + 1, fencing = fencing + 1
       WHERE tracker = ?1 AND id = ?2`,
      tracker, row.id, now,
    );
    ctx.clientActor = row.assignee || undefined;
    recordEvent(ctx, { op: "update", kind: "lease_expired", issueId: row.id });
  }
  advanceTrackerRevision(sql, tracker);
  return due.length;
}

/** Whether a tracker holds a lapsed lease the next request has to release (an index read, no write). */
export const hasExpiredClaims = (sql: SqlStorage, tracker: string, now: string): boolean =>
  all(sql, "SELECT 1 FROM issues WHERE tracker = ?1 AND status = 'in_progress' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?2 LIMIT 1", tracker, now).length > 0;

export const CLAIMS_MIGRATED = "claims_migrated_v1";

export interface ClaimsMigration {
  at: string;
  trackers: Record<string, { released: number; by_status: Record<string, number> }>;
}

/**
 * One-time migration of locks that predate real claims: an assignee on a non-closed issue that no live lease
 * holds (a Dolt-era import, a hand-set assignee, a lease that lapsed long ago). Only the lock state is
 * released (assignee, lease, heartbeat, holder; the fencing number is raised); the issue's content and its
 * status are never touched, so a task the owner set in progress stays in progress. Closed rows keep their
 * assignee: there it is history, not a lock. Idempotent and recorded in `meta`.
 */
export function migrateLegacyClaims(sql: SqlStorage, now: string): ClaimsMigration | null {
  if (all(sql, "SELECT 1 FROM meta WHERE key = ?", CLAIMS_MIGRATED).length > 0) return null;
  const rows = all<IssueRow>(
    sql,
    `SELECT * FROM issues WHERE status NOT IN ('closed', 'pinned') AND assignee != ''
       AND (lease_expires_at IS NULL OR lease_expires_at <= ?1) ORDER BY tracker, id`,
    now,
  );
  // Maps, because tracker ids and custom status names are caller-chosen words such as "constructor".
  const perTracker = new Map<string, { released: number; by_status: Map<string, number> }>();
  for (const row of rows) {
    sql.exec(
      `UPDATE issues SET assignee = '', lease_expires_at = NULL, heartbeat_at = NULL, claimed_by = '', updated_at = ?3,
         version = version + 1, fencing = fencing + 1
       WHERE tracker = ?1 AND id = ?2`,
      row.tracker, row.id, now,
    );
    const ctx: Ctx = { sql, tracker: row.tracker, actor: MIGRATION_ACTOR, clientActor: row.assignee, now };
    recordEvent(ctx, { op: "update", kind: "claim_migrated", issueId: row.id });
    const entry = perTracker.get(row.tracker) ?? { released: 0, by_status: new Map<string, number>() };
    entry.released += 1;
    entry.by_status.set(row.status, (entry.by_status.get(row.status) ?? 0) + 1);
    perTracker.set(row.tracker, entry);
  }
  for (const tracker of perTracker.keys()) advanceTrackerRevision(sql, tracker);
  const report: ClaimsMigration = {
    at: now,
    trackers: Object.fromEntries([...perTracker].map(([tracker, e]) => [tracker, { released: e.released, by_status: Object.fromEntries(e.by_status) }])),
  };
  sql.exec("INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)", CLAIMS_MIGRATED, JSON.stringify(report));
  return report;
}
