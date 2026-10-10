// One monotonic fence for every admitted tracker write, including configuration and memories.
import { one } from "./model";
import { refuse } from "./problem";

const revisionKey = (tracker: string) => `mutation_revision/${tracker}`;

export function trackerRevision(sql: SqlStorage, tracker: string): number {
  const value = one<{ value: string }>(sql, "SELECT value FROM meta WHERE key = ?", revisionKey(tracker))?.value ?? "0";
  const revision = Number(value);
  if (!/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(revision)) throw refuse("internal", "tracker revision is invalid");
  return revision;
}

/** Called after dispatch in the same transaction; failures and receipt replays do not advance it. */
export function advanceTrackerRevision(sql: SqlStorage, tracker: string): number {
  const revision = trackerRevision(sql, tracker) + 1;
  if (!Number.isSafeInteger(revision)) throw refuse("internal", "tracker revision is exhausted");
  sql.exec("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", revisionKey(tracker), String(revision));
  return revision;
}
