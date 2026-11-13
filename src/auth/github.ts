// Portable repository authorization. GitHub credentials never enter storage or error responses.
import { respond, storeFor } from "../http/endpoint";
import { readBoundedBody } from "../http/body";
import { SCOPE_IMPORT, SCOPE_READ, SCOPE_WRITE } from "./scopes";
import { reusableKey } from "../tracker/keys";
import { SCOPE_MERGE_CLOSE, mergeProofDigest, verifyMergeProof } from "./merge-close";
import { invalid, problemOut, Refusal, refuse } from "../tracker/problem";
import { isObject, isTrackerId } from "../tracker/util";

const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/;
// Twelve-hour issuance windows keep GitHub off the hot path: one verification per
// host and binding per window, and a client renewing at half-life outlasts a spent
// REST budget (it resets hourly) on the credential it already holds.
const WINDOW_MS = 12 * 3600_000;
const READER_WINDOW_MS = 59 * 60_000;
const OIDC_ISSUER = "https://token.actions.githubusercontent.com";
interface OidcPolicy { repository_id: string; workflow_refs: string[]; read_only_workflows?: string[] }
interface AppReadPolicy { app_id: string; installation_id: string; repositories: string[] }
interface WorkflowReader { workflow_ref: string; repository_owner_id: string; repository: string; tracker: string; events?: string[] }
interface EnvironmentReader extends WorkflowReader { environment: string }
interface AdmissionReader extends WorkflowReader { job_workflow_ref: string }
type PortfolioReader = string | WorkflowReader | EnvironmentReader | AdmissionReader;
/** String readers retain portfolio access; object grants bind a direct or reusable caller to one target. */
interface RepositoryPolicy { trackers: string[]; import?: boolean; oidc?: OidcPolicy; portfolio_readers?: PortfolioReader[]; portfolio_writers?: PortfolioReader[] }

/** Exact main-branch workflow refs of one repository; throws on anything else. */
function mainWorkflowRefs(repository: string, list: unknown): string[] {
  if (!Array.isArray(list) || list.length === 0 || list.length > 100) throw new Error();
  // Relative refs and bare main-branch file names save binding space in larger fleets
  // (Cloudflare caps text bindings at 5120 bytes), but still authorize one exact repo/file/ref.
  const refs: unknown[] = list.map((ref) => typeof ref !== "string" ? ref
    : /^[A-Za-z0-9_.-]+\.ya?ml$/.test(ref) ? `${repository}/.github/workflows/${ref}@refs/heads/main`
    : ref.startsWith(".github/workflows/") ? `${repository}/${ref}` : ref);
  if (refs.some((ref) => typeof ref !== "string" ||
      !ref.startsWith(`${repository}/.github/workflows/`) || !ref.endsWith("@refs/heads/main") ||
      !/^[A-Za-z0-9_.-]+\.ya?ml$/.test(ref.slice(`${repository}/.github/workflows/`.length, -"@refs/heads/main".length)))) throw new Error();
  return refs as string[];
}

function readerGrants(repository: string, list: unknown): PortfolioReader[] {
  if (!Array.isArray(list) || list.length === 0 || list.length > 100) throw new Error();
  const grants = list.map((grant): PortfolioReader => {
    if (typeof grant === "string") return mainWorkflowRefs(repository, [grant])[0]!;
    if (!isObject(grant) || !(["repository,repository_owner_id,tracker,workflow_ref", "environment,repository,repository_owner_id,tracker,workflow_ref", "job_workflow_ref,repository,repository_owner_id,tracker,workflow_ref"].includes(Object.keys(grant).filter(key => key !== "events").sort().join())) ||
        typeof grant.repository !== "string" || !REPOSITORY.test(grant.repository) || !isTrackerId(grant.tracker) ||
        typeof grant.repository_owner_id !== "string" || !/^[1-9][0-9]{0,19}$/.test(grant.repository_owner_id) ||
        (!("job_workflow_ref" in grant) && grant.events === undefined && grant.repository !== repository)) throw new Error();
    if (grant.events !== undefined && (!Array.isArray(grant.events) || grant.events.length === 0 ||
        grant.events.some(event => typeof event !== "string" || !["workflow_dispatch", "schedule", "workflow_run"].includes(event)))) throw new Error();
    const reader: WorkflowReader = { workflow_ref: mainWorkflowRefs(repository, [grant.workflow_ref])[0]!,
      repository_owner_id: grant.repository_owner_id, repository: grant.repository, tracker: grant.tracker, ...(grant.events ? { events: Array.isArray(grant.events) ? grant.events.map(String) : [] } : {}) };
    if ("environment" in grant) {
      if (typeof grant.environment !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(grant.environment)) throw new Error();
      return { ...reader, environment: grant.environment };
    }
    if (!("job_workflow_ref" in grant)) return reader;
    if (typeof grant.job_workflow_ref !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}\/\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml@[0-9a-f]{40}$/.test(grant.job_workflow_ref)) throw new Error();
    return { ...reader, job_workflow_ref: grant.job_workflow_ref };
  });
  // A broad grant for the same caller must never shadow a targeted admission.
  for (const grant of grants) if (typeof grant !== "string" &&
      grants.filter(g => (typeof g === "string" ? g : g.workflow_ref) === grant.workflow_ref).length !== 1) throw new Error();
  return grants;
}

/**
 * Expands the compact workflow grant binding into the repository policy before validation, so every grant passes the
 * same checks as one written inline. The owner, target repository and tracker are stated once; each caller repository
 * maps its exact main-branch workflow file names to reader events, or to writer events and an optional pinned
 * job_workflow_ref. The caller must already be mapped, and the target must map the tracker.
 */
function addWorkflowGrants(parsed: Record<string, unknown>, raw: string): void {
  if (!raw) return;
  if (new TextEncoder().encode(raw).byteLength > 5120) throw new Error();
  const compact: unknown = JSON.parse(raw);
  if (!isObject(compact) || Object.keys(compact).some((key) => !["repository_owner_id", "repository", "tracker", "readers", "writers"].includes(key)) ||
      typeof compact.repository !== "string" || (compact.readers === undefined && compact.writers === undefined)) throw new Error();
  const target = Object.hasOwn(parsed, compact.repository) ? parsed[compact.repository] : undefined;
  if (!isObject(target) || !Array.isArray(target.trackers) || !target.trackers.includes(compact.tracker)) throw new Error();
  for (const [kind, field] of [["readers", "portfolio_readers"], ["writers", "portfolio_writers"]] as const) {
    const callers = compact[kind];
    if (callers === undefined) continue;
    if (!isObject(callers) || Object.keys(callers).length === 0 || Object.keys(callers).length > 100) throw new Error();
    for (const [repository, workflows] of Object.entries(callers)) {
      const policy = Object.hasOwn(parsed, repository) ? parsed[repository] : undefined;
      if (!isObject(policy) || !isObject(workflows) || Object.keys(workflows).length === 0 || Object.keys(workflows).length > 100 ||
          (policy[field] !== undefined && !Array.isArray(policy[field]))) throw new Error();
      const grants = Object.entries(workflows).map(([workflow, value]) => {
        const grant: unknown = kind === "readers" ? { events: value } : value;
        if (!/^[A-Za-z0-9_.-]+\.ya?ml$/.test(workflow) || !isObject(grant) ||
            !["events", "events,job_workflow_ref"].includes(Object.keys(grant).sort().join()) ||
            !Array.isArray(grant.events) || new Set(grant.events).size !== grant.events.length) throw new Error();
        return { workflow_ref: workflow, repository_owner_id: compact.repository_owner_id, repository: compact.repository,
          tracker: compact.tracker, events: grant.events, ...("job_workflow_ref" in grant ? { job_workflow_ref: grant.job_workflow_ref } : {}) };
      });
      policy[field] = [...((policy[field] as unknown[] | undefined) ?? []), ...grants];
    }
  }
}

function policies(raw: string, workflowGrants: string): Record<string, RepositoryPolicy> {
  try {
    if (raw.length > 128 * 1024) throw new Error();
    const parsed: unknown = JSON.parse(raw);
    if (!isObject(parsed) || Object.keys(parsed).length > 1000) throw new Error();
    addWorkflowGrants(parsed, workflowGrants);
    for (const [repository, policy] of Object.entries(parsed)) {
      if (!REPOSITORY.test(repository) || !isObject(policy) ||
        Object.keys(policy).some((key) => !["trackers", "import", "oidc", "portfolio_readers", "portfolio_writers"].includes(key)) ||
        !Array.isArray(policy.trackers) || policy.trackers.length === 0 || policy.trackers.length > 100 ||
        policy.trackers.some((tracker) => !isTrackerId(tracker)) ||
        (policy.import !== undefined && typeof policy.import !== "boolean")) throw new Error();
      if (policy.oidc !== undefined) {
        const oidc = policy.oidc;
        if (!isObject(oidc) || Object.keys(oidc).some((key) => !["repository_id", "workflow_refs", "read_only_workflows"].includes(key)) ||
          typeof oidc.repository_id !== "string" || !/^[1-9][0-9]{0,19}$/.test(oidc.repository_id)) throw new Error();
        oidc.workflow_refs = mainWorkflowRefs(repository, oidc.workflow_refs);
        // A read-only workflow is still an admitted writer ref, but every job of it exchanges
        // read scopes only. Listing an unadmitted ref would claim a ceiling that can never apply.
        if (oidc.read_only_workflows !== undefined) {
          const readOnly = mainWorkflowRefs(repository, oidc.read_only_workflows);
          const admitted = oidc.workflow_refs as string[];
          if (readOnly.some((ref) => !admitted.includes(ref))) throw new Error();
          oidc.read_only_workflows = readOnly;
        }
      }
      // A portfolio reader is bound to this repository's immutable ID, so it needs the oidc entry.
      if (policy.portfolio_readers !== undefined) {
        if (policy.oidc === undefined) throw new Error();
        policy.portfolio_readers = readerGrants(repository, policy.portfolio_readers);
      }
      if (policy.portfolio_writers !== undefined) {
        if (policy.oidc === undefined) throw new Error();
        const grants = readerGrants(repository, policy.portfolio_writers);
        // Writers always name one tracker and explicit events; broad string grants cannot write.
        if (grants.some(grant => typeof grant === "string" || !grant.events || "environment" in grant)) throw new Error();
        policy.portfolio_writers = grants;
      }
    }
    return parsed as unknown as Record<string, RepositoryPolicy>;
  } catch {
    throw refuse("internal", "GitHub repository authorization is not configured correctly.");
  }
}

/**
 * Trackers a signed-in human (an OAuth grant) may use: every tracker the repository policy maps, so
 * MCP and API sign-in reach exactly the stores the credential exchange can issue for. An empty policy
 * leaves sign-in unrestricted (single-team installations); a malformed one denies every tracker.
 */
export function signedInTrackers(env: Env): string[] | undefined {
  let mapped: Record<string, RepositoryPolicy>;
  try { mapped = policies(env.GITHUB_REPOSITORIES || "{}", env.GITHUB_WORKFLOW_GRANTS ?? ""); } catch { return []; }
  const trackers = [...new Set(Object.values(mapped).flatMap((policy) => policy.trackers))];
  return trackers.length > 0 ? trackers : undefined;
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

function mergeClosePolicy(raw: string): { repository: string; workflow_ref: string; repository_owner_id: string } {
  try {
    if (new TextEncoder().encode(raw).byteLength > 5120) throw new Error();
    const grant: unknown = JSON.parse(raw);
    if (!isObject(grant) || Object.keys(grant).sort().join() !== "repository,repository_owner_id,workflow_ref" ||
        typeof grant.repository !== "string" || !REPOSITORY.test(grant.repository) ||
        typeof grant.repository_owner_id !== "string" || !/^[1-9][0-9]{0,19}$/.test(grant.repository_owner_id)) throw new Error();
    return { repository: grant.repository, repository_owner_id: grant.repository_owner_id,
      workflow_ref: mainWorkflowRefs(grant.repository, [grant.workflow_ref])[0]! };
  } catch { throw refuse("forbidden", "A configured merge workflow identity is required."); }
}

/**
 * A signed, valid GitHub Actions token whose claims the policy does not admit. It is raised only after the signature
 * verified, so it names the claim and the caller's own value (which the token already states) and the policy binding
 * to edit, never the admitted values.
 */
class NotAdmitted extends Error {
  constructor(readonly claim: string, message: string) { super(message); }
}
const shown = (value: unknown) => typeof value === "string" ? JSON.stringify(value.slice(0, 200)) : "(absent)";

/** The same RS256 WebCrypto verification used for Access sign-in, with fixed GitHub trust roots. */
async function oidcIdentity(token: string, repository: string, policy: OidcPolicy | undefined, audience: string,
  readTarget?: { repository: string; tracker: string; grants: PortfolioReader[]; required: boolean }, mergeOwner?: string, workflowWriter = false,
  // Where an operator admits this route's workflow; the workflow_ref refusal names exactly this binding.
  workflowBinding?: string): Promise<{ subject: string; readOnly: boolean }> {
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
    if (!isObject(claims)) throw new Error();
    const now = Date.now() / 1000;
    const [owner, name] = repository.split("/");
    // An exact read-only workflow keeps its read ceiling on every job, environment or not.
    const forcedReadOnly = policy.read_only_workflows?.includes(claims.workflow_ref as string) === true;
    const candidate = readTarget?.grants.find(g => (typeof g === "string" ? g : g.workflow_ref) === claims.workflow_ref);
    const grantEnvironment = candidate && typeof candidate !== "string" && "environment" in candidate ? candidate.environment : undefined;
    // A forced read-only job without the protected environment binds the plain main ref and
    // does not need that environment grant's admission claims; the grant stays required for the
    // explicit reader route and for every writer.
    const grant: PortfolioReader | undefined = forcedReadOnly && grantEnvironment && claims.environment !== grantEnvironment ? undefined : candidate;
    const environment = grantEnvironment && claims.environment === grantEnvironment ? grantEnvironment : undefined;
    const subjectSuffix = environment ? `environment:${environment}` : "ref:refs/heads/main";
    if (grantEnvironment && claims.environment !== grantEnvironment && !forcedReadOnly) throw new Error();
    // GitHub's current default embeds immutable IDs in subjects for newer repositories.
    // Environment subjects are admitted only by an exact protected reader grant, never a writer.
    const subjectAllowed = claims.sub === `repo:${repository}:${subjectSuffix}` ||
      (typeof claims.repository_owner_id === "string" && /^[1-9][0-9]{0,19}$/.test(claims.repository_owner_id) &&
        claims.sub === `repo:${owner}@${claims.repository_owner_id}/${name}@${policy.repository_id}:${subjectSuffix}`);
    // Each check names the first claim that is not admitted; the order is not significant.
    const binding = `the oidc policy of the GITHUB_REPOSITORIES binding for ${shown(repository)}`;
    if (claims.iss !== OIDC_ISSUER) throw new NotAdmitted("iss", `The token issuer ${shown(claims.iss)} is not GitHub Actions; send a GitHub Actions OIDC token.`);
    if (claims.aud !== audience) throw new NotAdmitted("aud", `The token audience ${shown(claims.aud)} is not this store's public origin; request the token with that origin as its audience (PUBLIC_ORIGIN).`);
    if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp) || claims.exp <= now ||
      typeof claims.iat !== "number" || !Number.isFinite(claims.iat) || claims.iat > now + 60 || claims.iat < now - 600 ||
      typeof claims.nbf !== "number" || !Number.isFinite(claims.nbf) || claims.nbf > now + 60) {
      throw new NotAdmitted("exp", "The token is expired or was issued too long ago; request a fresh GitHub Actions OIDC token and exchange it within ten minutes.");
    }
    if (claims.repository !== repository) throw new NotAdmitted("repository", `The token is for repository ${shown(claims.repository)}, but the exchange asked for ${shown(repository)}; send the token of the repository named in the request.`);
    if (claims.repository_id !== policy.repository_id) throw new NotAdmitted("repository_id", `The token's repository_id ${shown(claims.repository_id)} is not the immutable id recorded in ${binding}; the repository was renamed or recreated, or the binding has a wrong id.`);
    if (claims.ref !== "refs/heads/main") throw new NotAdmitted("ref", `The run is on ${shown(claims.ref)}; only runs on refs/heads/main are admitted.`);
    if (!subjectAllowed) throw new NotAdmitted("sub", `The token subject ${shown(claims.sub)} is not the main-branch subject of the repository (or of the protected environment a reader grant names).`);
    if (typeof claims.workflow_ref !== "string" || !policy.workflow_refs.includes(claims.workflow_ref)) {
      throw new NotAdmitted("workflow_ref", `The workflow ${shown(claims.workflow_ref)} is not admitted for this route. ${workflowBinding ?? `Add it to the workflow refs of ${binding} (or a GITHUB_WORKFLOW_GRANTS entry for this repository)`}, then redeploy the configuration.`);
    }
    if (!(typeof candidate !== "string" && candidate?.events ? candidate.events : ["push", "workflow_dispatch", "schedule"]).includes(String(claims.event_name))) {
      throw new NotAdmitted("event_name", `The event ${shown(claims.event_name)} is not admitted for this workflow; admit it with an events list on its grant (the default is push, workflow_dispatch and schedule).`);
    }
    if ((claims.head_ref !== undefined && claims.head_ref !== "") || (claims.base_ref !== undefined && claims.base_ref !== "")) {
      throw new NotAdmitted("head_ref", "Pull request runs are never admitted; run the workflow from the main branch.");
    }
    if (mergeOwner) {
      if (claims.repository_owner_id !== mergeOwner || !["schedule", "workflow_dispatch"].includes(String(claims.event_name)) ||
          claims.run_attempt !== "1" || typeof claims.sha !== "string" || !/^[0-9a-f]{40}$/.test(claims.sha) ||
          claims.workflow_sha !== claims.sha || typeof claims.run_id !== "string" || !/^[1-9][0-9]*$/.test(claims.run_id) ||
          // GitHub always signs job_workflow_ref/job_workflow_sha; a direct (non-reusable) merge job names its own workflow at the run's source.
          claims.job_workflow_ref !== claims.workflow_ref || claims.job_workflow_sha !== claims.sha || claims.environment !== undefined) throw new Error();
      return { subject: `github-exchange:oidc-merge:${policy.repository_id}:${claims.workflow_ref}:${claims.sha}:${claims.run_id}`, readOnly: false };
    }
    if (workflowWriter && (forcedReadOnly || claims.environment !== undefined ||
        typeof claims.run_id !== "string" || !/^[1-9][0-9]*$/.test(claims.run_id) ||
        (!candidate || typeof candidate === "string") ||
        (!("job_workflow_ref" in candidate) &&
          (claims.job_workflow_ref !== claims.workflow_ref || claims.job_workflow_sha !== claims.sha)))) throw new Error();
    let admission = "";
    if (readTarget) {
      if (!grant && readTarget.required) throw new Error();
      if (grant && typeof grant !== "string") {
        // Caller main can advance; both signed source claims must describe that same revision.
        if (grant.repository !== readTarget.repository || grant.tracker !== readTarget.tracker ||
            claims.repository_owner_id !== grant.repository_owner_id ||
            !(grant.events ?? ["workflow_dispatch"]).includes(String(claims.event_name)) ||
            (grant.events?.some(event => event === "schedule" || event === "workflow_run") ? !/^[1-9][0-9]*$/.test(String(claims.run_attempt)) : claims.run_attempt !== "1") ||
            typeof claims.sha !== "string" || !/^[0-9a-f]{40}$/.test(claims.sha) ||
            claims.workflow_sha !== claims.sha) throw new Error();
        admission = `:admission:${claims.sha}`;
        if (environment) admission += `:environment:${environment}`;
        if ("job_workflow_ref" in grant) {
          const jobWorkflowRef = (grant as AdmissionReader).job_workflow_ref;
          const jobSha = jobWorkflowRef.slice(-40);
          if (claims.job_workflow_ref !== jobWorkflowRef || claims.job_workflow_sha !== jobSha) throw new Error();
          admission += `:${jobSha}`;
        }
      }
      return { subject: `github-exchange:oidc:${policy.repository_id}:${claims.workflow_ref}${admission}`, readOnly: Boolean(grant) || forcedReadOnly };
    }
    return { subject: `github-exchange:oidc:${policy.repository_id}:${claims.workflow_ref}`, readOnly: forcedReadOnly };
  } catch (error) {
    if (error instanceof NotAdmitted) {
      throw refuse("forbidden", error.message, { reason: "oidc_claim_not_admitted", x_claim: error.claim });
    }
    throw refuse("forbidden", "The GitHub Actions identity could not be verified or does not match the policy of this repository: send a valid GitHub Actions OIDC token for it (audience: this store's public origin) from a workflow on the main branch that the repository's oidc policy admits.");
  }
}

/** Lifetime is one to two windows (12-24 h): every exchange in a window reuses one key,
 * and a renewal at half-life always lands in a later window and receives a new key. */
export const githubCredentialExpiry = (now: number): string =>
  new Date((Math.floor(now / WINDOW_MS) + 2) * WINDOW_MS + 60_000).toISOString();

/** App readers verify against the App's own REST budget, and their clients accept at most one hour; portfolio readers share the window. */
export const appReaderCredentialExpiry = (now: number): string =>
  new Date((Math.floor(now / READER_WINDOW_MS) + 1) * READER_WINDOW_MS + 60_000).toISOString();

/** The non-interactive credentials this store admits, named in the refusals a headless caller meets. */
const headlessRoutes = (appReaderConfigured: boolean) => "Non-interactive routes this store admits: a GitHub user access token (a personal access token or `gh auth token`) of a user with push access to the repository; a GitHub Actions OIDC token (`credential_type` unset) of a main-branch workflow named in the repository's oidc policy; " +
  (appReaderConfigured ? "an agent API key an operator issues with POST /admin/keys; and, read-only, the configured GitHub App's own App JWT (`credential_type` \"github-app\")." : "and an agent API key an operator issues with POST /admin/keys.");

/** Bound buffering before parsing, including bodies whose Content-Length is absent or false. */
async function boundedJson(body: Request | Response, limit: number): Promise<unknown> {
  return JSON.parse(new TextDecoder().decode(await readBoundedBody(body, limit)));
}

async function github(path: string, token: string, routes: string): Promise<unknown> {
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
    throw refuse("forbidden", `GitHub could not verify this credential (it is invalid, expired, rate limited or lacks access to the repository). ${routes}`);
  }
}

export async function exchangeGithub(request: Request, env: Env): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const policy = policies(env.GITHUB_REPOSITORIES ?? "{}", env.GITHUB_WORKFLOW_GRANTS ?? "");
    const routes = headlessRoutes(Boolean(env.GITHUB_READ_APP?.trim()));
    const match = /^Bearer ([A-Za-z0-9_.-]{1,16384})$/i.exec(request.headers.get("Authorization") ?? "");
    if (!match) throw refuse("unauthenticated", `A GitHub credential is required in the Authorization header. ${routes}`);
    if (request.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
      throw invalid("Content-Type", "This operation accepts application/json only.");
    }
    let body: unknown;
    try { body = await boundedJson(request, 4096); }
    catch { throw invalid(undefined, "Send a JSON object containing repository and tracker, at most 4096 bytes."); }
    if (!isObject(body) || Object.keys(body).some((key) => !["repository", "tracker", "credential_type", "reader", "merge_proof"].includes(key)) ||
      (body.credential_type !== undefined && body.credential_type !== "github-app" && body.credential_type !== "github-portfolio-reader" && body.credential_type !== "github-workflow-writer" && body.credential_type !== "github-merge-closure") ||
      ((["github-portfolio-reader", "github-workflow-writer", "github-merge-closure"].includes(String(body.credential_type))) !== (body.reader !== undefined)) ||
      (body.credential_type !== "github-merge-closure" && body.merge_proof !== undefined) ||
      (body.reader !== undefined && (typeof body.reader !== "string" || !REPOSITORY.test(body.reader))) ||
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
    const portfolioRead = body.credential_type === "github-portfolio-reader";
    const workflowWrite = body.credential_type === "github-workflow-writer";
    let workflowRead = false;
    let mergeAdmission: string | undefined;
    const mergeClose = body.credential_type === "github-merge-closure";
    if (mergeClose) {
      const reader = String(body.reader);
      const caller = Object.hasOwn(policy, reader) ? policy[reader] : undefined;
      const grant = mergeClosePolicy(env.GITHUB_MERGE_CLOSER ?? "");
      if (!caller?.oidc || grant.repository !== reader || caller.oidc.workflow_refs.includes(grant.workflow_ref) || token.split(".").length !== 3) throw refuse("forbidden", "A configured merge workflow identity is required.");
      const verified = body.merge_proof === undefined ? undefined : await verifyMergeProof(env.COOKIE_ENCRYPTION_KEY, body.merge_proof);
      if (verified && (verified.proof.tracker_repository !== repository || verified.proof.tracker !== tracker)) throw refuse("forbidden", "Merge proof target does not match the requested repository and tracker.");
      const identity = await oidcIdentity(token, reader, { repository_id: caller.oidc.repository_id,
        workflow_refs: [grant.workflow_ref] }, env.PUBLIC_ORIGIN, undefined, grant.repository_owner_id, false,
        `Only the workflow_ref of the GITHUB_MERGE_CLOSER binding is admitted here; change that binding (never the oidc workflow refs of the GITHUB_REPOSITORIES entry for ${shown(reader)}, which must not list the merge workflow)`);
      mergeAdmission = identity.subject;
      // Receipts belong to this exact workflow/proof across key renewal; source/run still bind the key.
      const mergePrincipal = identity.subject.replace(/:[0-9a-f]{40}:[1-9][0-9]*$/, "");
      subject = verified ? `${mergePrincipal}:merge-proof:${await mergeProofDigest(verified.proof)}` : `${identity.subject}:preflight`;
    } else if (workflowWrite) {
      const caller = String(body.reader);
      const grant = Object.hasOwn(policy, caller) ? policy[caller] : undefined;
      if (!grant?.oidc || !grant.portfolio_writers || token.split(".").length !== 3) {
        throw refuse("forbidden", "An exact workflow writer grant and GitHub Actions identity are required.");
      }
      const identity = await oidcIdentity(token, caller, { ...grant.oidc,
        workflow_refs: grant.portfolio_writers.map(g => typeof g === "string" ? g : g.workflow_ref) }, env.PUBLIC_ORIGIN,
        { repository, tracker, grants: grant.portfolio_writers, required: true }, undefined, true,
        `Add it to the portfolio_writers grants of the GITHUB_REPOSITORIES entry for ${shown(caller)}`);
      subject = identity.subject.replace("github-exchange:oidc:", "github-exchange:oidc-writer:");
    } else if (portfolioRead) {
      // The reader's own immutable repository ID and exact reader workflows authenticate it; the
      // requested repository/tracker mapping above still bounds what it reads, and it never writes.
      const reader = body.reader as string;
      const grant = Object.hasOwn(policy, reader) ? policy[reader] : undefined;
      if (!grant?.oidc || !grant.portfolio_readers || token.split(".").length !== 3) {
        throw refuse("forbidden", "A configured portfolio reader workflow and its GitHub Actions identity are required.");
      }
      const identity = await oidcIdentity(token, reader, { repository_id: grant.oidc.repository_id,
        workflow_refs: grant.portfolio_readers.map(g => typeof g === "string" ? g : g.workflow_ref) }, env.PUBLIC_ORIGIN,
        { repository, tracker, grants: grant.portfolio_readers, required: true }, undefined, false,
        `Add it to the portfolio_readers grants of the GITHUB_REPOSITORIES entry for ${shown(reader)}`);
      subject = identity.subject.replace("github-exchange:oidc:", "github-exchange:oidc-reader:");
    } else if (appRead) {
      const reader = appReadPolicy(env.GITHUB_READ_APP ?? "");
      if (!reader?.repositories.includes(repository) || token.split(".").length !== 3) {
        throw refuse("forbidden", "A configured GitHub App reader and its App JWT are required.");
      }
      // GitHub verifies the App JWT's signature and expiry. Repository membership
      // uses the existing exact owner/name mapping; App and installation IDs are immutable.
      const app = await github("/app", token, routes);
      if (!isObject(app) || !Number.isSafeInteger(app.id) || String(app.id) !== reader.app_id) {
        throw refuse("forbidden", "The GitHub App is not an authorized reader.");
      }
      const installation = await github(`/repos/${repository}/installation`, token, routes);
      if (!isObject(installation) || !Number.isSafeInteger(installation.id) ||
        String(installation.id) !== reader.installation_id ||
        !Number.isSafeInteger(installation.app_id) || String(installation.app_id) !== reader.app_id ||
        installation.suspended_at !== null) {
        throw refuse("forbidden", "The GitHub App installation is not an authorized reader for this repository.");
      }
      subject = `github-exchange:app:${app.id}:installation:${installation.id}`;
    } else if (token.split(".").length === 3) {
      // A same-repository reader grant is a ceiling, even if the caller asks
      // through the ordinary exchange while its workflow remains admitted there.
      const identity = await oidcIdentity(token, repository, configured.oidc, env.PUBLIC_ORIGIN,
        { repository, tracker, required: false, grants: (configured.portfolio_readers ?? []).filter(
          (grant) => typeof grant !== "string" && !("job_workflow_ref" in grant)) });
      workflowRead = identity.readOnly;
      subject = workflowRead ? identity.subject.replace("github-exchange:oidc:", "github-exchange:oidc-reader:") : identity.subject;
    } else {
      // An App installation token has no user identity to bind a credential to, and is not admitted for writes.
      if (/^ghs_/.test(token)) {
        throw refuse("forbidden", `A GitHub App installation token cannot be exchanged for write access: it carries no stable user or workflow identity. ${routes}`, { reason: "installation_token_not_admitted" });
      }
      const repo = await github(`/repos/${repository}`, token, routes);
      if (!isObject(repo) || repo.full_name !== repository || !isObject(repo.permissions) || repo.permissions.push !== true) {
        throw refuse("forbidden", "GitHub repository write permission is required.");
      }
      // Stable user identity bounds issuance across PATs. Installation tokens cannot establish it.
      const user = await github("/user", token, routes);
      if (!isObject(user) || !Number.isSafeInteger(user.id) || (user.id as number) <= 0) {
        throw refuse("forbidden", `A verified GitHub user credential is required: this token has no user identity. ${routes}`);
      }
      subject = `github-exchange:${user.id}`;
    }
    const readOnly = appRead || portfolioRead || workflowRead;
    const scopes = mergeClose ? [SCOPE_READ, ...(body.merge_proof === undefined ? [] : [SCOPE_MERGE_CLOSE])] : workflowWrite ? [SCOPE_READ, SCOPE_WRITE] : readOnly ? [SCOPE_READ] : [SCOPE_READ, SCOPE_WRITE, ...(configured.import === true ? [SCOPE_IMPORT] : [])];
    const expiresAt = workflowWrite ? new Date(Date.now() + 15 * 60_000).toISOString() : mergeClose ? new Date(Date.now() + 30 * 60_000).toISOString() : readOnly ? appReaderCredentialExpiry(Date.now()) : githubCredentialExpiry(Date.now());
    const key = await reusableKey(env.COOKIE_ENCRYPTION_KEY,
      JSON.stringify(["github-exchange-v1", env.TEAM, repository, tracker, subject, scopes, expiresAt, ...(mergeAdmission ? [mergeAdmission] : [])]));
    const issued = await storeFor(env).createExchangeKey(key, {
      label: `github:${tracker}`, scopes, trackers: [tracker], expiresAt,
    }, subject);
    if (!issued) throw refuse("forbidden", "This exchanged credential was revoked. Retry after its expiry or contact the administrator.");
    return respond({ status: 200, body: { token: key.token, expires_at: issued.expires_at } }, requestId);
  } catch (error) {
    return respond(error instanceof Refusal ? error.out : problemOut("internal", "GitHub authorization failed."), requestId);
  }
}
