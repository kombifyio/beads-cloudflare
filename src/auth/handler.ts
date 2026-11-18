// Default handler of the OAuthProvider: owns /authorize and /callback and a public liveness probe.
// Sign-in happens upstream in Cloudflare Access; this Worker is the authorization server for MCP
// and API clients, so consent is asked per client before the Access redirect.
import {
  AuthorizationError,
  authorizationErrorRedirect,
  CimdFetchError,
  type ConsentDescription,
  type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import { accessConfigured, authorizeUrl, exchangeCode, randomToken } from "./access";
import { SCOPE_READ, SCOPES_SUPPORTED, type Principal } from "./scopes";
import { exchangeGithub } from "./github";

type EnvWithProvider = Env & { OAUTH_PROVIDER: OAuthHelpers };

interface UpstreamData {
  verifier: string;
  nonce: string;
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

function consentPage(details: ConsentDescription, handle: string): string {
  const name = escapeHtml(details.clientName);
  const origin = details.clientDomain
    ? `Published by <strong>${escapeHtml(details.clientDomain)}</strong>.`
    : "This app registered itself; its name is not verified.";
  const requested = new Set(details.scope);
  const scopes = SCOPES_SUPPORTED.map((scope) => {
    const mandatory = scope === SCOPE_READ;
    const checked = mandatory || requested.has(scope) ? "checked" : "";
    // A disabled checkbox is not submitted; the read scope is added server-side.
    return `<label><input type="checkbox" name="scope" value="${escapeHtml(scope)}" ${checked} ${
      mandatory ? "disabled" : ""
    }> ${escapeHtml(scope)}</label>`;
  }).join("<br>");
  const loopback = details.redirectIsLoopback
    ? "<p><strong>This sends access to an app on your computer.</strong> Continue only if you just started signing in from it.</p>"
    : "";
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorize ${name}</title>
<style>body{font:16px system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem}button{font:inherit;padding:.5rem 1rem}</style>
<h1>Allow ${name} to use your trackers?</h1>
<p>${origin} Access will be sent to <strong>${escapeHtml(details.redirectHost)}</strong>.</p>
${loopback}
<form method="post">
  <input type="hidden" name="handle" value="${escapeHtml(handle)}">
  <p>${scopes}</p>
  <p><button name="decision" value="approve">Allow</button> <button name="decision" value="deny">Deny</button></p>
</form>`;
}

const text = (message: string, status: number) =>
  new Response(message, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });

export const authHandler = {
  async fetch(request: Request, env: EnvWithProvider): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/auth/github" && request.method === "POST") return exchangeGithub(request, env);
    try {
      if (url.pathname === "/healthz" && request.method === "GET") {
        return Response.json({ status: "ok" });
      }
      if (["/authorize", "/callback"].includes(url.pathname) && !accessConfigured(env)) {
        return text(
          "Sign-in is not configured on this deployment, so only agent API keys can be used. " +
            "An administrator can set ACCESS_ISSUER, ACCESS_CLIENT_ID and ACCESS_CLIENT_SECRET (see the README).",
          503,
        );
      }
      if (url.pathname === "/authorize" && request.method === "GET") return await showConsent(request, env);
      if (url.pathname === "/authorize" && request.method === "POST") return await decide(request, env);
      if (url.pathname === "/callback" && request.method === "GET") return await callback(request, env);
    } catch (error) {
      if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
      if (error instanceof AuthorizationError) return text(error.description ?? "Authorization failed.", 400);
      if (error instanceof CimdFetchError) return text("This app could not be verified.", 400);
      console.error("auth handler failure", error instanceof Error ? error.message : error);
      return text("Sign-in failed.", 500);
    }
    return text("Not found", 404);
  },
};

async function showConsent(request: Request, env: EnvWithProvider): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const authRequest = await oauth.parseAuthRequest(request);
  const details = await oauth.describeConsent(authRequest);
  const consent = await oauth.beginConsent(authRequest);
  consent.headers.set("Content-Type", "text/html; charset=utf-8");
  return new Response(consentPage(details, consent.handle), { headers: consent.headers });
}

async function decide(request: Request, env: EnvWithProvider): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const form = await request.formData();
  const handle = String(form.get("handle") ?? "");
  if (form.get("decision") !== "approve") {
    const denied = await oauth.denyConsent(request, handle);
    return new Response(null, { status: 302, headers: denied.headers });
  }
  const scope = [...new Set([SCOPE_READ, ...form.getAll("scope").map(String)])];
  const approved = await oauth.approveConsent(request, handle, { scope });
  const data: UpstreamData = { verifier: randomToken() + randomToken(), nonce: randomToken() };
  const { state, headers } = await oauth.beginUpstream(approved.request, { data, headers: approved.headers });
  headers.set("Location", await authorizeUrl(env, { state, ...data }));
  return new Response(null, { status: 302, headers });
}

async function callback(request: Request, env: EnvWithProvider): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const { request: original, data, headers } = await oauth.finishUpstream<UpstreamData>(request);
  const params = new URL(request.url).searchParams;
  const code = params.get("code");
  if (params.get("error") || !code) {
    headers.set("Location", authorizationErrorRedirect(original, "access_denied"));
    return new Response(null, { status: 302, headers });
  }
  const identity = await exchangeCode(env, { code, verifier: data.verifier, nonce: data.nonce });
  const props: Principal = { sub: identity.sub, email: identity.email, name: identity.name };
  const { redirectTo } = await oauth.completeAuthorization({
    request: original,
    userId: encodeURIComponent(identity.sub),
    metadata: { label: identity.name },
    scope: original.scope,
    props,
  });
  headers.set("Location", redirectTo);
  return new Response(null, { status: 302, headers });
}
