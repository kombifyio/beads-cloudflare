// Credentials this server resolves itself, beside OAuth tokens: agent API keys and the admin token.
// The OAuth provider calls this only after its own token lookup fails.
import type { ResolveExternalTokenInput, ResolveExternalTokenResult } from "@cloudflare/workers-oauth-provider";
import { storeFor } from "../http/endpoint";
import { parseKey, secretsMatch } from "../tracker/keys";
import { sha256Hex } from "../tracker/util";
import type { Principal } from "./scopes";

const ADMIN_PRINCIPAL: Principal = { sub: "admin-token", email: "admin-token", name: "admin token", kind: "admin-token" };

export async function resolveExternalToken({ token, request, env }: ResolveExternalTokenInput<Env>): Promise<ResolveExternalTokenResult | null> {
  const path = new URL(request.url).pathname;

  // The admin token is for key management only: it is recognized on /admin/* and nowhere else.
  if ((path === "/admin" || path.startsWith("/admin/")) && env.ADMIN_TOKEN && (await secretsMatch(token, env.ADMIN_TOKEN))) {
    return { props: ADMIN_PRINCIPAL, audience: env.PUBLIC_ORIGIN };
  }

  const key = parseKey(token);
  if (!key) return null;
  const principal = await storeFor(env).authenticateKey(key.id, await sha256Hex(key.secret));
  return principal ? { props: principal, audience: env.PUBLIC_ORIGIN } : null;
}
