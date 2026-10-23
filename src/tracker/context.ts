import type { components } from "../generated/openapi.v0";
import { STORE_VERSION } from "../version";

type ContextResponse = components["schemas"]["ContextResponse"];

/** The upstream release whose /v0 contract this server profiles. */
export const UPSTREAM_VERSION = "1.3.1";

// Operation tokens follow the PATH, one per implemented operation; only what is fully implemented is listed.
const OPERATION_TOKENS = [
  "config.get",
  "config.list",
  "config.set",
  "config.unset",
  "dependencies.add",
  "dependencies.blocking",
  "dependencies.count",
  "dependencies.cycles",
  "dependencies.list",
  "dependencies.remove",
  "dependencies.tree",
  "events.list",
  "issues.addComment",
  "issues.batchApply",
  "issues.batchClose",
  "issues.batchCreate",
  "issues.casMetadata",
  "issues.claim",
  "issues.claimNext",
  "issues.close",
  "issues.count",
  "issues.create",
  "issues.delete",
  "issues.get",
  "issues.list",
  "issues.query",
  "issues.related",
  "issues.release",
  "issues.reopen",
  "issues.sweep",
  "issues.update",
  "memories.forget",
  "memories.get",
  "memories.list",
  "memories.remember",
  "ready.count",
  "ready.list",
  "stats.get",
];

// Behavior tokens: `project.enforce` is upstream's; the `profile.*` ones declare this profile's extensions.
const BEHAVIOR_TOKENS = [
  "profile.actionable_work",
  "profile.apply_batch_extensions",
  "profile.batch_close_fencing",
  "profile.batch_comment_id",
  "profile.beads-cloudflare",
  "profile.claim_inspection",
  "profile.claim_lock_v1",
  "profile.config_post",
  "profile.dependencies_export",
  "profile.heartbeat",
  "profile.idempotency_key",
  "profile.identity_inspection",
  "profile.import",
  "profile.import_merge",
  "profile.import_migration_guard_v1",
  "profile.issues_export",
  "profile.lease",
  "profile.leases_reclaim",
  "profile.logical_recovery_v1",
  "profile.optimistic_concurrency",
  "profile.rejected_write_outcome",
  "profile.x_extra",
  "project.enforce",
];

export const CAPABILITIES = [...OPERATION_TOKENS, ...BEHAVIOR_TOKENS].sort();

/**
 * The oldest bd (the Go backend in bd/) this store still serves. A store only raises it in a minor or major
 * release, never in a patch release, and never above that release's own MAJOR.MINOR.0, so an installed bd of the
 * same minor line keeps working across every store upgrade. See docs/compatibility.md.
 */
export const MIN_CLIENT_VERSION = "0.1.0";

/** The context document plus this profile's version members (extension members, prefixed `x_`). */
export type StoreContext = ContextResponse & { x_store_version: string; x_min_client_version: string; x_mutation_revision: number };

export function contextFor(tracker: string, projectId: string = tracker, mutationRevision = 0): StoreContext {
  return {
    api_version: "v0",
    bd_version: UPSTREAM_VERSION,
    schema_version: 1,
    backend: "cloudflare",
    dolt_mode: "",
    database: "",
    project_id: projectId,
    capabilities: CAPABILITIES,
    x_store_version: STORE_VERSION,
    x_min_client_version: MIN_CLIENT_VERSION,
    x_mutation_revision: mutationRevision,
  };
}
