// Governed tracker operations for hosts that reach Beads only over MCP (a claude.ai connector, cloud
// sessions without an exchangeable GitHub identity). Every write is followed by an independent read of
// the stored bead; only a matching readback yields the BEADS_REMOTE_WRITE_OK receipt the governed
// writer prints, so the caller never has to trust the write response alone.
import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { trackerAllowed } from "../auth/scopes";
import { forbiddenTracker, rejectedWrite, type Out } from "../tracker/problem";
import type { Call, ReadOp, WriteOp } from "../tracker/team-store";
import { canonicalJson, isObject, sha256Hex, type Json } from "../tracker/util";
import { dropUndefined, mutationId, resultOf, SCOPE_ERROR, tracker, workerActor, workerCall, type ToolDeps } from "./tools";

export const GOVERNED_WRITE_TOOLS = new Set(["beads_create", "beads_update", "beads_comment", "beads_close", "beads_block"]);

type Issue = Record<string, unknown> & { id?: string; revision?: string; labels?: string[]; comments?: { id: string; text?: string; author?: string }[]; dependencies?: { id: string; dependency_type?: string }[] };

/** A value inside a double-quoted string of the `bd query` language. */
export const quoted = (value: string) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

/** Scalar fields a governed write may set; each must read back exactly as sent ("" and absent are equal). */
const SCALARS = ["title", "description", "design", "acceptance_criteria", "notes", "status", "priority", "issue_type", "assignee", "parent_id"] as const;
type Scalars = Partial<Record<(typeof SCALARS)[number], string | number>>;
const sameScalars = (sent: Scalars, stored: Issue) => SCALARS.every((f) => sent[f] === undefined || (stored[f === "parent_id" ? "parent" : f] ?? "") === sent[f]);
const hasLabels = (stored: Issue, present: string[] = [], absent: string[] = []) =>
  present.every((l) => stored.labels?.includes(l)) && !absent.some((l) => stored.labels?.includes(l));

const REASON_LIMIT = 255;
const reasonProblem = (reason: string) => [...reason].length > REASON_LIMIT || /[\p{Cc}\u2028\u2029]/u.test(reason);

/** The one-line summary of an overlong or multiline reason: its first nonempty line, cut at a word boundary, ending in an ellipsis. */
function summarizeReason(reason: string): string {
  const line = reason.split(/[\r\n\u2028\u2029]+/u).map((part) => part.replace(/[\p{Cc}\s]+/gu, " ").trim()).find(Boolean) ?? "Closed";
  const chars = [...line];
  if (chars.length <= REASON_LIMIT) return line;
  const head = chars.slice(0, REASON_LIMIT - 1);
  const space = head.lastIndexOf(" ");
  return `${(space >= 120 ? head.slice(0, space) : head).join("").trimEnd()}…`;
}

/**
 * A close reason holds at most 255 characters without line breaks. A longer or multiline one is not refused: its
 * first line becomes the reason and the complete text becomes the evidence comment of the same atomic close.
 */
export function fitCloseReason<T extends { reason?: string; evidence_comment?: string }>(a: T): T {
  const full = a.reason?.trim();
  if (!full || !reasonProblem(a.reason!)) return a;
  const evidence_comment = a.evidence_comment ? `Close reason (full text):\n${full}\n\n${a.evidence_comment}` : full;
  return { ...a, reason: summarizeReason(full), evidence_comment };
}

export function registerGoverned(server: McpServer, deps: ToolDeps): McpServer {
  const actor = deps.principal.email;
  const id = z.string().min(1).describe("Issue id.");
  const labels = z.array(z.string());

  const read = <S extends z.ZodRawShape>(name: string, description: string, shape: S, op: ReadOp, map: (a: z.infer<z.ZodObject<S>>) => Partial<Call>) => {
    server.registerTool(
      name,
      { description, inputSchema: z.object({ tracker, ...shape }), annotations: { readOnlyHint: true } },
      async (args) => {
        const a = args as z.infer<z.ZodObject<S>> & { tracker: string };
        if (!trackerAllowed(deps.principal, a.tracker)) return resultOf(forbiddenTracker(a.tracker));
        return resultOf(await deps.store.read(op, { tracker: a.tracker, principal: deps.principal, agent: deps.agent, ...map(a) }));
      },
    );
  };

  /**
   * A write, then a fresh getIssue of `target` in a separate store call. `verify` decides whether the
   * stored bead shows the write; a mismatch is reported as uncertain, never as success.
   */
  const write = <S extends z.ZodRawShape>(
    name: string, description: string, shape: S, op: WriteOp | ((a: z.infer<z.ZodObject<S>>) => WriteOp),
    map: (a: z.infer<z.ZodObject<S>>) => Partial<Call>,
    target: (a: z.infer<z.ZodObject<S>>, written: Json) => string | undefined,
    verify: (a: z.infer<z.ZodObject<S>>, written: Json, stored: Issue) => boolean,
    normalize: (a: z.infer<z.ZodObject<S>>) => z.infer<z.ZodObject<S>> = (a) => a,
  ) => {
    server.registerTool(
      name,
      { description, inputSchema: z.object({ tracker, ...shape, mutation_id: mutationId, worker_actor: workerActor }), annotations: { readOnlyHint: false, idempotentHint: true } },
      async (args): Promise<CallToolResult> => {
        if (!deps.canWrite) return SCOPE_ERROR;
        const { tracker: t, mutation_id, worker_actor, ...rest } = args as z.infer<z.ZodObject<S>> & { tracker: string; mutation_id?: string; worker_actor?: string };
        if (!trackerAllowed(deps.principal, t)) return resultOf(rejectedWrite(forbiddenTracker(t)));
        const a = normalize(rest as z.infer<z.ZodObject<S>>);
        const call = workerCall({ tracker: t, principal: deps.principal, agent: deps.agent, ...map(a) }, worker_actor);
        if (mutation_id) call.idem = { key: `mcp:${mutation_id}`, hash: await sha256Hex(canonicalJson({ tool: name, tracker: t, args: rest, worker_actor })) };
        let out: Out;
        try { out = await deps.store.write(typeof op === "function" ? op(a) : op, call); }
        catch {
          return resultOf({ status: 500, body: { code: "write_outcome_unknown", x_outcome: "unknown", mutation_id: mutation_id ?? null,
            detail: "the store acknowledgement was lost; inspect the bead and operation before another mutation" } });
        }
        if (out.status >= 400) return resultOf(out);
        const written = out.body as Json;
        const issueId = target(a, written);
        let back: Out | undefined;
        try {
          if (issueId) back = await deps.store.read("getIssue", { tracker: t, principal: deps.principal, agent: call.agent, id: issueId, get: { includeComments: true } });
          if (issueId && name === "beads_block" && back && back.status < 400 && isObject(back.body)) {
            const edges = (await deps.store.read("listDependencies", { tracker: t, principal: deps.principal, params: { ids: [issueId], types: ["blocks"] } })) as Out;
            if (edges.status >= 400 || !isObject(edges.body)) back = undefined;
            else back.body.x_dependency_edges = edges.body.items;
          }
        } catch { /* The write was acknowledged; a lost readback remains applied but unverified. */ }
        const stored = back && back.status < 400 ? (back.body as Issue) : undefined;
        if (!issueId || !stored || !verify(a, written, stored)) {
          const body = {
            code: "readback_mismatch",
            x_outcome: "applied_unverified", x_mutation_applied: true, mutation_id: mutation_id ?? null,
            detail: "the write was accepted but the stored bead does not show it; read it back again and do not replay the write",
            result: written, readback: stored ?? null, request_id: crypto.randomUUID(),
          };
          return { isError: true, structuredContent: body, content: [{ type: "text", text: JSON.stringify(body) }] };
        }
        const receipt = `BEADS_REMOTE_WRITE_OK repo=${t} tracker=cloudflare route=mcp op=${name} id=${issueId} revision=${stored.revision ?? ""}`;
        const body = { receipt, x_outcome: "verified", mutation_id: mutation_id ?? null, result: written, readback: stored };
        return { structuredContent: body, content: [{ type: "text", text: `${receipt}\n${JSON.stringify(body)}` }] };
      },
    );
  };

  read("beads_ready", "Ready work in a tracker: open, unblocked, not deferred; best first.", {
    type: z.string().optional(),
    label: z.array(z.string()).optional().describe("Every label must be present."),
    priority: z.number().int().optional(),
    parent: z.string().optional(),
    assignee: z.string().optional(),
    limit: z.number().int().min(1).max(500).optional(),
  }, "listReadyWork", (a) => ({ filter: { type: a.type, label: a.label, priority: a.priority, parent: a.parent, assignee: a.assignee, limit: a.limit } }));

  read("beads_show", "One bead with labels, dependencies, comments and its revision.", { id }, "getIssue",
    (a) => ({ id: a.id, get: { includeComments: true, includeDependents: true } }));

  read("beads_list", "List beads, newest first; closed beads only with status or all.", {
    status: z.array(z.string()).optional(),
    type: z.string().optional(),
    assignee: z.string().optional(),
    label: z.array(z.string()).optional(),
    parent: z.string().optional(),
    all: z.boolean().optional(),
    limit: z.number().int().min(1).max(500).optional(),
    cursor: z.string().optional().describe("next_cursor of the previous page."),
  }, "listIssues", (a) => ({ list: { status: a.status, type: a.type, assignee: a.assignee, label: a.label, parent: a.parent, all: a.all, limit: a.limit, cursor: a.cursor } }));

  read("beads_search", "Search beads: text matches title or description (case-insensitive); query is a raw `bd query` expression instead.", {
    text: z.string().min(1).optional(),
    query: z.string().min(1).optional(),
    all: z.boolean().optional().describe("Include closed beads."),
    limit: z.number().int().min(1).max(500).optional(),
  }, "queryIssues", (a) => ({
    // An empty expression is refused by the query endpoint as invalid, which is the answer to neither text nor query.
    params: dropUndefined({ q: a.query ?? (a.text ? `title=${quoted(a.text)} OR description=${quoted(a.text)}` : ""), all: a.all ?? false, reverse: false, limit: a.limit }),
  }));

  write("beads_create", "Create a bead; returns the stored bead read back and a BEADS_REMOTE_WRITE_OK receipt.", {
    title: z.string().min(1),
    issue_type: z.string().optional().describe("bug, feature, task, epic, chore, decision, spike, story, milestone. Default task."),
    description: z.string().optional(),
    priority: z.number().int().min(0).max(4).optional().describe("0 highest to 4 lowest. Default 2."),
    labels: labels.optional(),
    assignee: z.string().optional(),
    parent_id: z.string().optional(),
  }, "createIssue", (a) => ({
    body: dropUndefined({ actor, title: a.title, issue_type: a.issue_type ?? "task", description: a.description, priority: a.priority ?? 2, labels: a.labels, assignee: a.assignee, parent_id: a.parent_id }),
  }), (_a, w) => (typeof w.id === "string" ? w.id : undefined),
  (a, w, s) => s.id === w.id && sameScalars({ ...a, issue_type: a.issue_type ?? "task", priority: a.priority ?? 2 }, s) && hasLabels(s, a.labels));

  write("beads_update", "Change fields of a bead; pass expected_version (its revision) to refuse overwriting a concurrent change.", {
    id,
    // Only fields the readback can verify exactly; bead_update covers metadata, dates and appended notes.
    patch: z.object({
      title: z.string(), description: z.string(), design: z.string(), acceptance_criteria: z.string(), notes: z.string(),
      status: z.string(), priority: z.number().int().min(0).max(4), issue_type: z.string(), assignee: z.string(), parent_id: z.string(),
      add_labels: labels, remove_labels: labels,
    }).partial().describe("Fields to change."),
    expected_version: z.string().optional(),
  }, "updateIssue", (a) => ({ id: a.id, body: dropUndefined({ actor, patch: a.patch, expected_version: a.expected_version }) }),
  (a) => a.id, (a, _w, s) => sameScalars(a.patch, s) && hasLabels(s, a.patch.add_labels, a.patch.remove_labels));

  write("beads_comment", "Add a comment to a bead; the readback must contain it.", { id, text: z.string().min(1) }, "addComment",
    (a) => ({ id: a.id, body: { author: actor, text: a.text } }),
    (a) => a.id, (_a, w, s) => (s.comments ?? []).some((c) => c.id === w.id));

  write("beads_close", "Close a bead. An optional evidence_comment is stored atomically with the close; its exact id must read back before success. A reason over 255 characters or with line breaks is split automatically: its first line becomes the reason and the full text the evidence comment.", {
    id,
    reason: z.string().optional(),
    evidence_comment: z.string().min(1).optional().describe("Long completion evidence. The reason holds at most 255 characters; a longer or multiline reason is moved here automatically."),
    force: z.boolean().optional(),
    expected_version: z.string().optional(),
    fencing_token: z.number().int().optional(),
  }, (a) => a.evidence_comment === undefined ? "closeIssue" : "applyBatch", (a) => a.evidence_comment === undefined
    ? { id: a.id, body: dropUndefined({ actor, reason: a.reason, force: a.force, expected_version: a.expected_version, x_fencing_token: a.fencing_token }) }
    : { body: { actor, items: [
      { kind: "close", close: dropUndefined({ target: { id: a.id }, reason: a.reason, force: a.force, expected_version: a.expected_version, x_fencing_token: a.fencing_token }) },
      { kind: "x_comment", x_comment: { target: { id: a.id }, text: a.evidence_comment } },
    ] } },
  (a) => a.id, (a, w, s) => {
    if (s.status !== "closed" || (a.reason !== undefined && (s.close_reason ?? "") !== a.reason)) return false;
    if (a.evidence_comment === undefined) return true;
    const results = Array.isArray(w.items) ? w.items : [];
    const comment = results.find((r: Json) => r.kind === "x_comment");
    return typeof comment?.x_comment_id === "string" && (s.comments ?? []).some((c) => c.id === comment.x_comment_id && c.text === a.evidence_comment && c.author === actor);
  }, fitCloseReason);

  write("beads_block", "Record that id is blocked by blocked_by (a blocks dependency); the readback must show the edge.", {
    id,
    blocked_by: z.string().min(1),
  }, "addDependencies", (a) => ({ body: { actor, edges: [{ issue_id: a.id, depends_on_id: a.blocked_by, type: "blocks" }] } }),
  (a) => a.id, (a, _w, s) => Array.isArray(s.x_dependency_edges) && s.x_dependency_edges.some((d: unknown) => isObject(d) && d.issue_id === a.id && d.depends_on_id === a.blocked_by && d.type === "blocks"));

  return server;
}
