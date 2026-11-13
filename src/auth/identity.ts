import type { Principal } from "./scopes";

/** The caller's own verified identity, separate from its asserted worker/display name. */
export function inspectIdentity(principal: Principal, workerActor?: string, expiresAt?: number) {
  const credentialExpiresAt = principal.kind === "key"
    ? principal.credentialExpiresAt
    : expiresAt === undefined ? null : new Date(expiresAt * 1000).toISOString();
  return {
    claim_ownership_subject: principal.sub,
    verified_principal: { subject: principal.sub, email: principal.email, name: principal.name, kind: principal.kind ?? "oauth" },
    worker_actor: workerActor ?? null,
    authorized_trackers: principal.trackers ?? null,
    ...(credentialExpiresAt !== null ? { credential_expires_at: credentialExpiresAt } : {}),
    worker_actor_is_authorization: false,
  };
}
