// `x_extra`: the core `Issue` members the upstream write operations have no member for.
//
// The /v0 contract lets a client READ `spec_id`, `wisp_type`, `mol_type`, `is_template`, the event and gate
// members and `pinned`, but its create and patch bodies carry none of them (`CreateIssueRequest`,
// `ApplyCreateItem`, `IssuePatchBody`). A client that mirrors a store through those operations would drop them
// silently, so this profile accepts them under one extension member, `x_extra`, an object whose members keep
// their core names and types. Anything else inside it is refused by name, as everywhere else.
//
// The members land where an import puts them: all but `pinned` in the `extra` column (emitted verbatim by every
// read), `pinned` in its own column.
import { checkMembers } from "./body";
import { invalid } from "./problem";
import { isObject, type Json } from "./util";

export const X_EXTRA = "x_extra";

const STRING_MEMBERS = [
  "spec_id", "source_system", "compacted_at_commit", "wisp_type", "storage_class", "await_type", "await_id", "source_formula",
  "source_location", "mol_type", "work_type", "event_kind", "actor", "target", "payload",
];
const INTEGER_MEMBERS = ["compaction_level", "original_size", "timeout"];
const BOOLEAN_MEMBERS = ["is_template", "pinned"];
const OTHER_MEMBERS = ["compacted_at", "waiters", "bonded_from"];
export const X_EXTRA_MEMBERS = [...STRING_MEMBERS, ...INTEGER_MEMBERS, ...BOOLEAN_MEMBERS, ...OTHER_MEMBERS];

const RFC3339 = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

export interface ExtraEdit {
  /** Members to write into the `extra` column. */
  set: Json;
  /** Members to remove from it (a patch, with an explicit `null`). */
  unset: string[];
  /** The `pinned` column, when named. */
  pinned?: boolean;
}

/** Validates an `x_extra` value. On create no member is nullable; in a patch `null` removes the member. */
export function parseExtra(raw: unknown, param: string, patch: boolean): ExtraEdit {
  if (!isObject(raw)) throw invalid(param, `\`${X_EXTRA}\` must be a JSON object`);
  checkMembers(raw, X_EXTRA_MEMBERS, `\`${X_EXTRA}\``, `${param}.`);
  const out: ExtraEdit = { set: {}, unset: [] };
  for (const [name, value] of Object.entries(raw)) {
    const at = `${param}.${name}`;
    if (value === null) {
      if (!patch) throw invalid(at, `\`${name}\` is not nullable on create; omit it`);
      if (name === "pinned") out.pinned = false;
      else out.unset.push(name);
      continue;
    }
    if (STRING_MEMBERS.includes(name)) {
      if (typeof value !== "string") throw invalid(at, `\`${name}\` must be a string`);
    } else if (INTEGER_MEMBERS.includes(name)) {
      if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw invalid(at, `\`${name}\` must be a non-negative integer`);
    } else if (BOOLEAN_MEMBERS.includes(name)) {
      if (typeof value !== "boolean") throw invalid(at, `\`${name}\` must be a boolean`);
    } else if (name === "compacted_at") {
      if (typeof value !== "string" || !RFC3339.test(value) || Number.isNaN(Date.parse(value))) throw invalid(at, "`compacted_at` must be an RFC 3339 timestamp");
    } else if (name === "waiters") {
      if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) throw invalid(at, "`waiters` must be an array of strings");
    } else if (name === "bonded_from") {
      if (!Array.isArray(value)) throw invalid(at, "`bonded_from` must be an array of {source_id, bond_type, bond_point?}");
      value.forEach((b, i) => {
        if (!isObject(b)) throw invalid(`${at}[${i}]`, "a bond must be an object");
        checkMembers(b, ["source_id", "bond_type", "bond_point"], `${at}[${i}]`, `${at}[${i}].`);
        if (typeof b.source_id !== "string" || typeof b.bond_type !== "string" || (b.bond_point !== undefined && typeof b.bond_point !== "string")) {
          throw invalid(`${at}[${i}]`, "`source_id` and `bond_type` are required strings, `bond_point` an optional one");
        }
      });
    }
    if (name === "pinned") out.pinned = value as boolean;
    else out.set[name] = name === "compacted_at" ? new Date(value as string).toISOString() : value;
  }
  return out;
}
