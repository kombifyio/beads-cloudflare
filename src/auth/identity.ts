import type { Principal } from "./scopes";

/** The caller's own verified identity, separate from its asserted worker/display name. */
export function inspectIdentity(principal: Principal, workerActor?: string, expiresAt?: number) {
  return {
    verified_principal: { subject: principal.sub, email: principal.email, name: principal.name, kind: principal.kind ?? "oauth" },
    worker_actor: workerActor ?? null,
    authorized_trackers: principal.trackers ?? null,
    ...(expiresAt !== undefined ? { credential_expires_at: new Date(expiresAt * 1000).toISOString() } : {}),
    worker_actor_is_authorization: false,
  };
}
