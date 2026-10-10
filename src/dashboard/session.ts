import { accessConfigured, randomToken, s256 } from "../auth/access";
import { providerFor } from "../auth/provider";
import { SCOPE_READ } from "../auth/scopes";

const SESSION_COOKIE = "__Host-beads-dashboard";
const STATE_COOKIE = "__Host-beads-dashboard-state";
const LOGIN_TTL = 600;
const SESSION_TTL = 3600;
const PREFIX = "dashboard:v1:";

interface Client { id: string; secret: string }
interface Login { state: string; verifier: string; client: Client; expires: number }
interface Session { token: string; expires: number }

const now = () => Math.floor(Date.now() / 1000);
const validHandle = (value: string | undefined): value is string => Boolean(value && /^[A-Za-z0-9_-]{43}$/.test(value));

function cookie(request: Request, name: string): string | undefined {
  const values = (request.headers.get("Cookie") ?? "").split(";")
    .map((part) => part.trim()).filter((part) => part.startsWith(`${name}=`));
  return values.length === 1 ? values[0]?.slice(name.length + 1) : undefined;
}

function setCookie(name: string, value: string, age: number): string {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${age}`;
}

function privateHeaders(): Headers {
  return new Headers({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" });
}

function failure(message: string, status: number): Response {
  const headers = privateHeaders();
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify({ error: message }), { status, headers });
}

function redirect(location: string, cookies: string[] = []): Response {
  const headers = privateHeaders();
  headers.set("Location", location);
  for (const value of cookies) headers.append("Set-Cookie", value);
  return new Response(null, { status: 303, headers });
}

function providerRequest(env: Env, ctx: ExecutionContext, path: string, init: RequestInit): Promise<Response> {
  return providerFor(env).fetch(new Request(new URL(path, env.PUBLIC_ORIGIN), init), env, ctx);
}

async function dashboardClient(env: Env, ctx: ExecutionContext): Promise<Client> {
  const key = `${PREFIX}client:${env.PUBLIC_ORIGIN}`;
  const existing = await env.OAUTH_KV.get<Client>(key, "json");
  if (existing?.id && existing.secret) return existing;
  // Confidential registration and all credential exchange stay inside the Worker.
  const response = await providerRequest(env, ctx, "/oauth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Beads Portfolio Dashboard",
      redirect_uris: [new URL("/dashboard/callback", env.PUBLIC_ORIGIN).href],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "client_secret_post",
      scope: SCOPE_READ,
    }),
  });
  if (!response.ok) throw new Error("Dashboard client registration failed");
  const body = await response.json() as { client_id?: unknown; client_secret?: unknown };
  if (typeof body.client_id !== "string" || typeof body.client_secret !== "string") {
    throw new Error("Dashboard client registration failed");
  }
  const client = { id: body.client_id, secret: body.client_secret };
  // Dynamic registrations expire after 90 idle days; rotate this cache earlier.
  await env.OAUTH_KV.put(key, JSON.stringify(client), { expirationTtl: 30 * 86400 });
  return client;
}

async function login(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!accessConfigured(env)) return failure("Dashboard sign-in is not configured", 503);
  // SameSite permits top-level navigation; reject explicit cross-site initiation.
  if (["cross-site"].includes(request.headers.get("Sec-Fetch-Site") ?? "")) return failure("Cross-site sign-in is not allowed", 403);
  const client = await dashboardClient(env, ctx);
  const browser = randomToken();
  const state = randomToken();
  const verifier = randomToken() + randomToken();
  const previous = cookie(request, STATE_COOKIE);
  if (validHandle(previous)) await env.OAUTH_KV.delete(`${PREFIX}login:${previous}`);
  await env.OAUTH_KV.put(`${PREFIX}login:${browser}`, JSON.stringify({ state, verifier, client, expires: now() + LOGIN_TTL } satisfies Login), { expirationTtl: LOGIN_TTL });
  const target = new URL("/authorize", env.PUBLIC_ORIGIN);
  target.search = new URLSearchParams({
    response_type: "code", client_id: client.id,
    redirect_uri: new URL("/dashboard/callback", env.PUBLIC_ORIGIN).href,
    scope: SCOPE_READ, state, code_challenge: await s256(verifier), code_challenge_method: "S256",
  }).toString();
  return redirect(target.href, [setCookie(STATE_COOKIE, browser, LOGIN_TTL)]);
}

async function callback(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const browser = cookie(request, STATE_COOKIE);
  const params = new URL(request.url).searchParams;
  if (!validHandle(browser)) return failure("Sign-in state is missing", 400);
  const key = `${PREFIX}login:${browser}`;
  const pending = await env.OAUTH_KV.get<Login>(key, "json");
  if (!pending || pending.expires <= now() || params.getAll("state").length !== 1 || pending.state !== params.get("state")) {
    return failure("Sign-in state is invalid or expired", 400);
  }
  await env.OAUTH_KV.delete(key);
  const clearState = setCookie(STATE_COOKIE, "", 0);
  const code = params.get("code");
  if (params.has("error") || !code || params.getAll("code").length !== 1) return redirect("/dashboard/", [clearState]);
  const issuedAt = now();
  const response = await providerRequest(env, ctx, "/oauth/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code,
      redirect_uri: new URL("/dashboard/callback", env.PUBLIC_ORIGIN).href,
      client_id: pending.client.id, client_secret: pending.client.secret, code_verifier: pending.verifier }),
  });
  if (!response.ok) {
    const denied = failure("Sign-in could not be completed", 401);
    denied.headers.append("Set-Cookie", clearState);
    return denied;
  }
  const result = await response.json() as { access_token?: unknown; expires_in?: unknown; token_type?: unknown };
  if (typeof result.access_token !== "string" || result.token_type?.toString().toLowerCase() !== "bearer" ||
    typeof result.expires_in !== "number" || !Number.isFinite(result.expires_in) || result.expires_in <= 0) {
    throw new Error("Dashboard token exchange failed");
  }
  const expires = issuedAt + Math.min(SESSION_TTL, Math.floor(result.expires_in));
  const ttl = expires - now();
  if (ttl < 60) return failure("Sign-in expired; start again", 401);
  const handle = randomToken();
  const old = cookie(request, SESSION_COOKIE);
  if (validHandle(old)) await env.OAUTH_KV.delete(`${PREFIX}session:${old}`);
  await env.OAUTH_KV.put(`${PREFIX}session:${handle}`, JSON.stringify({ token: result.access_token, expires } satisfies Session), { expirationTtl: ttl });
  return redirect("/dashboard/", [clearState, setCookie(SESSION_COOKIE, handle, ttl)]);
}

async function logout(request: Request, env: Env): Promise<Response> {
  if (request.headers.get("Origin") !== new URL(env.PUBLIC_ORIGIN).origin ||
    request.headers.get("Sec-Fetch-Site") === "cross-site") return failure("Same-origin logout is required", 403);
  const handle = cookie(request, SESSION_COOKIE);
  const pending = cookie(request, STATE_COOKIE);
  if (validHandle(handle)) await env.OAUTH_KV.delete(`${PREFIX}session:${handle}`);
  if (validHandle(pending)) await env.OAUTH_KV.delete(`${PREFIX}login:${pending}`);
  return redirect("/dashboard/", [setCookie(SESSION_COOKIE, "", 0), setCookie(STATE_COOKIE, "", 0)]);
}

async function proxy(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (request.headers.get("Sec-Fetch-Site") === "cross-site") return failure("Same-origin API access is required", 403);
  const handle = cookie(request, SESSION_COOKIE);
  if (!validHandle(handle)) return failure("Sign-in is required", 401);
  const session = await env.OAUTH_KV.get<Session>(`${PREFIX}session:${handle}`, "json");
  if (!session || session.expires <= now() || typeof session.token !== "string") return failure("Sign-in is required", 401);
  const url = new URL(request.url);
  const suffix = url.pathname.slice("/dashboard/api/".length);
  // Do not allow encoded separators to escape the protected portfolio handler.
  if (/%(?:2f|5c|2e)/i.test(suffix)) return failure("Invalid dashboard API path", 400);
  const target = new URL(`/portfolio/${suffix}`, env.PUBLIC_ORIGIN);
  target.search = url.search;
  const upstream = await providerFor(env).fetch(new Request(target, {
    headers: { Authorization: `Bearer ${session.token}`, Accept: "application/json" },
  }), env, ctx);
  const headers = privateHeaders();
  headers.set("Content-Type", upstream.headers.get("Content-Type") ?? "application/json");
  // Upstream cookies, redirect targets and authentication metadata are never exposed.
  if (upstream.status >= 300 && upstream.status < 400) return failure("Dashboard API redirect refused", 502);
  if (upstream.status === 401) {
    await env.OAUTH_KV.delete(`${PREFIX}session:${handle}`);
    headers.append("Set-Cookie", setCookie(SESSION_COOKIE, "", 0));
  }
  return new Response(upstream.body, { status: upstream.status, headers });
}

/** BFF session boundary. The existing provider alone grants identities, scopes and data access. */
export async function handleDashboardSession(request: Request, env: Env, ctx: ExecutionContext): Promise<Response | undefined> {
  const url = new URL(request.url);
  const route = url.pathname;
  if (!["/dashboard/login", "/dashboard/callback", "/dashboard/logout"].includes(route) && !route.startsWith("/dashboard/api/")) return undefined;
  if (url.origin !== new URL(env.PUBLIC_ORIGIN).origin) return failure("Dashboard origin is not permitted", 403);
  const method = route === "/dashboard/logout" ? "POST" : "GET";
  if (request.method !== method) {
    const denied = failure("Method is not allowed", 405);
    denied.headers.set("Allow", method);
    return denied;
  }
  try {
    if (route === "/dashboard/login") return await login(request, env, ctx);
    if (route === "/dashboard/callback") return await callback(request, env, ctx);
    if (route === "/dashboard/logout") return await logout(request, env);
    return await proxy(request, env, ctx);
  } catch {
    return failure("Dashboard request could not be completed", 503);
  }
}
