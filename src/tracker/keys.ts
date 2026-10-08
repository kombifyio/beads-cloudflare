// Agent API keys: `bcf_<keyId>_<secret>`. The secret is 32 random bytes, base64url; only its SHA-256
// is stored. Never log a key or its secret.
import type { Principal } from "../auth/scopes";
import { SCOPE_IMPORT, SCOPE_READ, SCOPE_WRITE } from "../auth/scopes";
import { checkMembers, optInt } from "./body";
import { invalid, refuse } from "./problem";
import { all, one } from "./model";
import { hasControlChar, isTrackerId, safeJson, sha256Hex, type Json } from "./util";

const KEY_PATTERN = /^bcf_([0-9a-f]{16})_([A-Za-z0-9_-]{43})$/;
const LAST_USED_EVERY_MS = 10 * 60_000;
const MAX_LABEL = 64;
const MAX_DAYS = 3650;

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");

export interface NewKey {
  id: string;
  /** The full credential; shown once. */
  token: string;
  secretHash: string;
}

export async function generateKey(): Promise<NewKey> {
  const id = [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const secret = b64url(crypto.getRandomValues(new Uint8Array(32)));
  return { id, token: `bcf_${id}_${secret}`, secretHash: await sha256Hex(secret) };
}

/** Domain-separated HMACs keep a reusable exchange secret independent of its public key id. */
export async function reusableKey(signingSecret: string, identity: string): Promise<NewKey> {
  const encoder = new TextEncoder();
  const signingKey = await crypto.subtle.importKey("raw", encoder.encode(signingSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = async (domain: string) => new Uint8Array(await crypto.subtle.sign("HMAC", signingKey, encoder.encode(`${domain}:${identity}`)));
  const id = [...(await digest("key-id")).slice(0, 8)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const secret = b64url(await digest("key-secret"));
  return { id, token: `bcf_${id}_${secret}`, secretHash: await sha256Hex(secret) };
}

export function parseKey(token: string): { id: string; secret: string } | undefined {
  const m = KEY_PATTERN.exec(token);
  return m ? { id: m[1]!, secret: m[2]! } : undefined;
}

/** Compares two equal-length strings without an early exit. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Constant-time check of a presented secret against an expected one, via their digests. */
export async function secretsMatch(presented: string, expected: string): Promise<boolean> {
  return timingSafeEqual(await sha256Hex(presented), await sha256Hex(expected));
}

export interface KeyInfo {
  id: string;
  label: string;
  scopes: string[];
  trackers: string[] | null;
  created_by: string;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
}

interface KeyRow {
  [column: string]: SqlStorageValue;
  id: string;
  label: string;
  secret_hash: string;
  scopes: string;
  trackers: string | null;
  created_by: string;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
}

const info = (r: KeyRow): KeyInfo => ({
  id: r.id,
  label: r.label,
  scopes: Array.isArray(safeJson(r.scopes, [])) ? (safeJson(r.scopes, []) as string[]) : [],
  trackers: r.trackers === null ? null : Array.isArray(safeJson(r.trackers, null)) ? (safeJson(r.trackers, null) as string[]) : [],
  created_by: r.created_by,
  created_at: r.created_at,
  expires_at: r.expires_at,
  revoked_at: r.revoked_at,
  last_used_at: r.last_used_at,
});

export interface KeyRequest {
  label: string;
  scopes: string[];
  trackers: string[] | null;
  expiresInDays?: number;
  /** Internal exchange expiry; never parsed from the public admin body. */
  expiresAt?: string;
}

/** Validates the body of `POST /admin/keys`. */
export function parseKeyRequest(body: Json): KeyRequest {
  checkMembers(body, ["label", "scopes", "trackers", "expires_in_days"]);
  if (typeof body.label !== "string") throw invalid("label", "`label` is required and must be a string");
  const label = body.label.trim();
  if (label === "" || [...label].length > MAX_LABEL || hasControlChar(label)) {
    throw invalid("label", `\`label\` must be 1 to ${MAX_LABEL} characters without control characters`);
  }
  const allowed = [SCOPE_READ, SCOPE_WRITE, SCOPE_IMPORT];
  if (!Array.isArray(body.scopes) || body.scopes.length === 0 || body.scopes.some((s) => !allowed.includes(s as string))) {
    throw invalid("scopes", `\`scopes\` must be a non-empty array of ${allowed.join(", ")}`);
  }
  // Writing without reading would be useless: read is always included.
  const scopes = [...new Set([SCOPE_READ, ...(body.scopes as string[])])];
  // Importing is writing: a key that may import must also be able to write.
  if (scopes.includes(SCOPE_IMPORT) && !scopes.includes(SCOPE_WRITE)) scopes.push(SCOPE_WRITE);
  let trackers: string[] | null = null;
  if (body.trackers !== undefined && body.trackers !== null) {
    if (!Array.isArray(body.trackers) || body.trackers.length === 0 || body.trackers.some((t) => !isTrackerId(t))) {
      throw invalid("trackers", "`trackers` must be a non-empty array of tracker ids, or omitted for all trackers");
    }
    trackers = [...new Set(body.trackers as string[])];
  }
  const days = optInt(body, "expires_in_days");
  if (days !== undefined && (days < 1 || days > MAX_DAYS)) throw invalid("expires_in_days", `\`expires_in_days\` must be between 1 and ${MAX_DAYS}`);
  return { label, scopes, trackers, expiresInDays: days };
}

export function insertKey(sql: SqlStorage, key: NewKey, req: KeyRequest, createdBy: string, now: string): KeyInfo {
  const expires = req.expiresAt ?? (req.expiresInDays === undefined ? null : new Date(Date.parse(now) + req.expiresInDays * 86_400_000).toISOString());
  sql.exec(
    "INSERT INTO api_keys (id, label, secret_hash, scopes, trackers, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    key.id, req.label, key.secretHash, JSON.stringify(req.scopes), req.trackers ? JSON.stringify(req.trackers) : null, createdBy, now, expires,
  );
  return info(one<KeyRow>(sql, "SELECT * FROM api_keys WHERE id = ?", key.id)!);
}

/** Called in the TeamStore transaction: reuse an hourly key, preserving admin revocation. */
export function insertExchangeKey(sql: SqlStorage, key: NewKey, req: KeyRequest, createdBy: string, now: string): KeyInfo | null {
  if (!req.expiresAt || req.expiresAt <= now) return null;
  const existing = one<KeyRow>(sql, "SELECT * FROM api_keys WHERE id = ?", key.id);
  if (existing) {
    if (existing.revoked_at || existing.expires_at !== req.expiresAt || existing.created_by !== createdBy ||
      !timingSafeEqual(existing.secret_hash, key.secretHash) || existing.scopes !== JSON.stringify(req.scopes) ||
      existing.trackers !== JSON.stringify(req.trackers)) return null;
    return info(existing);
  }
  return insertKey(sql, key, req, createdBy, now);
}

export const listKeys = (sql: SqlStorage): KeyInfo[] => all<KeyRow>(sql, "SELECT * FROM api_keys ORDER BY created_at, id").map(info);

/** Revocation is idempotent: a revoked key keeps its first revocation time. */
export function revokeKey(sql: SqlStorage, id: string, now: string): KeyInfo {
  const row = one<KeyRow>(sql, "SELECT * FROM api_keys WHERE id = ?", id);
  if (!row) throw refuse("not_found", "no API key with that id");
  if (!row.revoked_at) sql.exec("UPDATE api_keys SET revoked_at = ? WHERE id = ?", now, id);
  return info(one<KeyRow>(sql, "SELECT * FROM api_keys WHERE id = ?", id)!);
}

/** The principal for a presented key, or null when it is unknown, wrong, revoked or expired. */
export function authenticateKey(sql: SqlStorage, id: string, secretHash: string, now: string): Principal | null {
  const row = one<KeyRow>(sql, "SELECT * FROM api_keys WHERE id = ?", id);
  // Compare even when the row is missing, so unknown ids and wrong secrets cost the same.
  const matches = timingSafeEqual(row?.secret_hash ?? "0".repeat(64), secretHash);
  if (!row || !matches || row.revoked_at || (row.expires_at && row.expires_at <= now)) return null;
  const cutoff = new Date(Date.parse(now) - LAST_USED_EVERY_MS).toISOString();
  sql.exec("UPDATE api_keys SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)", now, id, cutoff);
  const k = info(row);
  // Exchange display labels are shared; ownership follows the verified issuer identity across key rotation.
  const exchangeIdentity = k.created_by.startsWith("github-exchange:") ? k.created_by : undefined;
  return { sub: exchangeIdentity ?? `key:${k.id}`, email: exchangeIdentity ?? `agent:${k.label}`, name: k.label, scopes: k.scopes, trackers: k.trackers, kind: "key" };
}
