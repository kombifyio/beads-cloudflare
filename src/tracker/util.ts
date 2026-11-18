// Small shared helpers: time, canonical JSON, text bounds.
import { invalid } from "./problem";

export const nowIso = () => new Date().toISOString();

/** Characters upstream refuses in bounded text: Unicode control characters and line/paragraph separators. */
export const hasControlChar = (text: string) => /[\p{Cc}\u2028\u2029]/u.test(text);

export const runeLength = (text: string) => [...text].length;

/** JSON with sorted object keys: a stable form for hashing and comparing requests. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)));
    }
    return v;
  });
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export type Json = Record<string, unknown>;
export const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The tracker id rule, shared by the HTTP route, the MCP tools and the store: it is also the issue-id prefix. */
export const TRACKER_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const MAX_TRACKER = 40;
export const isTrackerId = (value: unknown): value is string =>
  typeof value === "string" && value.length <= MAX_TRACKER && TRACKER_ID.test(value);

/** The optional X-Beads-Agent header: a client-asserted name, validated like other asserted names. */
export function agentHeader(value: string | null): string | undefined {
  const name = value?.trim();
  if (!name) return undefined;
  if ([...name].length > 255 || hasControlChar(name)) throw invalid("X-Beads-Agent", "X-Beads-Agent must be at most 255 characters without control characters");
  return name;
}

/**
 * Parses a stored JSON column without letting one malformed row break a read of the others: anything
 * that does not parse is `fallback`. Stored text may predate the validation that guards writes now.
 */
export function safeJson<T>(text: string | null | undefined, fallback: T): unknown | T {
  if (text === null || text === undefined || text === "") return fallback;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return fallback;
  }
}

/** A stored JSON object, or an empty one when the column is malformed or holds something else. */
export function safeObject(text: string | null | undefined): Json {
  const value = safeJson(text, {});
  return isObject(value) ? value : {};
}

/**
 * Defines an own data property. `obj[key] = v` with key `__proto__` would set the prototype and store
 * nothing, so every object built from a caller-chosen key goes through this.
 */
export function setOwn<T extends object>(obj: T, key: string, value: unknown): T {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
  return obj;
}
