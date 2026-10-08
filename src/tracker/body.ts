// Request-body validation shared by every write operation, with the refusals upstream produces.
import { invalid } from "./problem";
import { hasControlChar, isObject, runeLength, type Json } from "./util";

const MAX_FIELD = 255;

export function checkMembers(body: Json, allowed: readonly string[], scope = "this operation's request body", prefix = ""): void {
  const unknown = Object.keys(body)
    .filter((key) => !allowed.includes(key))
    .sort();
  if (unknown.length > 0) {
    throw invalid(
      prefix + unknown[0],
      `${scope} carries ${allowed.join(", ")} and nothing else`,
      "unknown_parameter",
    );
  }
}

/** Rejects explicit null on members that are not nullable. */
export function rejectNulls(body: Json, except: readonly string[] = [], leaveAs = "the workspace default", prefix = ""): void {
  for (const [key, value] of Object.entries(body)) {
    if (value === null && !except.includes(key)) {
      throw invalid(prefix + key, `\`${key}\` is not nullable; omit it to leave it at ${leaveAs}`);
    }
  }
}

/** Validates a caller-asserted name (actor, author); returns the trimmed value. */
export function nameMember(body: Json, name: string): string {
  const raw = body[name];
  if (raw === undefined) throw invalid(name, `\`${name}\` is required`);
  if (typeof raw !== "string") throw invalid(name, `\`${name}\` must be a string`);
  const value = raw.trim();
  if (value === "") throw invalid(name, `\`${name}\` is empty after trimming`);
  const bytes = new TextEncoder().encode(value).length;
  if (bytes > 256) throw invalid(name, `\`${name}\` is ${bytes} bytes; the limit is 256`);
  const chars = runeLength(value);
  if (chars > MAX_FIELD) throw invalid(name, `\`${name}\` is ${chars} characters; storage holds at most ${MAX_FIELD}`);
  if (hasControlChar(value)) throw invalid(name, `\`${name}\` must not contain control characters`);
  return value;
}

export function boundedText(value: string, param: string): string {
  const chars = runeLength(value);
  if (chars > MAX_FIELD) throw invalid(param, `\`${param}\` is ${chars} characters; storage holds at most ${MAX_FIELD}`);
  if (hasControlChar(value)) throw invalid(param, `\`${param}\` must not contain control characters`);
  return value;
}

/**
 * A title is bounded by its own column and validator, not by the 255-character bound its siblings share:
 * `VARCHAR(500)` (schema/migrations/0001_create_issues.up.sql:4) and `ValidateIssueTitle`, which
 * refuses an empty title and one over 500 BYTES (internal/types/types.go:338-348, enforced by
 * storage/domain/issue.go:571 and issueops/aggregate.go:81).
 */
export const MAX_TITLE_BYTES = 500;
export function boundedTitle(value: string, param: string): string {
  const bytes = new TextEncoder().encode(value).length;
  if (bytes > MAX_TITLE_BYTES) throw invalid(param, `\`${param}\` is ${bytes} bytes; the limit is ${MAX_TITLE_BYTES}`);
  if (hasControlChar(value)) throw invalid(param, `\`${param}\` must not contain control characters`);
  return value;
}

export const wrongType = (param: string, expected: string) => invalid(param, `\`${param}\` must be ${expected}`);

export function optString(body: Json, name: string, param = name, bounded = false): string | undefined {
  const value = body[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw wrongType(param, "a string");
  return bounded ? boundedText(value, param) : value;
}

export function optBool(body: Json, name: string, param = name): boolean | undefined {
  const value = body[name];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw wrongType(param, "a boolean");
  return value;
}

export function optInt(body: Json, name: string, param = name): number | undefined {
  const value = body[name];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value)) throw wrongType(param, "an integer");
  return value;
}

export function optStringArray(body: Json, name: string, param = name): string[] | undefined {
  const value = body[name];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) throw wrongType(param, "an array of strings");
  for (const label of value as string[]) {
    if (runeLength(label) > MAX_FIELD) throw invalid(param, `a label in \`${param}\` is longer than ${MAX_FIELD} characters`);
  }
  return value as string[];
}

const RFC3339 = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

/** An RFC 3339 timestamp, normalized to UTC; null passes through for members that clear. */
export function optTime(body: Json, name: string, param = name, nullable = false): string | null | undefined {
  const value = body[name];
  if (value === undefined) return undefined;
  if (value === null && nullable) return null;
  if (typeof value !== "string" || !RFC3339.test(value) || Number.isNaN(Date.parse(value))) {
    throw invalid(param, `\`${param}\` must be an RFC 3339 timestamp`);
  }
  return new Date(value).toISOString();
}

export function priorityOf(value: number, param: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 4) {
    throw invalid(param, `\`${param}\` is ${value}; the range is 0 to 4`);
  }
  return value;
}

/** Metadata keys: the shape upstream accepts in filters and patches. */
export const METADATA_KEY = /^[a-zA-Z_][a-zA-Z0-9_./]*$/;

export function metadataObject(value: unknown, param: string): Json {
  if (!isObject(value)) throw invalid(param, `\`${param}\` must be a JSON object`);
  return value;
}
