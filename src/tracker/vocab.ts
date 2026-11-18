// The status and type vocabularies of one tracker: the built-ins plus what the workspace configured.
//
// Upstream validates a status or an issue type against the built-ins plus the workspace's own
// `status.custom` / `types.custom` (internal/types/types.go:530-548 and :753-778). A type such as
// `agent` or `merge-request` is NOT a built-in there: it is valid only when `types.custom` names it.
import { all } from "./model";
import { KEY_TYPES_INFRA, DEFAULT_INFRA_TYPES } from "./config";

export const BUILTIN_STATUSES = ["open", "in_progress", "blocked", "deferred", "closed", "pinned", "hooked"] as const;
// Built-in issue types plus `event`, which upstream accepts on write (types.go:726-731, :761-763).
export const BUILTIN_TYPES = [
  "bug", "feature", "task", "epic", "chore", "decision", "message", "molecule", "gate", "spike", "story", "milestone", "event",
] as const;

export interface Vocab {
  customStatuses: { name: string; category: string }[];
  customTypes: string[];
  infraTypes: string[];
}

export function loadVocab(sql: SqlStorage, tracker: string): Vocab {
  const customStatuses = all<{ name: string; category: string }>(
    sql,
    "SELECT name, category FROM custom_statuses WHERE tracker = ?1 ORDER BY name",
    tracker,
  );
  const customTypes = all<{ name: string }>(sql, "SELECT name FROM custom_types WHERE tracker = ?1 ORDER BY position", tracker).map((r) => r.name);
  const configured = all<{ value: string }>(sql, "SELECT value FROM config WHERE tracker = ?1 AND key = ?2", tracker, KEY_TYPES_INFRA)[0]?.value.trim() ?? "";
  const names = configured.split(",").map((n) => n.trim()).filter((n) => n !== "");
  return { customStatuses, customTypes, infraTypes: names.length > 0 ? names : [...DEFAULT_INFRA_TYPES] };
}

export const statusNames = (v: Vocab): string[] => [...BUILTIN_STATUSES, ...v.customStatuses.map((s) => s.name)];
export const typeNames = (v: Vocab): string[] => [...BUILTIN_TYPES, ...v.customTypes];
export const isStatus = (v: Vocab, status: string) => statusNames(v).includes(status);
export const isType = (v: Vocab, type: string) => typeNames(v).includes(type);

/** Statuses a default listing hides: closed, pinned and every custom status of category done or frozen. */
export const hiddenStatuses = (v: Vocab): string[] => [
  "closed",
  "pinned",
  ...v.customStatuses.filter((s) => s.category === "done" || s.category === "frozen").map((s) => s.name),
];

/** Custom statuses of category active also qualify for ready work (sqlbuild/ready.go:96-114). */
export const activeCustomStatuses = (v: Vocab): string[] => v.customStatuses.filter((s) => s.category === "active").map((s) => s.name);
