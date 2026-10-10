// MCP tools: thin wrappers over the same domain operations the HTTP API runs.
import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { trackerAllowed, type Principal } from "../auth/scopes";
import { forbiddenTracker, type Out } from "../tracker/problem";
import type { Call, ReadOp, TeamStore, WriteOp } from "../tracker/team-store";
import { canonicalJson, MAX_TRACKER, sha256Hex, TRACKER_ID, type Json } from "../tracker/util";
import { STORE_VERSION } from "../version";

export interface ToolDeps {
  store: DurableObjectStub<TeamStore>;
  principal: Principal;
  /** X-Beads-Agent: provenance only. */
  agent?: string;
  canWrite: boolean;
}

const tracker = z
  .string()
  .max(MAX_TRACKER)
  .regex(TRACKER_ID, "lower-case letters, digits and single dashes")
  .describe("Tracker id: the Beads project to act on.");
const id = z.string().min(1).describe("Issue id.");
const mutationId = z
  .string()
  .min(1)
  .max(200)
  .optional()
  .describe("Always send a fresh unique value and reuse it unchanged when retrying this exact call; a repeat returns the first result without writing again.");
const labels = z.array(z.string());

const patchShape = z
  .object({
    title: z.string(),
    description: z.string(),
    design: z.string(),
    acceptance_criteria: z.string(),
    notes: z.string(),
    append_notes: z.string(),
    priority: z.number().int().min(0).max(4),
    issue_type: z.string(),
    status: z.string(),
    assignee: z.string(),
    parent_id: z.string(),
    labels,
    add_labels: labels,
    remove_labels: labels,
    metadata: z.record(z.string(), z.unknown()).describe("Replace with {replace: {...}} or edit with {merge|set: {...}, unset: [...]}."),
    estimated_minutes: z.number().int().nullable(),
    external_ref: z.string().nullable(),
    due_at: z.string().nullable(),
    defer_until: z.string().nullable(),
  })
  .partial()
  .describe("Fields to change; null clears estimated_minutes, external_ref, due_at and defer_until.");

/** The readiness filters shared by bead_ready and bead_claim_next. */
const readyFilters = {
  type: z.string().optional(),
  label: z.array(z.string()).optional().describe("Every label must be present."),
  priority: z.number().int().optional(),
  parent: z.string().optional().describe("Only descendants of this issue."),
};

const SCOPE_ERROR = {
  isError: true,
  structuredContent: { code: "insufficient_scope", detail: "this tool needs the beads:write scope; re-authorize with it" },
  content: [{ type: "text" as const, text: '{"code":"insufficient_scope","detail":"this tool needs the beads:write scope; re-authorize with it"}' }],
} satisfies CallToolResult;

function resultOf(out: Out): CallToolResult {
  const failed = out.status >= 400;
  const body = failed ? { ...(out.body as Record<string, unknown>), request_id: crypto.randomUUID() } : (out.body as Record<string, unknown>);
  return { isError: failed, structuredContent: body, content: [{ type: "text", text: JSON.stringify(body) }] };
}

export const WRITE_TOOLS = new Set([
  "bead_create", "bead_update", "bead_close", "bead_reopen", "bead_claim", "bead_claim_next", "bead_release",
  "bead_comment_add", "bead_dependency_add", "bead_dependency_remove", "memory_put", "memory_forget",
]);

const dropUndefined = (o: Json): Json => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

export function buildServer(deps: ToolDeps): McpServer {
  const server = new McpServer({ name: "beads-cloudflare", version: STORE_VERSION });
  const actor = deps.principal.email;

  const read = <S extends z.ZodRawShape>(name: string, description: string, shape: S, op: ReadOp | "context", map: (a: z.infer<z.ZodObject<S>>) => Partial<Call>) => {
    server.registerTool(
      name,
      { description, inputSchema: z.object({ tracker, ...shape }), annotations: { readOnlyHint: true } },
      async (args) => {
        const a = args as z.infer<z.ZodObject<S>> & { tracker: string };
        if (!trackerAllowed(deps.principal, a.tracker)) return resultOf(forbiddenTracker(a.tracker));
        if (op === "context") return resultOf({ status: 200, body: await deps.store.contextOf(a.tracker) });
        return resultOf(await deps.store.read(op, { tracker: a.tracker, principal: deps.principal, agent: deps.agent, ...map(a) }));
      },
    );
  };

  const write = <S extends z.ZodRawShape>(name: string, description: string, shape: S, op: WriteOp, map: (a: z.infer<z.ZodObject<S>>) => Partial<Call>) => {
    server.registerTool(
      name,
      { description, inputSchema: z.object({ tracker, ...shape, mutation_id: mutationId }), annotations: { readOnlyHint: false, idempotentHint: true } },
      async (args) => {
        if (!deps.canWrite) return SCOPE_ERROR;
        if (!trackerAllowed(deps.principal, (args as { tracker: string }).tracker)) return resultOf(forbiddenTracker((args as { tracker: string }).tracker));
        const { tracker: t, mutation_id, ...rest } = args as z.infer<z.ZodObject<S>> & { tracker: string; mutation_id?: string };
        const call: Call = { tracker: t, principal: deps.principal, agent: deps.agent, ...map(rest as z.infer<z.ZodObject<S>>) };
        if (mutation_id) {
          // The request hash covers the tool and its arguments but not the mutation id itself.
          call.idem = { key: `mcp:${mutation_id}`, hash: await sha256Hex(canonicalJson({ tool: name, tracker: t, args: rest })) };
        }
        return resultOf(await deps.store.write(op, call));
      },
    );
  };

  read("tracker_context", "Describe a tracker: API version, capabilities and extensions.", {}, "context", () => ({}));

  read("bead_get", "Get one bead with labels, dependencies, comment count and its `revision` (use as expected_version).", {
    id,
    include_comments: z.boolean().optional(),
    include_dependents: z.boolean().optional(),
  }, "getIssue", (a) => ({ id: a.id, get: { includeComments: a.include_comments, includeDependents: a.include_dependents } }));

  read("bead_list", "List beads, newest first. Excludes closed beads unless status or all is given.", {
    status: z.array(z.string()).optional(),
    type: z.string().optional(),
    assignee: z.string().optional(),
    label: z.array(z.string()).optional(),
    parent: z.string().optional(),
    all: z.boolean().optional(),
    limit: z.number().int().min(1).max(500).optional(),
    cursor: z.string().optional().describe("next_cursor of the previous page."),
  }, "listIssues", (a) => ({ list: { status: a.status, type: a.type, assignee: a.assignee, label: a.label, parent: a.parent, all: a.all, limit: a.limit, cursor: a.cursor } }));

  read("bead_ready", "List beads that are ready to start: open, unblocked, not deferred. Best first.", {
    ...readyFilters,
    assignee: z.string().optional(),
    limit: z.number().int().min(1).max(500).optional(),
    sort: z.enum(["priority", "oldest", "hybrid"]).optional(),
  }, "listReadyWork", (a) => ({ filter: { type: a.type, label: a.label, priority: a.priority, parent: a.parent, assignee: a.assignee, limit: a.limit, sort: a.sort } }));

  write("bead_create", "Create a bead. Returns the stored bead.", {
    title: z.string().min(1),
    issue_type: z.string().optional().describe("bug, feature, task, epic, chore, decision, spike, story, milestone. Default task."),
    description: z.string().optional(),
    priority: z.number().int().min(0).max(4).optional().describe("0 highest to 4 lowest. Default 2."),
    labels: labels.optional(),
    assignee: z.string().optional(),
    parent_id: z.string().optional(),
    dependencies: z.array(z.object({ target_id: z.string(), type: z.string().default("blocks") })).optional().describe("Edges from the new bead: it depends on target_id."),
    metadata: z.record(z.string(), z.unknown()).optional(),
    id: z.string().optional().describe("Explicit id; must start with the tracker id and a dash."),
  }, "createIssue", (a) => ({
    body: dropUndefined({
      actor, title: a.title, issue_type: a.issue_type ?? "task", description: a.description, priority: a.priority ?? 2, labels: a.labels,
      assignee: a.assignee, parent_id: a.parent_id, dependencies: a.dependencies, metadata: a.metadata, id: a.id,
    }),
  }));

  write("bead_update", "Change fields of a bead. Pass expected_version (the bead's revision) to fail instead of overwriting a concurrent change.", {
    id,
    patch: patchShape,
    expected_version: z.string().optional(),
    fencing_token: z.number().int().optional().describe("From your claim; required to change status or assignee of a claimed bead you no longer hold."),
  }, "updateIssue", (a) => ({ id: a.id, body: dropUndefined({ actor, patch: a.patch, expected_version: a.expected_version, x_fencing_token: a.fencing_token }) }));

  write("bead_close", "Close a bead. Refused while it has open children or live blockers unless force. Pass fencing_token from your claim so a lost claim cannot close it.", {
    id,
    reason: z.string().optional(),
    force: z.boolean().optional(),
    expected_version: z.string().optional(),
    fencing_token: z.number().int().optional(),
  }, "closeIssue", (a) => ({ id: a.id, body: dropUndefined({ actor, reason: a.reason, force: a.force, expected_version: a.expected_version, x_fencing_token: a.fencing_token }) }));

  write("bead_reopen", "Reopen a closed bead.", {
    id,
    reason: z.string().optional(),
    expected_version: z.string().optional(),
  }, "reopenIssue", (a) => ({ id: a.id, body: dropUndefined({ actor, reason: a.reason, expected_version: a.expected_version }) }));

  write("bead_claim", "Claim a bead for yourself with a lease. Returns fencing_token (x_fencing_token); keep it and send it to close or release. Claiming again as the holder renews the lease.", {
    id,
    lease_seconds: z.number().int().min(1).max(86400).optional().describe("Default 1800."),
  }, "claimIssue", (a) => ({ id: a.id, body: dropUndefined({ actor, x_lease_seconds: a.lease_seconds }) }));

  write("bead_claim_next", "Claim the best ready bead, atomically. Returns {} when nothing is claimable; poll again later.", {
    ...readyFilters,
    lease_seconds: z.number().int().min(1).max(86400).optional(),
  }, "claimNextIssue", (a) => ({
    filter: { type: a.type, label: a.label, priority: a.priority, parent: a.parent },
    body: dropUndefined({ actor, x_lease_seconds: a.lease_seconds }),
  }));

  write("bead_release", "Give up your claim: the bead becomes open and unassigned.", {
    id,
    fencing_token: z.number().int().optional(),
    force: z.boolean().optional().describe("Release a claim someone else holds."),
    expected_assignee: z.string().optional(),
  }, "releaseIssue", (a) => ({ id: a.id, body: dropUndefined({ actor, x_fencing_token: a.fencing_token, force: a.force, expected_assignee: a.expected_assignee }) }));

  write("bead_comment_add", "Add a comment to a bead.", { id, text: z.string().min(1) }, "addComment", (a) => ({ id: a.id, body: { author: actor, text: a.text } }));

  write("bead_dependency_add", "Make issue_id depend on depends_on_id. Default type blocks: issue_id is blocked until depends_on_id closes.", {
    issue_id: z.string(),
    depends_on_id: z.string(),
    type: z.string().optional().describe("blocks (default), parent-child, related, discovered-from, waits-for, ..."),
  }, "addDependencies", (a) => ({ body: { actor, edges: [{ issue_id: a.issue_id, depends_on_id: a.depends_on_id, type: a.type ?? "blocks" }] } }));

  write("bead_dependency_remove", "Remove the dependency of issue_id on depends_on_id, whatever its type.", {
    issue_id: z.string(),
    depends_on_id: z.string(),
  }, "removeDependency", (a) => ({ body: { actor, issue_id: a.issue_id, depends_on_id: a.depends_on_id } }));

  read("memory_get", "Read a memory by key.", { key: z.string().min(1) }, "getMemory", (a) => ({ id: a.key }));
  read("memory_list", "List memories, optionally filtered by a case-insensitive search of key and value.", { search: z.string().optional() }, "listMemories", (a) => ({ search: a.search }));
  write("memory_put", "Store a memory; replaces the value under an existing key. The key is derived from the content when omitted.", {
    content: z.string().min(1),
    key: z.string().optional(),
  }, "rememberMemory", (a) => ({ body: dropUndefined({ content: a.content, key: a.key }) }));
  write("memory_forget", "Delete a memory by key.", { key: z.string().min(1) }, "forgetMemory", (a) => ({ id: a.key }));

  read("bead_history", "Read the change log: events after sequence number since (default 0), oldest first.", {
    since: z.number().int().min(0).optional(),
    limit: z.number().int().min(1).max(10000).optional(),
  }, "listEvents", (a) => ({ since: a.since ?? 0, limit: a.limit }));

  return server;
}
