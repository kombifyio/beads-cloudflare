// Portable repository authorization. GitHub credentials never enter storage or error responses.
import { respond, storeFor } from "../http/endpoint";
import { readBoundedBody } from "../http/body";
import { SCOPE_IMPORT, SCOPE_READ, SCOPE_WRITE } from "./scopes";
import { reusableKey } from "../tracker/keys";
import { invalid, problemOut, Refusal, refuse } from "../tracker/problem";
import { isObject, isTrackerId } from "../tracker/util";

const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/;
const WINDOW_MS = 59 * 60_000;
const OIDC_ISSUER = "https://token.actions.githubusercontent.com";
interface OidcPolicy { repository_id: string; workflow_refs: string[] }
interface AppReadPolicy { app_id: string; installation_id: string; repositories: string[] }
interface RepositoryPolicy { trackers: string[]; import?: boolean; oidc?: OidcPolicy }

function policies(raw: string): Record<string, RepositoryPolicy> {
  try {
    if (raw.length > 128 * 1024) throw new Error();
    const parsed: unknown = JSON.parse(raw);
    if (!isObject(parsed) || Object.keys(parsed).length > 1000) throw new Error();
    for (const [repository, policy] of Object.entries(parsed)) {
      if (!REPOSITORY.test(repository) || !isObject(policy) ||
        Object.keys(policy).some((key) => key !== "trackers" && key !== "import" && key !== "oidc") ||
        !Array.isArray(policy.trackers) || policy.trackers.length === 0 || policy.trackers.length > 100 ||
        policy.trackers.some((tracker) => !isTrackerId(tracker)) ||
        (policy.import !== undefined && typeof policy.import !== "boolean")) throw new Error();
      if (policy.oidc !== undefined) {
        const oidc = policy.oidc;
        if (!isObject(oidc) || Object.keys(oidc).some((key) => key !== "repository_id" && key !== "workflow_refs") ||
          typeof oidc.repository_id !== "string" || !/^[1-9][0-9]{0,19}$/.test(oidc.repository_id) ||
          !Array.isArray(oidc.workflow_refs) || oidc.workflow_refs.length === 0 || oidc.workflow_refs.length > 100) throw new Error();
        // Relative refs save binding space in larger fleets, but still authorize one exact repo/file/ref.
        const refs = oidc.workflow_refs.map((ref) => typeof ref === "string" && ref.startsWith(".github/workflows/") ? `${repository}/${ref}` : ref);
        if (refs.some((ref) => typeof ref !== "string" ||
            !ref.startsWith(`${repository}/.github/workflows/`) || !ref.endsWith("@refs/heads/main") ||
            !/^[A-Za-z0-9_.-]+\.ya?ml$/.test(ref.slice(`${repository}/.github/workflows/`.length, -"@refs/heads/main".length)))) throw new Error();
        oidc.workflow_refs = refs;
      }
    }
    return parsed as unknown as Record<string, RepositoryPolicy>;
  } catch {
    throw refuse("internal", "GitHub repository authorization is not configured correctly.");
  }
}

/** A separate reader grant intersects the existing repository/tracker mapping. */
function appReadPolicy(raw: string): AppReadPolicy | undefined {
  if (!raw) return undefined;
  try {
    if (new TextEncoder().encode(raw).byteLength > 5120) throw new Error();
    const app: unknown = JSON.parse(raw);
    if (!isObject(app) || Object.keys(app).some((key) => !["app_id", "installation_id", "repositories"].includes(key)) ||
      typeof app.app_id !== "string" || !/^[1-9][0-9]{0,19}$/.test(app.app_id) ||
      typeof app.installation_id !== "string" || !/^[1-9][0-9]{0,19}$/.test(app.installation_id) ||
      !Array.isArray(app.repositories) || app.repositories.length === 0 || app.repositories.length > 100 ||
      app.repositories.some((repository) => typeof repository !== "string" || !REPOSITORY.test(repository)) ||
      new Set(app.repositories).size !== app.repositories.length) throw new Error();
    return app as unknown as AppReadPolicy;
  } catch {
    throw refuse("internal", "GitHub App reader authorization is not configured correctly.");
  }
}

interface SigningJwk extends JsonWebKey { kid: string }
let oidcKeys: { keys: SigningJwk[]; fetchedAt: number } | undefined;

function decodeJwtPart(part: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(part)) throw new Error();
  const binary = atob(part.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(part.length / 4) * 4, "="));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/** The same RS256 WebCrypto verification used for Access sign-in, with fixed GitHub trust roots. */
async function oidcIdentity(token: string, repository: string, policy: OidcPolicy | undefined, audience: string): Promise<string> {
  try {
    if (!policy) throw new Error();
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error();
    const [head, payload, signature] = parts as [string, string, string];
    const header: unknown = JSON.parse(new TextDecoder().decode(decodeJwtPart(head)));
    if (!isObject(header) || header.alg !== "RS256" || typeof header.kid !== "string" || header.kid.length > 128 || header.crit !== undefined) throw new Error();
    const find = () => oidcKeys?.keys.find((key) => key.kid === header.kid);
    if (!oidcKeys || Date.now() - oidcKeys.fetchedAt >= 600_000 || (!find() && Date.now() - oidcKeys.fetchedAt >= 60_000)) {
      const response = await fetch(`${OIDC_ISSUER}/.well-known/jwks`, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
      if (!response.ok) { await response.body?.cancel(); throw new Error(); }
      const jwks = await boundedJson(response, 64 * 1024);
      if (!isObject(jwks) || !Array.isArray(jwks.keys) || jwks.keys.length > 32) throw new Error();
      const keys = jwks.keys.filter((key): key is SigningJwk => isObject(key) && typeof key.kid === "string" &&
        key.kty === "RSA" && key.alg === "RS256" && key.use === "sig" && typeof key.n === "string" && typeof key.e === "string");
      oidcKeys = { keys, fetchedAt: Date.now() };
    }
    const jwk = find();
    if (!jwk) throw new Error();
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    if (!await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, decodeJwtPart(signature), new TextEncoder().encode(`${head}.${payload}`))) throw new Error();
    const claims: unknown = JSON.parse(new TextDecoder().decode(decodeJwtPart(payload)));
    const now = Date.now() / 1000;
    const [owner, name] = repository.split("/");
    // GitHub's current default embeds immutable IDs in subjects for newer repositories.
    const subjectAllowed = isObject(claims) && (claims.sub === `repo:${repository}:ref:refs/heads/main` ||
      (typeof claims.repository_owner_id === "string" && /^[1-9][0-9]{0,19}$/.test(claims.repository_owner_id) &&
        claims.sub === `repo:${owner}@${claims.repository_owner_id}/${name}@${policy.repository_id}:ref:refs/heads/main`));
    if (!isObject(claims) || claims.iss !== OIDC_ISSUER || claims.aud !== audience ||
      typeof claims.exp !== "number" || !Number.isFinite(claims.exp) || claims.exp <= now ||
      typeof claims.iat !== "number" || !Number.isFinite(claims.iat) || claims.iat > now + 60 || claims.iat < now - 600 ||
      typeof claims.nbf !== "number" || !Number.isFinite(claims.nbf) || claims.nbf > now + 60 ||
      claims.repository !== repository || claims.repository_id !== policy.repository_id ||
      claims.ref !== "refs/heads/main" || !subjectAllowed ||
      typeof claims.workflow_ref !== "string" || !policy.workflow_refs.includes(claims.workflow_ref) ||
      !["push", "workflow_dispatch", "schedule"].includes(claims.event_name as string) ||
      (claims.head_ref !== undefined && claims.head_ref !== "") || (claims.base_ref !== undefined && claims.base_ref !== "")) throw new Error();
    return `github-exchange:oidc:${policy.repository_id}:${claims.workflow_ref}`;
  } catch {
    throw refuse("forbidden", "GitHub Actions identity must match the configured repository and main-branch workflow.");
  }
}

/** Avoid credentials that expire before a client's next request, while keeping the lifetime <= one hour. */
export const githubCredentialExpiry = (now: number): string =>
  new Date((Math.floor(now / WINDOW_MS) + 1) * WINDOW_MS + 60_000).toISOString();

/** Bound buffering before parsing, including bodies whose Content-Length is absent or false. */
async function boundedJson(body: Request | Response, limit: number): Promise<unknown> {
  return JSON.parse(new TextDecoder().decode(await readBoundedBody(body, limit)));
}

async function github(path: string, token: string): Promise<unknown> {
  try {
    const response = await fetch(`https://api.github.com${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "beads-cloudflare",
        "X-GitHub-Api-Version": "2026-03-10",
      },
      // Workers supports manual redirects; every non-2xx response below is denied.
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error();
    }
    return await boundedJson(response, 256 * 1024);
  } catch {
    // Includes redirects, rate limits and upstream failures; never forward GitHub's body or URL.
    throw refuse("forbidden", "GitHub could not verify repository write access. Check your GitHub user credential and retry.");
  }
}

export async function exchangeGithub(request: Request, env: Env): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const policy = policies(env.GITHUB_REPOSITORIES ?? "{}");
    const match = /^Bearer ([A-Za-z0-9_.-]{1,16384})$/i.exec(request.headers.get("Authorization") ?? "");
    if (!match) throw refuse("unauthenticated", "A GitHub user access token is required.");
    if (request.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
      throw invalid("Content-Type", "This operation accepts application/json only.");
    }
    let body: unknown;
    try { body = await boundedJson(request, 4096); }
    catch { throw invalid(undefined, "Send a JSON object containing repository and tracker, at most 4096 bytes."); }
    if (!isObject(body) || Object.keys(body).some((key) => !["repository", "tracker", "credential_type"].includes(key)) ||
      (body.credential_type !== undefined && body.credential_type !== "github-app") ||
      typeof body.repository !== "string" || !REPOSITORY.test(body.repository) || !isTrackerId(body.tracker)) {
      throw invalid(undefined, "Send a GitHub owner/repository and a valid tracker.");
    }
    const repository = body.repository;
    const tracker = body.tracker as string;
    const configured = Object.hasOwn(policy, repository) ? policy[repository] : undefined;
    if (!configured?.trackers.includes(tracker)) throw refuse("forbidden", "This repository is not authorized for the requested tracker.");
    if (!env.COOKIE_ENCRYPTION_KEY || env.COOKIE_ENCRYPTION_KEY.length < 32) {
      throw refuse("internal", "GitHub credential signing is not configured correctly.");
    }
    const token = match[1]!;
    let subject: string;
    const appRead = body.credential_type === "github-app";
    if (appRead) {
      const reader = appReadPolicy(env.GITHUB_READ_APP ?? "");
      if (!reader?.repositories.includes(repository) || token.split(".").length !== 3) {
        throw refuse("forbidden", "A configured GitHub App reader and its App JWT are required.");
      }
      // GitHub verifies the App JWT's signature and expiry. Repository membership
      // uses the existing exact owner/name mapping; App and installation IDs are immutable.
      const app = await github("/app", token);
      if (!isObject(app) || !Number.isSafeInteger(app.id) || String(app.id) !== reader.app_id) {
        throw refuse("forbidden", "The GitHub App is not an authorized reader.");
      }
      const installation = await github(`/repos/${repository}/installation`, token);
      if (!isObject(installation) || !Number.isSafeInteger(installation.id) ||
        String(installation.id) !== reader.installation_id ||
        !Number.isSafeInteger(installation.app_id) || String(installation.app_id) !== reader.app_id ||
        installation.suspended_at !== null) {
        throw refuse("forbidden", "The GitHub App installation is not an authorized reader for this repository.");
      }
      subject = `github-exchange:app:${app.id}:installation:${installation.id}`;
    } else if (token.split(".").length === 3) {
      subject = await oidcIdentity(token, repository, configured.oidc, env.PUBLIC_ORIGIN);
    } else {
      const repo = await github(`/repos/${repository}`, token);
      if (!isObject(repo) || repo.full_name !== repository || !isObject(repo.permissions) || repo.permissions.push !== true) {
        throw refuse("forbidden", "GitHub repository write permission is required.");
      }
      // Stable user identity bounds issuance across PATs. Installation tokens cannot establish it.
      const user = await github("/user", token);
      if (!isObject(user) || !Number.isSafeInteger(user.id) || (user.id as number) <= 0) {
        throw refuse("forbidden", "A verified GitHub user credential is required.");
      }
      subject = `github-exchange:${user.id}`;
    }
    const scopes = appRead ? [SCOPE_READ] : [SCOPE_READ, SCOPE_WRITE, ...(configured.import === true ? [SCOPE_IMPORT] : [])];
    const expiresAt = githubCredentialExpiry(Date.now());
    const key = await reusableKey(env.COOKIE_ENCRYPTION_KEY,
      JSON.stringify(["github-exchange-v1", env.TEAM, repository, tracker, subject, scopes, expiresAt]));
    const issued = await storeFor(env).createExchangeKey(key, {
      label: `github:${tracker}`, scopes, trackers: [tracker], expiresAt,
    }, subject);
    if (!issued) throw refuse("forbidden", "This exchanged credential was revoked. Retry after its expiry or contact the administrator.");
    return respond({ status: 200, body: { token: key.token, expires_at: issued.expires_at } }, requestId);
  } catch (error) {
    return respond(error instanceof Refusal ? error.out : problemOut("internal", "GitHub authorization failed."), requestId);
  }
}
