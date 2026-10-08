// Claim, release, close, reopen and claimNext, following upstream Beads v1.3.1 plus the declared
// lease/fencing extension (see docs/profile.md and docs/semantics.md).
import { boundedText, checkMembers, nameMember, optBool, optInt } from "./body";
import { claimHolder, guardClaim, leaseExpired, staleClaim } from "./claims";
import { recordEvent, type Ctx } from "./events";
import { all, hydratedIssue, issueJson, issueWithCounts, loadIssue, type IssueRow } from "./model";
import { invalid, issueNotFound, refuse } from "./problem";
import type { Out } from "./problem";
import { hasLiveBlocker, readyCandidates, unblocked, type ReadyFilter } from "./ready";
import { etagOf, idIsAddressable, openChildren, parseVersionToken } from "./issues";
import type { Json } from "./util";

export const DEFAULT_LEASE_SECONDS = 30 * 60;
const MAX_LEASE_SECONDS = 24 * 3600;

function leaseSeconds(body: Json): number {
  const seconds = optInt(body, "x_lease_seconds");
  if (seconds === undefined) return DEFAULT_LEASE_SECONDS;
  if (seconds < 1 || seconds > MAX_LEASE_SECONDS) throw invalid("x_lease_seconds", `\`x_lease_seconds\` must be between 1 and ${MAX_LEASE_SECONDS}`);
  return seconds;
}

function fencingToken(body: Json): number | undefined {
  return optInt(body, "x_fencing_token");
}

const requireRow = (ctx: Ctx, id: string): IssueRow => {
  if (!idIsAddressable(id)) throw issueNotFound();
  const row = loadIssue(ctx.sql, ctx.tracker, id);
  if (!row) throw issueNotFound();
  return row;
};

function checkVersion(row: IssueRow, expected: string | undefined): void {
  if (expected !== undefined && expected !== String(row.version)) {
    throw refuse(
      "precondition_failed",
      "a precondition guard did not match; nothing was written, so re-read the row and recompose the request rather than retrying it",
      { param: "expected_version", reason: "version_conflict", expected_version: expected },
    );
  }
}

/**
 * The name a claim is recorded under.
 *
 * An assignee is work allocation, not an identity claim: `bd` chooses it freely,
 * so a caller that asks to claim as "worker" gets an issue assigned to "worker".
 * The verified principal stays ctx.actor and is what the event journal records,
 * so the audit trail still names who actually performed the write. Collapsing
 * the two made every claim land on the credential's own identity and left the
 * asserted name as decoration.
 */
function claimAssignee(ctx: Ctx): string {
  return ctx.clientActor ?? ctx.actor;
}

function takeClaim(ctx: Ctx, row: IssueRow, seconds: number): IssueRow {
  const expires = new Date(Date.parse(ctx.now) + seconds * 1000).toISOString();
  ctx.sql.exec(
    `UPDATE issues SET assignee = ?3, status = 'in_progress', started_at = COALESCE(started_at, ?4), updated_at = ?4,
       version = version + 1, lease_expires_at = ?5, heartbeat_at = ?4, claimed_by = ?6, fencing = fencing + 1
     WHERE tracker = ?1 AND id = ?2`,
    ctx.tracker, row.id, claimAssignee(ctx), ctx.now, expires, ctx.actor,
  );
  recordEvent(ctx, { op: "update", kind: "claimed", issueId: row.id });
  return loadIssue(ctx.sql, ctx.tracker, row.id)!;
}

// ---------------------------------------------------------------------------------------------

export function claimIssue(ctx: Ctx, id: string, body: Json): Out {
  checkMembers(body, ["actor", "x_lease_seconds"]);
  ctx.clientActor = nameMember(body, "actor");
  const seconds = leaseSeconds(body);
  const row = requireRow(ctx, id);
  const expired = leaseExpired(row, ctx.now);

  // The holder asking again: nothing changes, but the lease is renewed (extension).
  if (row.status === "in_progress" && !expired && row.assignee === claimAssignee(ctx)) {
    guardClaim(ctx, row);
    if (row.lease_expires_at) {
      const expires = new Date(Date.parse(ctx.now) + seconds * 1000).toISOString();
      ctx.sql.exec(
        "UPDATE issues SET lease_expires_at = ?3, updated_at = ?4, version = version + 1 WHERE tracker = ?1 AND id = ?2",
        ctx.tracker, id, expires, ctx.now,
      );
      recordEvent(ctx, { op: "update", kind: "lease_renewed", issueId: id });
    }
    const same = loadIssue(ctx.sql, ctx.tracker, id)!;
    return { status: 200, body: { issue: issueJson(same), already_claimed: true, x_fencing_token: same.fencing }, etag: etagOf(same.version) };
  }
  if (row.assignee !== "" && row.assignee !== claimAssignee(ctx) && !expired) {
    throw refuse("already_claimed", "issue is claimed by another actor", { assignee: row.assignee, issue_status: row.status });
  }
  if (row.status !== "open" && !expired) {
    throw refuse("not_claimable", "issue is not in a claimable state", { issue_status: row.status });
  }
  const claimed = takeClaim(ctx, row, seconds);
  return { status: 200, body: { issue: issueJson(claimed), already_claimed: false, x_fencing_token: claimed.fencing }, etag: etagOf(claimed.version) };
}

// ---------------------------------------------------------------------------------------------

/**
 * Renews the holder's lease without taking a new claim.
 *
 * This is what a long-running agent calls to say it is still alive. It pushes
 * lease_expires_at out by the requested TTL and stamps heartbeat_at; it never
 * changes the assignee or the fencing number, so a renewal cannot invalidate
 * another holder's token.
 *
 * Only the principal holding the live claim may renew it. An ephemeral wisp is
 * never leased, so heartbeating one is `not_claimable` rather than a silent
 * success.
 */
export function heartbeatIssue(ctx: Ctx, id: string, body: Json): Out {
  checkMembers(body, ["actor", "x_lease_seconds"]);
  ctx.clientActor = nameMember(body, "actor");
  const seconds = leaseSeconds(body);
  const row = requireRow(ctx, id);
  if (row.ephemeral) throw refuse("not_claimable", "a wisp is ephemeral and is never leased, so it has no lease to renew");
  if (row.status !== "in_progress" || row.lease_expires_at === null) {
    throw refuse("not_claimable", "this issue is not in progress under a lease", { issue_status: row.status });
  }
  if (claimHolder(row) !== ctx.actor) {
    throw refuse("already_claimed", "this issue is claimed by another principal whose lease is still live", {
      reason: "claimed_by_other",
      assignee: row.assignee,
      x_claimed_by: claimHolder(row),
      issue_status: row.status,
    });
  }
  const expires = new Date(Date.parse(ctx.now) + seconds * 1000).toISOString();
  ctx.sql.exec(
    `UPDATE issues SET lease_expires_at = ?3, heartbeat_at = ?4, updated_at = ?4, version = version + 1
     WHERE tracker = ?1 AND id = ?2`,
    ctx.tracker, id, expires, ctx.now,
  );
  recordEvent(ctx, { op: "update", kind: "lease_renewed", issueId: id });
  const after = loadIssue(ctx.sql, ctx.tracker, id)!;
  return { status: 200, body: { issue: issueJson(after), lease_expires_at: after.lease_expires_at }, etag: etagOf(after.version) };
}

export interface ReclaimFilter {
  /** Only leases that expired more than this long ago. Zero means "any expired lease". */
  olderThanSeconds?: number;
  assignee?: string;
  /** Only these issue ids are eligible. */
  ids?: string[];
  /** AND set: the issue must carry all of these labels. */
  label?: string[];
  /** OR set: the issue must carry at least one of these labels. */
  labelAny?: string[];
  /** The issue must carry none of these labels. */
  excludeLabel?: string[];
  limit?: number;
}

/**
 * Reverts expired claims to open and unassigned, reporting the previous holder.
 *
 * A lease is advisory: once it expires anyone may take the work, and this is the
 * sweep that does it in bulk for the callers that do not poll. It only ever
 * touches rows whose lease is already in the past, so a live claim is never
 * stolen, and it reports each row's previous owner so a caller can tell an
 * agent that lost its work from one that never had any.
 */
export function reclaimExpiredLeases(ctx: Ctx, filter: ReclaimFilter, body: Json): Out {
  checkMembers(body, ["actor", "x_lease_seconds"]);
  ctx.clientActor = nameMember(body, "actor");
  // A negative age moves the cutoff into the future, so even a fresh lease counts.
  // That is how the caller asks for "reclaim everything" without waiting.
  const age = filter.olderThanSeconds ?? 0;
  const cutoff = new Date(Date.parse(ctx.now) - age * 1000).toISOString();
  const limit = filter.limit && filter.limit > 0 ? filter.limit : 0;
  const params: (string | number)[] = [ctx.tracker, cutoff];
  let sql = `SELECT * FROM issues WHERE tracker = ?1 AND status = 'in_progress'
       AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?2`;
  if (filter.assignee !== undefined && filter.assignee !== "") {
    sql += ` AND assignee = ?${params.length + 1}`;
    params.push(filter.assignee);
  }
  // The label filters narrow on the issue's own label set, AND-combine with each
  // other, and are applied here rather than in the caller so one sweep sees one
  // consistent snapshot of the tracker's labels.
  const labelsOf = (id: string): Set<string> =>
    new Set(all<{ label: string }>(ctx.sql, "SELECT label FROM labels WHERE tracker = ?1 AND issue_id = ?2", ctx.tracker, id).map((r) => r.label));
  const keep = (id: string): boolean => {
    const have = labelsOf(id);
    if (filter.label?.some((l) => !have.has(l))) return false;
    if (filter.labelAny?.length && !filter.labelAny.some((l) => have.has(l))) return false;
    if (filter.excludeLabel?.some((l) => have.has(l))) return false;
    return true;
  };
  const idFilter = filter.ids && filter.ids.length > 0 ? new Set(filter.ids) : undefined;
  sql += ` ORDER BY lease_expires_at ASC`;
  if (limit > 0) sql += ` LIMIT ${limit}`;

  const reclaimed: Json[] = [];
  for (const row of all<IssueRow>(ctx.sql, sql, ...params)) {
    if (idFilter && !idFilter.has(row.id)) continue;
    if (!keep(row.id)) continue;
    ctx.sql.exec(
      `UPDATE issues SET assignee = '', status = 'open', started_at = NULL, lease_expires_at = NULL,
         heartbeat_at = NULL, claimed_by = '', updated_at = ?3, version = version + 1, fencing = fencing + 1
       WHERE tracker = ?1 AND id = ?2`,
      ctx.tracker, row.id, ctx.now,
    );
    recordEvent(ctx, { op: "update", kind: "unclaimed", issueId: row.id });
    reclaimed.push({ id: row.id, previous_owner: row.assignee, previous_status: row.status });
  }
  return { status: 200, body: { reclaimed, count: reclaimed.length } };
}

// ---------------------------------------------------------------------------------------------

export function claimNext(ctx: Ctx, filter: ReadyFilter, body: Json): Out {  checkMembers(body, ["actor", "x_lease_seconds"]);
  ctx.clientActor = nameMember(body, "actor");
  const seconds = leaseSeconds(body);
  const [first] = unblocked(ctx.sql, ctx.tracker, readyCandidates(ctx.sql, ctx.tracker, filter, ctx.now, "claim"), 1);
  const candidate = first === undefined ? undefined : loadIssue(ctx.sql, ctx.tracker, first);
  // Nothing claimable is a 200 with no `claimed` member, not an error.
  if (!candidate) return { status: 200, body: {} };
  const claimed = takeClaim(ctx, candidate, seconds);
  return { status: 200, body: { claimed: issueWithCounts(ctx.sql, claimed), x_fencing_token: claimed.fencing }, etag: etagOf(claimed.version) };
}

// ---------------------------------------------------------------------------------------------

export function releaseIssue(ctx: Ctx, id: string, body: Json): Out {
  checkMembers(body, ["actor", "expected_assignee", "force", "x_fencing_token"]);
  ctx.clientActor = nameMember(body, "actor");
  let expected: string | undefined;
  if (body.expected_assignee !== undefined) {
    if (typeof body.expected_assignee !== "string") throw invalid("expected_assignee", "`expected_assignee` must be a string");
    if (body.expected_assignee.trim() === "") {
      throw invalid("expected_assignee", "`expected_assignee` is empty after trimming; omit it to release whatever claim is there, or read the row if you meant to assert that nobody holds it");
    }
    expected = body.expected_assignee;
  }
  const force = optBool(body, "force") ?? false;
  if (force && expected !== undefined) {
    throw invalid("force", "`force` and `expected_assignee` disagree about which claim to release; send one");
  }
  const token = fencingToken(body);

  const row = requireRow(ctx, id);
  const bump = guardClaim(ctx, row, { token, force });
  if (row.status !== "open" && row.status !== "in_progress") throw notReleasable();
  if (expected === undefined && row.assignee === "") throw notReleasable();
  if (expected !== undefined) {
    if (row.assignee !== expected) {
      throw refuse("precondition_failed", "a precondition guard did not match; nothing was written, so re-read the row and recompose the request rather than retrying it", {
        param: "expected_assignee",
        expected_assignee: expected,
      });
    }
  } else if (!force && claimHolder(row) !== ctx.actor) {
    throw refuse("already_claimed", "this issue is held by another actor; send `force`, or name the holder in `expected_assignee`");
  }

  ctx.sql.exec(
    `UPDATE issues SET assignee = '', status = 'open', started_at = NULL, lease_expires_at = NULL,
       heartbeat_at = NULL, claimed_by = '', updated_at = ?3, version = version + 1, fencing = fencing + ?4
     WHERE tracker = ?1 AND id = ?2`,
    ctx.tracker, id, ctx.now, bump,
  );
  recordEvent(ctx, { op: "update", kind: "unclaimed", issueId: id });
  const after = loadIssue(ctx.sql, ctx.tracker, id)!;
  return {
    status: 200,
    body: { issue: hydratedIssue(ctx.sql, ctx.tracker, id, false), changed: true, revision: String(after.version) },
    etag: etagOf(after.version),
  };
}

const notReleasable = () =>
  refuse(
    "not_releasable",
    "this issue holds no claim, or its status is neither `open` nor `in_progress`; nothing was written. Read the row rather than assuming the claim is gone",
  );

// ---------------------------------------------------------------------------------------------

function reasonMember(body: Json, name: string): string {
  const value = body[name];
  if (value === undefined) return "";
  if (typeof value !== "string") throw invalid(name, `\`${name}\` must be a string`);
  return boundedText(value, name);
}

export interface CloseInput {
  reason: string;
  session: string;
  force: boolean;
  expected?: string;
  token?: number;
}

/**
 * Close policy and the close itself, shared by `closeIssue`, `batchCloseIssues` and the close item of
 * `applyBatch`. Everything is checked before anything is written, so a refusal leaves no trace.
 */
export function closeRow(ctx: Ctx, row: IssueRow, input: CloseInput): { alreadyClosed: boolean; children: number } {
  const id = row.id;
  checkVersion(row, input.expected);
  const alreadyClosed = row.status === "closed";
  if (alreadyClosed && input.token !== undefined && input.token !== row.fencing) throw staleClaim(input.token, row.fencing);
  const bump = alreadyClosed ? 0 : guardClaim(ctx, row, { token: input.token });
  const children = openChildren(ctx.sql, ctx.tracker, id);
  if (!input.force) {
    if (children > 0) {
      throw refuse("not_closable", "issue has open children; close them first or close with force", { open_children: children });
    }
    if (!alreadyClosed && hasLiveBlocker(ctx.sql, ctx.tracker, id)) {
      throw refuse("not_closable", "issue is blocked; clear the blocker or close with force");
    }
  }
  if (!alreadyClosed) {
    ctx.sql.exec(
      `UPDATE issues SET status = 'closed', closed_at = ?3, updated_at = ?3, close_reason = ?4, closed_by_session = ?5,
         lease_expires_at = NULL, version = version + 1, fencing = fencing + ?6
       WHERE tracker = ?1 AND id = ?2`,
      ctx.tracker, id, ctx.now, input.reason, input.session, bump,
    );
    recordEvent(ctx, { op: "close", kind: "closed", issueId: id });
  }
  return { alreadyClosed, children };
}

export function closeIssue(ctx: Ctx, id: string, body: Json): Out {
  checkMembers(body, ["actor", "reason", "session", "force", "expected_version", "x_fencing_token"]);
  ctx.clientActor = nameMember(body, "actor");
  const reason = reasonMember(body, "reason");
  const session = reasonMember(body, "session");
  const force = optBool(body, "force") ?? false;
  const expected = parseVersionToken(body.expected_version, "expected_version");
  const token = fencingToken(body);

  const row = requireRow(ctx, id);
  const { alreadyClosed, children } = closeRow(ctx, row, { reason, session, force, expected, token });
  const after = loadIssue(ctx.sql, ctx.tracker, id)!;
  return {
    status: 200,
    body: { issue: hydratedIssue(ctx.sql, ctx.tracker, id), already_closed: alreadyClosed, open_children: force ? children : 0, revision: String(after.version) },
    etag: etagOf(after.version),
  };
}

export function reopenIssue(ctx: Ctx, id: string, body: Json): Out {
  checkMembers(body, ["actor", "reason", "expected_version"]);
  ctx.clientActor = nameMember(body, "actor");
  const reason = reasonMember(body, "reason");
  const expected = parseVersionToken(body.expected_version, "expected_version");

  const row = requireRow(ctx, id);
  checkVersion(row, expected);
  const wasClosed = row.status === "closed";
  if (wasClosed) {
    ctx.sql.exec(
      `UPDATE issues SET status = 'open', closed_at = NULL, close_reason = '', closed_by_session = '', defer_until = NULL,
         lease_expires_at = NULL, updated_at = ?3, version = version + 1
       WHERE tracker = ?1 AND id = ?2`,
      ctx.tracker, id, ctx.now,
    );
    recordEvent(ctx, { op: "update", kind: "reopened", issueId: id });
    if (reason !== "") {
      recordEvent(ctx, {
        op: "comment",
        kind: "commented",
        issueId: id,
        comment: { id: crypto.randomUUID(), author: ctx.actor, text: reason, created_at: ctx.now, source: "audit" },
      });
    }
  }
  const after = loadIssue(ctx.sql, ctx.tracker, id)!;
  return {
    status: 200,
    body: { issue: hydratedIssue(ctx.sql, ctx.tracker, id), already_open: !wasClosed, revision: String(after.version) },
    etag: etagOf(after.version),
  };
}
