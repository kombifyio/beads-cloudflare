export type SnapshotRequest = (tracker: string, suffix: string) => Promise<any>;
export interface SnapshotPayload {
  format: string;
  captured_at: string;
  source: { origin: string; tracker: string; store_version: string; source_sha: string | null; mutation_revision: number };
  state: { project_id: string; issues: unknown[]; dependencies: unknown[]; memories: unknown[]; settings: unknown[]; vocabulary: { statuses: unknown[]; types: unknown[] } };
  journal: { head: number; records: unknown[] };
  exclusions: string[];
}
export interface ArchiveEnvelope {
  payload: {
    format: string;
    section?: string;
    source?: { mutation_revision: number; source_sha: string | null };
    [key: string]: unknown;
  };
  integrity: { algorithm: string; digest: string };
}
export interface ArchiveObject {
  role: "archive" | "part" | "manifest";
  name: string;
  body: string;
  envelope: ArchiveEnvelope;
}
export interface ArchiveResult {
  format: string;
  digest: string;
  bytes: number;
  parts: number;
  mutation_revision: number;
  peakResident: number;
  journalHead: number;
  accounted: number;
}
export const SNAPSHOT_FORMAT: string;
export const SNAPSHOT_FORMAT_V2: string;
export const SNAPSHOT_PART_FORMAT: string;
export const SNAPSHOT_MAX_BYTES: number;
export const SNAPSHOT_PART_BYTES: number;
export const SNAPSHOT_RESIDENT_BYTES: number;
export const SNAPSHOT_EXCLUSIONS: string[];
export function canonical(value: unknown): string;
export function cleanIssue(issue: Record<string, unknown>): Record<string, unknown>;
export function snapshotPartName(index: number): string;
export function assembleState(projectId: string, parts: { section?: string; records?: unknown[]; vocabulary?: { statuses: unknown[]; types: unknown[] } }[]): SnapshotPayload["state"];
export function captureSnapshot(request: SnapshotRequest, tracker: string, options?: { byteLength: (text: string) => number; eventLimit?: number; journal?: "full" | "head" }): Promise<{ context: any; state: SnapshotPayload["state"]; journal: SnapshotPayload["journal"] }>;
export function snapshotPayload(request: SnapshotRequest, tracker: string, options: { origin: string; byteLength: (text: string) => number; eventLimit?: number; now?: () => Date }): Promise<SnapshotPayload>;
export function archiveSnapshot(request: SnapshotRequest, tracker: string, options: {
  origin: string;
  byteLength: (text: string) => number;
  eventLimit?: number;
  now?: () => Date;
  sha256: (text: string) => Promise<string>;
  residentBytes?: number;
  partBytes?: number;
  emit: (item: ArchiveObject) => Promise<void>;
  abort?: (names: string[]) => Promise<void>;
}): Promise<ArchiveResult>;
export function readStateParts(request: SnapshotRequest, tracker: string, options: { byteLength: (text: string) => number; sha256: (text: string) => Promise<string>; eventLimit?: number; partBytes: number }): Promise<{ context: any; parts: { section: string; count: number; recordsDigest: string }[] }>;
export function classifySnapshotKey(key: string): { tracker: string; id: string; role: "manifest" | "part" | "ignore"; key: string; name?: string } | null;
export function expiredSnapshotKeys(objects: { key: string; uploaded: number }[], cutoffMs: number): string[];
