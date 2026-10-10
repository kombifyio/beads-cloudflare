// The durable workspace settings plane: `bd config` reads and writes it.
//
// Two settings project into a normalized table, because the vocabulary is
// queried by member rather than as one string:
//
//   issue_prefix    the prefix every minted and explicit issue id carries (no projection)
//   status.custom   "name:category" pairs, comma separated -> custom_statuses
//   types.custom    a JSON array of names                     -> custom_types
//
// Keys are case-sensitive. "MyKey" and "mykey" are two settings, and folding
// them would silently drop one of them.
import { all, chunks, one } from "./model";
import { invalid } from "./problem";
import { checkMembers } from "./body";
import type { Out } from "./problem";
import type { Ctx } from "./events";
import { hasControlChar, type Json } from "./util";

export const KEY_ISSUE_PREFIX = "issue_prefix";
export const KEY_STATUS_CUSTOM = "status.custom";
export const KEY_TYPES_CUSTOM = "types.custom";
export const KEY_TYPES_INFRA = "types.infra";

/**
 * The issue types that route to the wisps table instead of the versioned issues
 * table, on a workspace that configured none.
 *
 * A backend that answers an empty set here does not degrade, it misfiles: rows
 * the workspace meant to keep ephemeral get versioned like ordinary issues.
 */
export const DEFAULT_INFRA_TYPES = ["agent", "role", "message"] as const;

/** storage columns (types.go:288-336): a key is 255 characters, a value 65535 BYTES. */
const MAX_KEY = 255;
const MAX_VALUE_BYTES = 65535;

/** Status categories a custom status may declare (types.go:563-585); a status with none is `unspecified`. */
const CATEGORIES = ["active", "wip", "done", "frozen"] as const;
const STATUS_NAME = /^[a-z][a-z0-9_-]*$/;
const MAX_CUSTOM_STATUSES = 50;
const BUILTIN_STATUS_NAMES = ["open", "in_progress", "blocked", "deferred", "closed", "pinned", "hooked"];

export function validateConfigKey(key: string): string {
  if (key.trim() === "") throw invalid("key", "`key` is empty after trimming");
  if (hasControlChar(key)) throw invalid("key", "`key` must not contain control characters");
  return key;
}

/**
 * Parses "name:category, name" (types.go ParseCustomStatusConfig, :609-660): the category is optional
 * and defaults to `unspecified`, a name is lower-case, letter-first, and never a built-in status.
 *
 * Validation happens before anything is written, so an invalid value leaves no trace.
 */
export function parseCustomStatuses(value: string): { name: string; category: string }[] {
  const out: { name: string; category: string }[] = [];
  const seen = new Set<string>();
  for (const raw of value.split(",")) {
    const entry = raw.trim();
    if (entry === "") continue;
    const colon = entry.indexOf(":");
    const name = colon >= 0 ? entry.slice(0, colon) : entry;
    let category = "unspecified";
    if (colon >= 0) {
      category = entry.slice(colon + 1);
      if (category === "") throw invalid(KEY_STATUS_CUSTOM, `invalid custom status "${entry}": trailing colon with empty category`);
      if (!(CATEGORIES as readonly string[]).includes(category)) {
        throw invalid(KEY_STATUS_CUSTOM, `invalid category "${category}" for status "${name}": must be one of active, wip, done, frozen`);
      }
    }
    if (!STATUS_NAME.test(name)) {
      throw invalid(KEY_STATUS_CUSTOM, `invalid status name "${name}": must match [a-z][a-z0-9_-]* (lowercase, letter-first, no spaces)`);
    }
    if (BUILTIN_STATUS_NAMES.includes(name.toLowerCase())) throw invalid(KEY_STATUS_CUSTOM, `custom status "${name}" collides with built-in status`);
    if (seen.has(name)) throw invalid(KEY_STATUS_CUSTOM, `duplicate custom status name "${name}"`);
    seen.add(name);
    out.push({ name, category });
  }
  if (out.length > MAX_CUSTOM_STATUSES) throw invalid(KEY_STATUS_CUSTOM, `too many custom statuses (${out.length}); the limit is ${MAX_CUSTOM_STATUSES}`);
  return out;
}

/** Parses `types.custom`: a comma-separated list or a JSON array (issueops/config_helpers.go:290). Order is kept. */
export function parseCustomTypes(value: string): string[] {
  const text = value.trim();
  let items: unknown[];
  if (text.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw invalid(KEY_TYPES_CUSTOM, `\`${KEY_TYPES_CUSTOM}\` must be a comma-separated list or a JSON array of names`);
    }
    if (!Array.isArray(parsed)) throw invalid(KEY_TYPES_CUSTOM, `\`${KEY_TYPES_CUSTOM}\` must be a comma-separated list or a JSON array of names`);
    items = parsed;
  } else {
    items = text.split(",");
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (typeof item !== "string") throw invalid(KEY_TYPES_CUSTOM, `\`${KEY_TYPES_CUSTOM}\` must hold strings, got ${JSON.stringify(item)}`);
    const name = item.trim();
    if (name === "") continue;
    if (hasControlChar(name)) throw invalid(KEY_TYPES_CUSTOM, "a custom type name must not contain control characters");
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/**
 * The issue-id prefix this workspace mints and requires.
 *
 * Normalized as upstream `ReadConfigPrefix` (internal/storage/issueops/helpers.go)
 * reads it: one trailing dash is dropped, because the dash is the separator ids add.
 * It falls back to the tracker name, which is what every id minted before the
 * settings plane existed carries. Reading it rather than hardcoding the tracker
 * is what lets a migrated workspace keep minting its original ids, and what bd's
 * own prefix check on a derived child id expects.
 */
export function issuePrefix(sql: SqlStorage, tracker: string): string {
  const row = one<{ value: string }>(sql, "SELECT value FROM config WHERE tracker = ?1 AND key = ?2", tracker, KEY_ISSUE_PREFIX);
  const configured = (row?.value?.trim() ?? "").replace(/-$/, "");
  return configured === "" ? tracker : configured;
}

/**
 * Repositions the projections for one setting.
 *
 * Replacing rather than merging is deliberate: a caller that sets
 * `status.custom` to a shorter list means those are the custom statuses now, so
 * a name dropped from the string stops being one.
 */
function project(ctx: Ctx, key: string, value: string | undefined): void {
  if (key === KEY_STATUS_CUSTOM) {
    ctx.sql.exec("DELETE FROM custom_statuses WHERE tracker = ?1", ctx.tracker);
    if (value === undefined) return;
    for (const { name, category } of parseCustomStatuses(value)) {
      ctx.sql.exec("INSERT INTO custom_statuses (tracker, name, category) VALUES (?, ?, ?)", ctx.tracker, name, category);
    }
    return;
  }
  if (key === KEY_TYPES_CUSTOM) {
    ctx.sql.exec("DELETE FROM custom_types WHERE tracker = ?1", ctx.tracker);
    if (value === undefined) return;
    parseCustomTypes(value).forEach((name, position) => {
      ctx.sql.exec("INSERT INTO custom_types (tracker, name, position) VALUES (?, ?, ?)", ctx.tracker, name, position);
    });
  }
}

/** Guarded logical recovery restores effective vocabularies independently from the stored settings. */
export function restoreVocabulary(ctx: Ctx, raw: unknown): void {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw invalid("vocabulary", "vocabulary must be an object");
  const value = raw as Record<string, unknown>;
  checkMembers(value, ["statuses", "types"], "vocabulary", "vocabulary.");
  if (!Array.isArray(value.statuses) || !Array.isArray(value.types)) throw invalid("vocabulary", "statuses and types must be arrays");
  const statusValue = value.statuses.map((status: unknown) => {
    if (!status || typeof status !== "object" || Array.isArray(status)) throw invalid("vocabulary.statuses", "a status must be an object");
    const item = status as Record<string, unknown>;
    checkMembers(item, ["name", "category"], "vocabulary.statuses", "vocabulary.statuses.");
    if (typeof item.name !== "string" || !STATUS_NAME.test(item.name) || typeof item.category !== "string" ||
      ![...CATEGORIES, "unspecified"].includes(item.category)) throw invalid("vocabulary.statuses", "invalid status name or category");
    return item.category === "unspecified" ? item.name : `${item.name}:${item.category}`;
  }).join(",");
  // Both validators run before either projection is changed.
  parseCustomStatuses(statusValue);
  const typesValue = JSON.stringify(value.types);
  parseCustomTypes(typesValue);
  project(ctx, KEY_STATUS_CUSTOM, statusValue);
  project(ctx, KEY_TYPES_CUSTOM, typesValue);
}

/** internal/config/yaml_config.go:134-179: the key alone decides, never the value. */
const SECRET_PATTERNS = ["api_key", "api-key", "apikey", "secret", "token", "password", "passwd", "credential", "private_key", "privatekey", "privkey"];
const SECRET_SEGMENTS = new Set(["key", "keys", "apikey", "pwd", "pat", "auth", "bearer", "cert", "credential", "credentials", "secret", "token", "password"]);
export function isSecretKey(key: string): boolean {
  const lower = key.toLowerCase();
  if (SECRET_PATTERNS.some((p) => lower.includes(p))) return true;
  return lower.split(/[._-]/).some((segment) => SECRET_SEGMENTS.has(segment));
}

/** `Setting` on the wire (httpapi/settings.go wireSetting): a credential-bearing key is withheld, an empty value is absent. */
export function settingJson(key: string, value: string): { key: string; value?: string; redacted: boolean } {
  if (isSecretKey(key)) return { key, redacted: true };
  return value === "" ? { key, redacted: false } : { key, value, redacted: false };
}

function checkSettingKey(key: string): string {
  validateConfigKey(key);
  if ([...key].length > MAX_KEY) throw invalid("key", `\`key\` is ${[...key].length} characters; storage holds at most ${MAX_KEY}`);
  return key;
}

function checkSettingValue(value: unknown): string {
  if (typeof value !== "string") throw invalid("value", "`value` must be a string");
  const bytes = new TextEncoder().encode(value).length;
  if (bytes > MAX_VALUE_BYTES) throw invalid("value", `\`value\` is ${bytes} bytes; storage holds at most ${MAX_VALUE_BYTES}`);
  return value;
}

/** Stores the row and its projection in one act; the value was validated by the caller. */
export function storeSetting(ctx: Ctx, key: string, value: string): void {
  if (key === KEY_STATUS_CUSTOM) parseCustomStatuses(value);
  if (key === KEY_TYPES_CUSTOM) parseCustomTypes(value);
  ctx.sql.exec(
    `INSERT INTO config (tracker, key, value) VALUES (?1, ?2, ?3)
     ON CONFLICT (tracker, key) DO UPDATE SET value = excluded.value`,
    ctx.tracker, key, value,
  );
  project(ctx, key, value);
}

/** `PUT /config/{key}`: workapi/workspaceconfig.go:40-75. `issue_prefix` is owned by `bd init`, never written here. */
export function setSetting(ctx: Ctx, key: string, body: Json): Out {
  checkMembers(body, ["value"]);
  checkSettingKey(key);
  if (body.value === undefined) throw invalid("value", "`value` is required");
  const value = checkSettingValue(body.value);
  if (key === KEY_ISSUE_PREFIX || key === "issue-prefix") {
    throw invalid(
      undefined,
      `"${key}" is set by bd init --prefix, bd bootstrap or bd rename-prefix, not by a config write: storing it here would leave existing ids under the old prefix with nothing to reconcile them`,
    );
  }
  storeSetting(ctx, key, value);
  return { status: 200, body: settingJson(key, value) };
}

/**
 * `POST /config` (extension, kept from the first release): the key travels in the body and
 * `issue_prefix` may be written, which a mirror needs and `PUT` refuses.
 */
export function setConfig(ctx: Ctx, body: Json): Out {
  checkMembers(body, ["key", "value"]);
  const key = checkSettingKey(String(body.key ?? ""));
  const value = checkSettingValue(body.value ?? "");
  if (key === KEY_ISSUE_PREFIX) {
    const prefix = value.trim();
    if (prefix === "" || hasControlChar(prefix)) {
      throw invalid(KEY_ISSUE_PREFIX, `\`${KEY_ISSUE_PREFIX}\` must be a non-empty prefix without control characters`);
    }
  }
  storeSetting(ctx, key, value);
  return { status: 200, body: settingJson(key, value) };
}

/**
 * Removes a setting (`DELETE /config/{key}`).
 *
 * The normalized projection is deliberately left populated. Upstream treats
 * unset as removing the setting and nothing else, and a caller that has
 * just deleted `status.custom` still reads the statuses it had configured: the
 * setting and the vocabulary it declared are two different things.
 */
export function unsetSetting(ctx: Ctx, key: string): Out {
  validateConfigKey(key);
  ctx.sql.exec("DELETE FROM config WHERE tracker = ?1 AND key = ?2", ctx.tracker, key);
  return { status: 200, body: { key } };
}

export function getConfig(sql: SqlStorage, tracker: string, key: string): string {
  return one<{ value: string }>(sql, "SELECT value FROM config WHERE tracker = ?1 AND key = ?2", tracker, key)?.value ?? "";
}

/** `listSettings`: ordered by key, the `kv.` plane left out (workapi/workspaceconfig.go FilterSettingsEnumeration). */
export function listSettings(sql: SqlStorage, tracker: string): { items: ReturnType<typeof settingJson>[]; has_more: false } {
  const rows = all<{ key: string; value: string }>(sql, "SELECT key, value FROM config WHERE tracker = ?1 ORDER BY key", tracker);
  return { items: rows.filter((r) => !r.key.startsWith("kv.")).map((r) => settingJson(r.key, r.value)), has_more: false };
}

/** Import-scoped, bounded full configuration export; ordinary listing remains redacted. */
export function exportSettings(sql: SqlStorage, tracker: string, params: { cursor?: string; limit?: number } = {}) {
  const limit = params.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw invalid("limit", "limit must be from 1 to 200");
  const sized = all<{ key: string; size: number }>(sql,
    "SELECT key, length(CAST(key AS BLOB)) + length(CAST(value AS BLOB)) + 64 AS size FROM config WHERE tracker = ?1 AND key > ?2 ORDER BY key LIMIT ?3",
    tracker, params.cursor ?? "", limit + 1);
  let take = 0, weight = 0;
  for (const row of sized.slice(0, limit)) {
    if (take > 0 && weight + row.size > (4 << 20)) break;
    take++; weight += row.size;
  }
  const picked = sized.slice(0, take);
  const rows = new Map<string, { key: string; value: string }>();
  for (const part of chunks(picked.map(row => row.key))) {
    for (const row of all<{ key: string; value: string }>(sql,
      `SELECT key, value FROM config WHERE tracker = ?1 AND key IN (${part.map((_, i) => `?${i + 2}`).join(",")})`, tracker, ...part)) rows.set(row.key, row);
  }
  const hasMore = sized.length > take;
  return { items: picked.map(row => rows.get(row.key)!), has_more: hasMore, ...(hasMore ? { next_cursor: picked.at(-1)!.key } : {}) };
}

/**
 * The configured infra types, or the default set.
 *
 * A `types.infra` setting replaces the default outright rather than adding to it:
 * the key names the whole vocabulary. An empty configured value is not a
 * vocabulary, so it falls back to the default instead of disabling the
 * distinction and silently misfiling every wisp.
 */
export function infraTypes(sql: SqlStorage, tracker: string): Record<string, boolean> {
  const configured = getConfig(sql, tracker, KEY_TYPES_INFRA).trim();
  const names = configured === "" ? [...DEFAULT_INFRA_TYPES] : configured.split(",").map((n) => n.trim()).filter((n) => n !== "");
  if (names.length === 0) return infraSet([...DEFAULT_INFRA_TYPES]);
  return infraSet(names);
}

const infraSet = (names: string[]): Record<string, boolean> => Object.fromEntries(names.map((n) => [n, true]));

/** Custom status names, alphabetical, independent of the order they were declared in. */
export function customStatusNames(sql: SqlStorage, tracker: string): string[] {
  return all<{ name: string }>(sql, "SELECT name FROM custom_statuses WHERE tracker = ?1 ORDER BY name", tracker).map((r) => r.name);
}

export function customStatusesDetailed(sql: SqlStorage, tracker: string): { name: string; category: string }[] {
  return all<{ name: string; category: string }>(
    sql,
    "SELECT name, category FROM custom_statuses WHERE tracker = ?1 ORDER BY name",
    tracker,
  );
}

export function customTypeNames(sql: SqlStorage, tracker: string): string[] {
  return all<{ name: string }>(sql, "SELECT name FROM custom_types WHERE tracker = ?1 ORDER BY position", tracker).map((r) => r.name);
}

