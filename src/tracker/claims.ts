// The claim guard: who may change a claimed issue. See "Claims" in docs/profile.md.
import type { Ctx } from "./events";
import type { IssueRow } from "./model";
import { refuse } from "./problem";

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
 * This is the verified principal recorded when the claim was taken, never the
 * assignee. An assignee is the name work is allocated to and the caller picks
 * it, so matching on it would let any principal that knows a name act as the
 * holder. Rows claimed before the column existed fall back to the assignee,
 * which is what the guard compared against then.
 */
export const claimHolder = (row: IssueRow) => (row.claimed_by !== "" ? row.claimed_by : row.assignee);

export const leaseExpired = (row: IssueRow, now: string) =>
  row.status === "in_progress" && row.lease_expires_at !== null && row.lease_expires_at <= now;

export interface ClaimGuard {
  /** The fencing number the caller presented, if any. */
  token?: number;
  /** An explicit override of another principal's live claim (release `force`, `force_assignee_transfer`). */
  force?: boolean;
}

/**
 * Checks a claim-sensitive change (status, assignee, close, release) against the claim on the row and
 * returns how much to raise the fencing number: 1 when the change ends or takes over a claim whose
 * lease expired or is overridden, so the previous holder's number goes stale; otherwise 0.
 *
 * - A presented fencing number that is not the current one is refused as `stale_claim`.
 * - While another principal's lease is live the change is refused as `claimed_by_other`.
 * - Once the lease has expired anyone may act, as in upstream Beads where claims are advisory.
 */
export function guardClaim(ctx: Ctx, row: IssueRow, guard: ClaimGuard = {}): number {
  if (guard.token !== undefined && guard.token !== row.fencing) throw staleClaim(guard.token, row.fencing);
  if (!heldClaim(row)) return 0;
  if (leaseExpired(row, ctx.now)) return 1;
  if (claimHolder(row) === ctx.actor) return 0;
  if (!guard.force) {
    throw refuse("already_claimed", "this issue is claimed by another principal whose lease is still live", {
      reason: "claimed_by_other",
      assignee: row.assignee,
      // The holder is named separately: the assignee is the name work is allocated to,
      // which the caller chooses, so it does not identify who may act on the claim.
      x_claimed_by: claimHolder(row),
      issue_status: row.status,
    });
  }
  return 1;
}
