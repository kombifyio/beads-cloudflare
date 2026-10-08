// Cloudflare Access for SaaS (OIDC) as the upstream identity provider.
// Authorization, token and JWKS endpoints derive from ACCESS_ISSUER.

export interface AccessIdentity {
  sub: string;
  email: string;
  name: string;
}

interface Jwk extends JsonWebKey {
  kid?: string;
}

const SCOPES = "openid email profile";

export function accessEndpoints(issuer: string) {
  const base = issuer.replace(/\/+$/, "");
  return { authorization: `${base}/authorization`, token: `${base}/token`, jwks: `${base}/jwks` };
}

/** Human sign-in needs the issuer and both client credentials; without them only agent API keys work. */
export function accessConfigured(env: Env): boolean {
  return Boolean(env.ACCESS_ISSUER && env.ACCESS_CLIENT_ID && env.ACCESS_CLIENT_SECRET);
}

function clientCredentials(env: Env): { id: string; secret: string } {
  if (!env.ACCESS_CLIENT_ID || !env.ACCESS_CLIENT_SECRET) throw new Error("Access is not configured");
  return { id: env.ACCESS_CLIENT_ID, secret: env.ACCESS_CLIENT_SECRET };
}

export function callbackUrl(env: Env): string {
  return new URL("/callback", env.PUBLIC_ORIGIN).href;
}

function base64url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64url(text: string): Uint8Array<ArrayBuffer> {
  const padded = text.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(text.length / 4) * 4, "=");
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function randomToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function s256(verifier: string): Promise<string> {
  return base64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
}

export async function authorizeUrl(env: Env, input: { state: string; verifier: string; nonce: string }): Promise<string> {
  const url = new URL(accessEndpoints(env.ACCESS_ISSUER).authorization);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientCredentials(env).id);
  url.searchParams.set("redirect_uri", callbackUrl(env));
  url.searchParams.set("scope", SCOPES);
  url.searchParams.set("state", input.state);
  url.searchParams.set("nonce", input.nonce);
  url.searchParams.set("code_challenge", await s256(input.verifier));
  url.searchParams.set("code_challenge_method", "S256");
  return url.href;
}

/** Exchanges the authorization code at Access and returns the verified identity. */
export async function exchangeCode(
  env: Env,
  input: { code: string; verifier: string; nonce: string },
): Promise<AccessIdentity> {
  const response = await fetch(accessEndpoints(env.ACCESS_ISSUER).token, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: callbackUrl(env),
      client_id: clientCredentials(env).id,
      client_secret: clientCredentials(env).secret,
      code_verifier: input.verifier,
    }),
  });
  if (!response.ok) throw new Error(`Access token endpoint answered ${response.status}`);
  const body = (await response.json()) as { id_token?: unknown };
  if (typeof body.id_token !== "string") throw new Error("Access token response has no id_token");
  // The upstream access token is deliberately dropped: only the verified identity is kept.
  return verifyIdToken(env, body.id_token, input.nonce);
}

let jwksCache: { url: string; keys: Jwk[]; fetchedAt: number } | undefined;

async function signingKey(env: Env, kid: string | undefined): Promise<CryptoKey> {
  const url = accessEndpoints(env.ACCESS_ISSUER).jwks;
  const fresh = (maxAgeMs: number) => jwksCache?.url === url && Date.now() - jwksCache.fetchedAt < maxAgeMs;
  const find = () => jwksCache?.keys.find((k) => k.kid === kid && (k.kty === "RSA"));
  if (!fresh(10 * 60_000) || !find()) {
    // Refetch on a stale cache or an unknown kid (key rotation), at most once a minute.
    if (!fresh(60_000) || !jwksCache) {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Access JWKS endpoint answered ${response.status}`);
      const body = (await response.json()) as { keys?: Jwk[] };
      jwksCache = { url, keys: body.keys ?? [], fetchedAt: Date.now() };
    }
  }
  const jwk = find();
  if (!jwk) throw new Error("no matching signing key");
  return crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
}

/** Verifies signature, exp, iss and aud (= our client id) of an Access id_token. */
export async function verifyIdToken(env: Env, token: string, expectedNonce: string): Promise<AccessIdentity> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("malformed id_token");
  const [head, body, signature] = parts as [string, string, string];
  const header = JSON.parse(new TextDecoder().decode(fromBase64url(head))) as { alg?: string; kid?: string };
  if (header.alg !== "RS256") throw new Error("unsupported id_token algorithm");
  const key = await signingKey(env, header.kid);
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    fromBase64url(signature),
    new TextEncoder().encode(`${head}.${body}`),
  );
  if (!valid) throw new Error("invalid id_token signature");

  const claims = JSON.parse(new TextDecoder().decode(fromBase64url(body))) as Record<string, unknown>;
  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== "number" || claims.exp <= now) throw new Error("expired id_token");
  if (typeof claims.nbf === "number" && claims.nbf > now + 60) throw new Error("id_token not yet valid");
  if (claims.iss !== env.ACCESS_ISSUER) throw new Error("unexpected id_token issuer");
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(clientCredentials(env).id)) throw new Error("unexpected id_token audience");
  if (claims.nonce !== expectedNonce) throw new Error("unexpected id_token nonce");
  if (typeof claims.sub !== "string" || claims.sub === "") throw new Error("id_token has no subject");
  if (typeof claims.email !== "string" || claims.email === "") throw new Error("id_token has no email");
  return {
    sub: claims.sub,
    email: claims.email,
    name: typeof claims.name === "string" && claims.name !== "" ? claims.name : claims.email,
  };
}
