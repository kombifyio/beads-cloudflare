export const SCOPE_READ = "beads:read";
export const SCOPE_WRITE = "beads:write";
export const SCOPE_OFFLINE = "offline_access";
/**
 * Rewrites history: the import route stores records verbatim, timestamps and authorship included, past
 * close policy and cycle checks. Only agent API keys can carry it; the OAuth server never grants it.
 */
export const SCOPE_IMPORT = "beads:import";

/** Everything the authorization server can grant. */
export const SCOPES_SUPPORTED = [SCOPE_READ, SCOPE_WRITE, SCOPE_OFFLINE];

/**
 * The verified principal. OAuth grants carry `{sub, email, name}` only, never an upstream token.
 * The members below are set by this server for credentials it resolves itself (agent API keys and
 * the admin token); they never come from a client.
 */
export interface Principal {
  sub: string;
  email: string;
  name: string;
  /** Agent API key: the scopes it was issued with (OAuth tokens carry theirs in `ctx.auth.scope`). */
  scopes?: string[];
  /** Agent API key: trackers it may use; null or absent means all. */
  trackers?: string[] | null;
  kind?: "key" | "admin-token";
}

/** The scopes a request holds: a key's own, otherwise the OAuth token's. */
export const effectiveScopes = (principal: Principal, tokenScopes: string[]): string[] => principal.scopes ?? tokenScopes;

export const trackerAllowed = (principal: Principal, tracker: string): boolean =>
  !principal.trackers || principal.trackers.includes(tracker);
