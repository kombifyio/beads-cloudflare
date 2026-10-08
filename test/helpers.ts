// Test harness: real tokens from the provider's own authorization flow, requests through the real Worker.
import { getOAuthApi, type AuthRequest } from "@cloudflare/workers-oauth-provider";
import { env, exports } from "cloudflare:workers";
import { providerOptions } from "../src/auth/provider";
import { SCOPE_READ, SCOPE_WRITE } from "../src/auth/scopes";

const ORIGIN = env.PUBLIC_ORIGIN;
const REDIRECT = "https://client.test/callback";

export const BOTH = [SCOPE_READ, SCOPE_WRITE];

const b64url = (bytes: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");

let clientReady: Promise<{ clientId: string }> | undefined;

/**
 * Issues an access token the way a client would get one, minus the browser: the provider validates
 * the authorization request, the grant is completed for a verified principal (what the Access
 * callback does after sign-in), and the code is redeemed at the real token endpoint.
 */
export async function tokenFor(email: string, scopes: string[] = BOTH): Promise<string> {
  const oauth = getOAuthApi(providerOptions(env), env);
  clientReady ??= oauth.createClient({ redirectUris: [REDIRECT], tokenEndpointAuthMethod: "none", clientName: "test" });
  const CLIENT_ID = (await clientReady).clientId;

  const verifier = `${crypto.randomUUID()}${crypto.randomUUID()}`;
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const authorize = new URL("/authorize", ORIGIN);
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT,
    scope: scopes.join(" "),
    state: "state",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: ORIGIN,
  }).toString();
  const request: AuthRequest = await oauth.parseAuthRequest(new Request(authorize));
  const sub = `sub-${email}`;
  const { redirectTo } = await oauth.completeAuthorization({
    request,
    userId: encodeURIComponent(sub),
    metadata: {},
    scope: scopes,
    props: { sub, email, name: email },
  });
  const code = new URL(redirectTo).searchParams.get("code")!;

  const response = await exports.default.fetch(
    new Request(new URL("/oauth/token", ORIGIN), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT,
        client_id: CLIENT_ID,
        code_verifier: verifier,
        resource: ORIGIN,
      }),
    }),
  );
  const body = (await response.json()) as { access_token?: string };
  if (!body.access_token) throw new Error(`token endpoint refused: ${JSON.stringify(body)}`);
  return body.access_token;
}

export interface Reply {
  status: number;
  headers: Headers;
  body: any;
}

export async function call(method: string, path: string, token: string | undefined, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  const response = await exports.default.fetch(
    new Request(new URL(path, ORIGIN), {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  const text = await response.text();
  let parsed: any = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // not JSON: keep the text
  }
  return { status: response.status, headers: response.headers, body: parsed };
}

/** A tracker API client bound to one token. `actor` is the name work is allocated to, not an identity. */
export function tracker(name: string, token: string, who = "someone") {
  const base = `/t/${name}/v0/beads`;
  return {
    get: (path: string, headers?: Record<string, string>) => call("GET", base + path, token, undefined, headers),
    post: (path: string, body: object, headers?: Record<string, string>) => call("POST", base + path, token, { actor: who, ...body }, headers),
    patch: (path: string, body: object, headers?: Record<string, string>) => call("PATCH", base + path, token, { actor: who, ...body }, headers),
    create: async (title: string, extra: object = {}) => {
      const r = await call("POST", `${base}/issues`, token, { actor: who, title, issue_type: "task", priority: 2, ...extra });
      if (r.status !== 200) throw new Error(`create failed: ${JSON.stringify(r.body)}`);
      return r.body.id as string;
    },
  };
}
