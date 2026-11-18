import { SCOPE_WRITE } from "../auth/scopes";
import { all } from "./model";

export const TERMINAL_BACKUP_REVISION_PREFIX = "terminal_backup_revision/";
export const isEphemeralBackupTracker = (tracker: string): boolean => /^(ci-conformance|restore-drill)-/.test(tracker);

/** A namespace alone is not admission: an ordinary one-day, single-tracker write key is required. */
export function terminalBackupTrackers(sql: SqlStorage, now: number): Set<string> {
  const candidates = new Map<string, { admitted: boolean; live: boolean }>();
  const rows = all<{ tracker: string; tracker_count: number; created_by: string; created_at: string; expires_at: string | null; revoked_at: string | null }>(sql,
    `SELECT t.value AS tracker, json_array_length(k.trackers) AS tracker_count, k.created_by, k.created_at, k.expires_at, k.revoked_at
     FROM api_keys k, json_each(k.trackers) t
     WHERE t.type = 'text' AND (t.value GLOB 'ci-conformance-*' OR t.value GLOB 'restore-drill-*')
       AND EXISTS (SELECT 1 FROM json_each(k.scopes) s WHERE s.value = ?)`, SCOPE_WRITE);
  for (const row of rows) {
    const entry = candidates.get(row.tracker) ?? { admitted: false, live: false };
    const created = Date.parse(row.created_at), expiry = row.expires_at === null ? NaN : Date.parse(row.expires_at);
    if (row.tracker_count === 1 && !row.created_by.startsWith("github-exchange:") && Number.isFinite(created) && Number.isFinite(expiry) && expiry > created && expiry - created <= 86_400_000) entry.admitted = true;
    const revoked = row.revoked_at !== null && Number.isFinite(Date.parse(row.revoked_at));
    if (!revoked && (!Number.isFinite(expiry) || expiry > now)) entry.live = true;
    candidates.set(row.tracker, entry);
  }
  const terminal = new Set<string>();
  for (const [tracker, state] of candidates) {
    if (!state.admitted || state.live) continue;
    const active = ["issues", "memories", "config", "custom_statuses", "custom_types"].some(table =>
      all<{ present: number }>(sql, `SELECT 1 AS present FROM ${table} WHERE tracker = ? LIMIT 1`, tracker).length > 0);
    if (!active) terminal.add(tracker);
  }
  return terminal;
}
