import type { StoreRead, WorkIssue, WorkOptions } from "./read";
import type { Repository } from "../dashboard/data";

type ClaimState = { live: boolean; thread: string | null; principal: string | null; until: string | null; at: string | null; train: boolean };
export function threadClaim(issue: WorkIssue, now: number): Omit<ClaimState, "at"> & { since: string | null };
export const WAITING_LABEL: RegExp;
export function claimState(issue?: WorkIssue, now?: number): ClaimState;
export function claimOwnedBy(issue: WorkIssue, worker: string | undefined, verifiedPrincipal: string | undefined, now?: number): boolean;
export function projectWork(stores: StoreRead[], catalog: Repository[], options?: WorkOptions): Record<string, unknown>;
