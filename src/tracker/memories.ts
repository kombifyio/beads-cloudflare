// Memories: small durable notes keyed by a string, scoped to a tracker.
import { checkMembers } from "./body";
import type { Ctx } from "./events";
import { all, one } from "./model";
import { invalid, refuse } from "./problem";
import type { Out } from "./problem";
import { hasControlChar, type Json } from "./util";

const MAX_KEY = 245;
const MAX_VALUE_BYTES = 65_535;

const absent = () => refuse("not_found", "this workspace holds no memory under that key");

export function listMemories(sql: SqlStorage, tracker: string, search: string | undefined): Out {
  const needle = (search ?? "").toLowerCase();
  const rows = all<{ key: string; value: string }>(sql, "SELECT key, value FROM memories WHERE tracker = ?1 ORDER BY key", tracker).filter(
    (m) => needle === "" || m.key.toLowerCase().includes(needle) || m.value.toLowerCase().includes(needle),
  );
  return { status: 200, body: { items: rows, has_more: false } };
}

/** The one key rule, for remember, get and forget alike. */
export function keyParam(key: string): string {
  if (key.trim() === "") throw invalid("key", "`key` is empty after trimming");
  if (hasControlChar(key)) throw invalid("key", "`key` must not contain control characters");
  if (key.length > MAX_KEY) throw invalid("key", `\`key\` is longer than ${MAX_KEY} characters`);
  return key;
}

/** Derives a key from content when none is given: upstream internal/memoryapi ResolveKey. */
function deriveKey(content: string): string {
  const slug = content
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const joined = slug.split("-").slice(0, 8).join("-");
  const bytes = new TextEncoder().encode(joined).slice(0, 60);
  const key = new TextDecoder().decode(bytes).replace(/�+$/, "").replace(/-+$/, "");
  if (key === "") throw invalid(undefined, "validation failed: could not generate key from content; use a key to specify one");
  return key;
}

export function rememberMemory(ctx: Ctx, body: Json): Out {
  checkMembers(body, ["content", "key"]);
  if (body.content === undefined) throw invalid("content", "`content` is required");
  if (typeof body.content !== "string") throw invalid("content", "`content` must be a string");
  if (body.key !== undefined && typeof body.key !== "string") throw invalid("key", "`key` must be a string");
  if (body.content.trim() === "") throw invalid(undefined, "validation failed: memory content cannot be empty");
  const explicit = body.key as string | undefined;
  const key = explicit ? keyParam(explicit) : deriveKey(body.content);
  if (new TextEncoder().encode(body.content).length > MAX_VALUE_BYTES) {
    throw invalid("content", `\`content\` is longer than ${MAX_VALUE_BYTES} bytes`);
  }
  const replaced = one(ctx.sql, "SELECT 1 FROM memories WHERE tracker = ?1 AND key = ?2", ctx.tracker, key) !== undefined;
  ctx.sql.exec(
    "INSERT INTO memories (tracker, key, value) VALUES (?1, ?2, ?3) ON CONFLICT (tracker, key) DO UPDATE SET value = excluded.value",
    ctx.tracker, key, body.content,
  );
  return { status: 200, body: { key, value: body.content, replaced } };
}

function heldValue(sql: SqlStorage, tracker: string, key: string): string {
  const row = one<{ value: string }>(sql, "SELECT value FROM memories WHERE tracker = ?1 AND key = ?2", tracker, keyParam(key));
  // A memory stored empty reads as absent, like upstream.
  if (!row || row.value === "") throw absent();
  return row.value;
}

export function getMemory(sql: SqlStorage, tracker: string, key: string): Out {
  return { status: 200, body: { key, value: heldValue(sql, tracker, key) } };
}

export function forgetMemory(ctx: Ctx, key: string): Out {
  const value = heldValue(ctx.sql, ctx.tracker, key);
  ctx.sql.exec("DELETE FROM memories WHERE tracker = ?1 AND key = ?2", ctx.tracker, key);
  return { status: 200, body: { key, value } };
}
