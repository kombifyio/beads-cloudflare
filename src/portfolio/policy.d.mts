import type { StoreRead, WorkIssue, WorkOptions } from "./read";
import type { Repository } from "../dashboard/data";

export function threadClaim(issue: WorkIssue, now: number): { live: boolean; thread: string | null; since: string | null; train: boolean };
export const WAITING_LABEL: RegExp;
export function claimState(comments?: WorkIssue["comments"], now?: number, hours?: number): { live: boolean; thread: string | null; at: string | null; train: boolean };
export function projectWork(stores: StoreRead[], catalog: Repository[], options?: WorkOptions): Record<string, unknown>;
