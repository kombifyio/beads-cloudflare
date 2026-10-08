import OAuthProvider, {
  insufficientScope,
  type OAuthProviderOptions,
  type OAuthResourceContext,
} from "@cloudflare/workers-oauth-provider";
import { handleAdmin } from "../admin/endpoint";
import { handleMcp } from "../mcp/endpoint";
import { handleTracker } from "../http/endpoint";
import { resolveExternalToken } from "./external";
import { authHandler } from "./handler";
import { effectiveScopes, SCOPE_IMPORT, SCOPE_READ, SCOPE_WRITE, SCOPES_SUPPORTED, type Principal } from "./scopes";

export type ApiContext = OAuthResourceContext<Principal>;

/** Why a request is refused for scope: the step-up response of the library, or undefined when allowed. */
export function scopeRefusal(ctx: ApiContext, needsWrite: boolean, needsImport = false): Response | undefined {
  const needed = needsImport ? [SCOPE_READ, SCOPE_WRITE, SCOPE_IMPORT] : needsWrite ? [SCOPE_READ, SCOPE_WRITE] : [SCOPE_READ];
  const held = effectiveScopes(ctx.props, ctx.auth.scope);
  return needed.every((scope) => held.includes(scope)) ? undefined : insufficientScope(ctx.auth, needed);
}

export function providerOptions(env: Env): OAuthProviderOptions<Env> {
  return {
    apiHandlers: {
      "/mcp": { fetch: (request, e, ctx) => handleMcp(request, e, ctx as unknown as ApiContext) },
      "/t/": { fetch: (request, e, ctx) => handleTracker(request, e, ctx as unknown as ApiContext) },
      "/admin/": { fetch: (request, e, ctx) => handleAdmin(request, e, ctx as unknown as ApiContext) },
    },
    defaultHandler: authHandler as unknown as ExportedHandler<Env>,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/oauth/register",
    clientIdMetadataDocumentEnabled: true,
    scopesSupported: SCOPES_SUPPORTED,
    requiredScopes: [SCOPE_READ],
    resolveExternalToken,
    accessTokenTTL: 3600,
    // Humans sign in rarely: the grant has no absolute expiry and slides 90 days from each refresh.
    refreshTokenTTL: undefined,
    refreshTokenIdleTTL: 90 * 86400,
    resourceMetadata: {
      resource: env.PUBLIC_ORIGIN,
      authorization_servers: [env.PUBLIC_ORIGIN],
    },
  };
}

let cached: { origin: string; provider: OAuthProvider<Env> } | undefined;

/** The provider is built from env (the origin is deployment configuration) once per isolate. */
export function providerFor(env: Env): OAuthProvider<Env> {
  if (cached?.origin !== env.PUBLIC_ORIGIN) {
    cached = { origin: env.PUBLIC_ORIGIN, provider: new OAuthProvider<Env>(providerOptions(env)) };
  }
  return cached.provider;
}
