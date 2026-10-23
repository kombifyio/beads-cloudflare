// The three batch writes: batchCreateIssues, batchCloseIssues and applyBatch.
//
// Upstream: internal/httpapi/{batch_create,batch_close,batch_apply}.go over issueops/{create_batch,
// close_batch,batch_apply}.go. Each runs inside the Durable Object transaction its caller opened, so
// "all or nothing" is a thrown Refusal: the surrounding transactionSync rolls every earlier item back.
import { checkMembers, METADATA_KEY, nameMember, optBool, optInt, optString } from "./body";
import { setConfig, unsetSetting } from "./config";
import { insertEdge, reaches, recordEdgeAdded, recordEdgeRemoved } from "./edges";
import { X_EXTRA } from "./extra";
import { recordEvent, type Ctx } from "./events";
import { closeRow } from "./lifecycle";
import { all, hydratedIssue, loadIssue, one, SCHEDULING_TYPES } from "./model";
import { invalid, issueNotFound, refuse, Refusal } from "./problem";
import type { Out, ProblemExtras } from "./problem";
import { addComment, createIssue, idIsAddressable, parseVersionToken, updateIssue, patchMetadata } from "./issues";
import { runeLength, isObject, safeObject, setOwn, type Json } from "./util";

const MAX_ITEMS = 100;

const itemsOf = (body: Json, label = "items"): Json[] => {
  const raw = body[label];
  if (raw === undefined) throw invalid(label, `\`${label}\` is required`);
  if (!Array.isArray(raw)) throw invalid(label, `\`${label}\` must be an array of objects`);
  if (raw.length === 0) throw invalid(label, `\`${label}\` must carry at least one item; a request that does nothing is refused rather than answered`);
  if (raw.length > MAX_ITEMS) throw invalid(label, `\`${label}\` carries ${raw.length} items; the limit is ${MAX_ITEMS} per request`);
  raw.forEach((item, i) => {
    if (!isObject(item)) throw invalid(`${label}[${i}]`, "an item must be a JSON object");
  });
  return raw as Json[];
};

/** Re-attributes a refusal raised by a single-item operation to the item that carried it. */
function rethrowAt(e: unknown, prefix: string, extras: ProblemExtras = {}): never {
  if (e instanceof Refusal) {
    const body = e.out.body as Json;
    const param = typeof body.param === "string" ? body.param : undefined;
    // A refusal that already names its item (`items[2].create.title`) is left as it is.
    body.param = param === undefined ? prefix : param.startsWith("items[") ? param : `${prefix}.${param}`;
    Object.assign(body, extras);
  }
  throw e;
}

// ---------------------------------------------------------------------------------------------
// batchCreateIssues

const BATCH_CREATE_ITEM = ["title", "description", "design", "acceptance_criteria", "priority", "issue_type", "assignee", "labels", "dependencies", X_EXTRA];

export function batchCreateIssues(ctx: Ctx, body: Json, candidates: string[][]): Out {
  checkMembers(body, ["actor", "items"]);
  const actor = nameMember(body, "actor");
  ctx.clientActor = actor;
  const items = itemsOf(body);
  const created = items.map((item, i) => {
    const at = `items[${i}]`;
    checkMembers(item, BATCH_CREATE_ITEM, at, `${at}.`);
    for (const [j, dep] of ((item.dependencies as Json[] | undefined) ?? []).entries()) {
      if (!isObject(dep)) throw invalid(`${at}.dependencies`, "`dependencies` must be an array of objects");
      checkMembers(dep, ["target_id", "type"], `${at}.dependencies[${j}]`, `${at}.dependencies.`);
    }
    // The wire item has no `issue_type` default of its own: an absent one is the workspace default, `task`.
    const single: Json = { actor, issue_type: "task", ...item };
    try {
      const out = createIssue(ctx, single, candidates[i] ?? []);
      return out.body;
    } catch (e) {
      rethrowAt(e, at);
    }
  });
  return { status: 200, body: { items: created } };
}

// ---------------------------------------------------------------------------------------------
// batchCloseIssues

export function batchCloseIssues(ctx: Ctx, body: Json): Out {
  checkMembers(body, ["actor", "items", "session", "force"]);
  ctx.clientActor = nameMember(body, "actor");
  const items = itemsOf(body);
  const session = optString(body, "session", "session", true) ?? "";
  const force = optBool(body, "force") ?? false;
  const requests = items.map((item, i) => {
    checkMembers(item, ["id", "reason"], `items[${i}]`, `items[${i}].`);
    const id = optString(item, "id", `items[${i}].id`, true);
    if (!id) throw invalid(`items[${i}].id`, "`id` is required");
    return { id, reason: optString(item, "reason", `items[${i}].reason`, true) ?? "" };
  });

  const outcomes = requests.map(({ id, reason }) => {
    try {
      if (!idIsAddressable(id)) throw issueNotFound();
      const row = loadIssue(ctx.sql, ctx.tracker, id);
      if (!row) throw issueNotFound();
      const { alreadyClosed, children } = closeRow(ctx, row, { reason, session, force });
      return { issue_id: id, issue: loadIssueJson(ctx, id), already_closed: alreadyClosed, open_children: force ? children : 0 };
    } catch (e) {
      // An item's refusal is a member of its outcome (`code`, `detail`), never a failed request.
      if (e instanceof Refusal) {
        const problem = e.out.body as Json;
        const extra = typeof problem.open_children === "number" ? { open_children: problem.open_children } : {};
        return { issue_id: id, ...extra, code: problem.code, detail: problem.detail };
      }
      throw e;
    }
  });
  return { status: 200, body: { outcomes } };
}

const loadIssueJson = (ctx: Ctx, id: string) => hydratedIssue(ctx.sql, ctx.tracker, id);

// ---------------------------------------------------------------------------------------------
// applyBatch

const CORE_KINDS = ["create", "update", "close", "dep_add"] as const;
/**
 * Profile extension items (capability `profile.apply_batch_extensions`): what a whole bd transaction needs and the
 * four core kinds cannot say. They run inside the same atomic plan, in order, like any other item.
 */
const X_KINDS = ["x_dep_remove", "x_comment", "x_set_config", "x_unset_config"] as const;
const APPLY_KINDS = [...CORE_KINDS, ...X_KINDS] as const;
type Kind = (typeof APPLY_KINDS)[number];

const CREATE_ITEM = [
  "key", "id", "title", "description", "design", "acceptance_criteria", "notes", "issue_type", "status", "priority", "assignee", "owner",
  "labels", "estimated_minutes", "external_ref", "due_at", "defer_until", "sender", "metadata", "ephemeral", "no_history", "metadata_refs",
  // Extensions: the parent as a Ref (a child id is minted under it), the parent's labels, and the core members no create carries.
  "x_parent_id", "x_inherit_labels_from_parent", X_EXTRA,
];
const UPDATE_ITEM = ["target", "patch", "expected_version", "expected_status", "expected_assignee", "force_close_policy", "force_assignee_transfer"];
const PATCH_ITEM = [
  "title", "description", "design", "acceptance_criteria", "notes", "append_notes", "priority", "issue_type", "status", "assignee", "owner",
  "labels", "estimated_minutes", "external_ref", "due_at", "defer_until", "metadata", X_EXTRA,
];

interface Plan {
  index: number;
  kind: Kind;
  payload: Json;
}

interface Run {
  ctx: Ctx;
  keys: Map<string, string>;
  /** Where each key is declared, for the backward-only rule. */
  declared: Map<string, number>;
  /** Rows an earlier item of this request created or changed (their revision token cannot be guarded). */
  written: Set<string>;
  edges: { issue_id: string; depends_on_id: string; type: string }[];
  skipCycleProbe: boolean;
}

function refAt(run: Run, raw: unknown, at: string, index: number, forwardOk = false): { id: string; fromKey: boolean } {
  if (!isObject(raw)) throw invalid(at, "a ref must be an object with exactly one of `key` and `id`");
  checkMembers(raw, ["key", "id"], at, `${at}.`);
  const hasKey = raw.key !== undefined;
  const hasId = raw.id !== undefined;
  if (hasKey === hasId) throw invalid(at, hasKey ? "a ref names a `key` or an `id`, not both" : "a ref names nothing: set exactly one of `key` and `id`");
  if (hasId) {
    const id = optString(raw, "id", `${at}.id`, true);
    if (!id) throw invalid(`${at}.id`, "`id` must not be empty");
    return { id, fromKey: false };
  }
  const key = optString(raw, "key", `${at}.key`, true);
  if (!key) throw invalid(`${at}.key`, "`key` must not be empty");
  const position = run.declared.get(key);
  if (position === undefined) throw invalid(`${at}.key`, `no create item declares the key ${JSON.stringify(key)}`).withExtras({ declared_later: false } as ProblemExtras);
  const id = run.keys.get(key);
  if (id === undefined || (position >= index && !forwardOk)) {
    throw invalid(`${at}.key`, `the key ${JSON.stringify(key)} is declared by a later item; a ref that addresses a row may only name a key an earlier create item declared`).withExtras({
      declared_later: true,
    } as ProblemExtras);
  }
  return { id, fromKey: true };
}

const requireRowAt = (run: Run, id: string, at: string) => {
  if (!idIsAddressable(id)) throw issueNotFound();
  const row = loadIssue(run.ctx.sql, run.ctx.tracker, id);
  if (!row) throw issueNotFound();
  void at;
  return row;
};

export function applyBatch(ctx: Ctx, body: Json, candidates: string[][]): Out {
  checkMembers(body, ["actor", "items", "provenance", "force_id_prefix", "skip_per_edge_cycle_check"]);
  const actor = nameMember(body, "actor");
  ctx.clientActor = actor;
  const items = itemsOf(body);
  optString(body, "provenance", "provenance");
  const forcePrefix = optBool(body, "force_id_prefix") ?? false;
  const run: Run = {
    ctx,
    keys: new Map(),
    declared: new Map(),
    written: new Set(),
    edges: [],
    skipCycleProbe: optBool(body, "skip_per_edge_cycle_check") ?? false,
  };

  // Shape first: every item must name its kind and carry exactly the payload that kind names.
  const plans: Plan[] = items.map((item, index) => {
    checkMembers(item, ["kind", ...APPLY_KINDS], `items[${index}]`, `items[${index}].`);
    const kind = item.kind;
    if (typeof kind !== "string" || !(APPLY_KINDS as readonly string[]).includes(kind)) {
      throw invalid(`items[${index}].kind`, `\`kind\` must be one of ${APPLY_KINDS.join(", ")}`);
    }
    const present = APPLY_KINDS.filter((k) => item[k] !== undefined);
    if (present.length !== 1 || present[0] !== kind) {
      throw invalid(`items[${index}].${kind}`, `an item carries exactly the one payload its kind names (\`${kind}\`), and no other`);
    }
    const payload = item[kind];
    if (!isObject(payload)) throw invalid(`items[${index}].${kind}`, `\`${kind}\` must be an object`);
    return { index, kind: kind as Kind, payload };
  });
  for (const plan of plans) {
    if (plan.kind !== "create" || plan.payload.key === undefined) continue;
    const key = optString(plan.payload, "key", `items[${plan.index}].create.key`, true);
    if (!key) throw invalid(`items[${plan.index}].create.key`, "`key` must not be empty");
    if (run.declared.has(key)) throw invalid(`items[${plan.index}].create.key`, `the key ${JSON.stringify(key)} is declared twice`);
    run.declared.set(key, plan.index);
  }

  const results: Json[] = [];
  const splices: { id: string; index: number; refs: Json }[] = [];
  for (const plan of plans) {
    const at = `items[${plan.index}].${plan.kind}`;
    const extras = (id?: string): ProblemExtras => ({
      item_index: plan.index,
      item_kind: plan.kind,
      ...(plan.kind === "create" && typeof plan.payload.key === "string" ? { item_key: plan.payload.key } : {}),
      ...(id ? { item_issue_id: id } : {}),
    } as ProblemExtras);
    let touched: string | undefined;
    try {
      if (plan.kind === "create") {
        const { key, metadata_refs: refs, x_parent_id: parentRef, x_inherit_labels_from_parent: inherit, ...rest } = plan.payload;
        checkMembers(plan.payload, CREATE_ITEM, at, `${at}.`);
        const single: Json = { actor, issue_type: "task", ...rest, ...(forcePrefix ? { force_id_prefix: true } : {}) };
        if (parentRef !== undefined) single.parent_id = refAt(run, parentRef, `${at}.x_parent_id`, plan.index).id;
        if (inherit !== undefined) single.inherit_labels_from_parent = inherit;
        const out = createIssue(ctx, single, candidates[plan.index] ?? []);
        const issue = out.body as { id: string };
        touched = issue.id;
        if (typeof key === "string") run.keys.set(key, issue.id);
        if (refs !== undefined) {
          if (!isObject(refs)) throw invalid("metadata_refs", "`metadata_refs` must be an object of refs");
          splices.push({ id: issue.id, index: plan.index, refs });
        }
        run.written.add(issue.id);
        results.push({ kind: "create", issue_id: issue.id, changed: true, revision: String(loadIssue(ctx.sql, ctx.tracker, issue.id)!.version) });
      } else if (plan.kind === "update") {
        results.push(applyUpdate(run, plan, actor, at, (id) => (touched = id)));
      } else if (plan.kind === "close") {
        results.push(applyClose(run, plan, at, (id) => (touched = id)));
      } else if (plan.kind === "dep_add") {
        results.push(applyDepAdd(run, plan, at));
      } else if (plan.kind === "x_dep_remove") {
        results.push(applyDepRemove(run, plan, at));
      } else if (plan.kind === "x_comment") {
        results.push(applyComment(run, plan, actor, at));
      } else {
        results.push(applyConfig(run, plan, at));
      }
    } catch (e) {
      if (e instanceof Refusal) {
        const code = (e.out.body as Json).code;
        // A guard that missed, and a request-shape refusal, name the item that carried them.
        rethrowAt(e, at, code === "precondition_failed" ? extras(touched) : {});
      }
      throw e;
    }
  }

  // Splices: every id exists now, so a metadata value may name a key declared anywhere (forward refs allowed).
  for (const { id, index, refs } of splices) {
    const set: Json = {};
    for (const [name, ref] of Object.entries(refs).sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (!METADATA_KEY.test(name)) throw invalid(`items[${index}].create.metadata_refs`, `invalid metadata key "${name}"`);
      setOwn(set, name, refAt(run, ref, `items[${index}].create.metadata_refs.${name}`, index, true).id);
    }
    const row = loadIssue(ctx.sql, ctx.tracker, id)!;
    const merged = patchMetadata(safeObject(row.metadata), { set });
    ctx.sql.exec(
      "UPDATE issues SET metadata = ?3, updated_at = ?4, version = version + 1 WHERE tracker = ?1 AND id = ?2",
      ctx.tracker, id, JSON.stringify(merged), ctx.now,
    );
    recordEvent(ctx, { op: "update", kind: "updated", issueId: id });
    const result = results[index] as Json;
    result.revision = String(loadIssue(ctx.sql, ctx.tracker, id)!.version);
  }

  endGate(run);
  return { status: 200, body: { keys: Object.fromEntries(run.keys), items: results } };
}

function applyUpdate(run: Run, plan: Plan, actor: string, at: string, touch: (id: string) => void): Json {
  const { ctx } = run;
  const p = plan.payload;
  checkMembers(p, UPDATE_ITEM, at, `${at}.`);
  const ref = refAt(run, p.target, `${at}.target`, plan.index);
  touch(ref.id);
  const row = requireRowAt(run, ref.id, at);
  const patch = p.patch;
  if (!isObject(patch)) throw invalid(`${at}.patch`, "`patch` is required and must be an object");
  checkMembers(patch, PATCH_ITEM, `${at}.patch`, `${at}.patch.`);
  if (Object.keys(patch).length === 0) throw invalid(`${at}.patch`, "`patch` must carry at least one field");

  const expected = parseVersionToken(p.expected_version, `${at}.expected_version`);
  if (expected !== undefined && run.written.has(ref.id)) {
    throw invalid(`${at}.expected_version`, "this row was already written by an earlier item of this request, so no revision token could match; guard on `expected_status` or `expected_assignee` instead");
  }

  // `labels` here is the ordered edit {replace, add, remove}; the single patch's members are `labels`,
  // `add_labels` and `remove_labels`.
  const { owner, labels, ...rest } = patch;
  const single: Json = { ...rest };
  if (labels !== undefined) {
    if (!isObject(labels)) throw invalid(`${at}.patch.labels`, "`labels` must be an object with `replace`, `add` and `remove`");
    checkMembers(labels, ["replace", "add", "remove"], `${at}.patch.labels`, `${at}.patch.labels.`);
    if (labels.replace !== undefined) single.labels = labels.replace;
    if (labels.add !== undefined) single.add_labels = labels.add;
    if (labels.remove !== undefined) single.remove_labels = labels.remove;
  }
  const guards: Json = { actor };
  for (const name of ["expected_version", "expected_status", "expected_assignee", "force_close_policy", "force_assignee_transfer"]) {
    if (p[name] !== undefined) guards[name] = p[name];
  }
  let changed = false;
  if (Object.keys(single).length > 0) {
    const out = updateIssue(ctx, ref.id, { ...guards, patch: single }, {});
    changed = (out.body as { changed: boolean }).changed;
  } else {
    // An owner-only patch has no counterpart on the single PATCH, which does not publish `owner`.
    const out = updateIssue(ctx, ref.id, { ...guards, patch: { priority: row.priority } }, {});
    changed = (out.body as { changed: boolean }).changed;
  }
  if (owner !== undefined) {
    const value = optString(patch, "owner", `${at}.patch.owner`, true) ?? "";
    const current = loadIssue(ctx.sql, ctx.tracker, ref.id)!;
    if (current.owner !== value) {
      ctx.sql.exec("UPDATE issues SET owner = ?3, updated_at = ?4, version = version + 1 WHERE tracker = ?1 AND id = ?2", ctx.tracker, ref.id, value, ctx.now);
      recordEvent(ctx, { op: "update", kind: "updated", issueId: ref.id });
      changed = true;
    }
  }
  if (changed) run.written.add(ref.id);
  return { kind: "update", issue_id: ref.id, changed, revision: String(loadIssue(ctx.sql, ctx.tracker, ref.id)!.version) };
}

function applyClose(run: Run, plan: Plan, at: string, touch: (id: string) => void): Json {
  const { ctx } = run;
  const p = plan.payload;
  checkMembers(p, ["target", "reason", "session", "force", "expected_version", "x_fencing_token"], at, `${at}.`);
  const ref = refAt(run, p.target, `${at}.target`, plan.index);
  touch(ref.id);
  const row = requireRowAt(run, ref.id, at);
  const expected = parseVersionToken(p.expected_version, `${at}.expected_version`);
  if (expected !== undefined && run.written.has(ref.id)) {
    throw invalid(`${at}.expected_version`, "this row was already written by an earlier item of this request, so no revision token could match");
  }
  const { alreadyClosed } = closeRow(ctx, row, {
    reason: optString(p, "reason", `${at}.reason`, true) ?? "",
    session: optString(p, "session", `${at}.session`, true) ?? "",
    force: optBool(p, "force", `${at}.force`) ?? false,
    expected,
    token: optInt(p, "x_fencing_token", `${at}.x_fencing_token`),
  });
  if (!alreadyClosed) run.written.add(ref.id);
  return { kind: "close", issue_id: ref.id, changed: !alreadyClosed, revision: String(loadIssue(ctx.sql, ctx.tracker, ref.id)!.version) };
}

function applyDepAdd(run: Run, plan: Plan, at: string): Json {
  const { ctx } = run;
  const p = plan.payload;
  checkMembers(p, ["source", "target", "type", "metadata"], at, `${at}.`);
  const source = refAt(run, p.source, `${at}.source`, plan.index).id;
  const target = refAt(run, p.target, `${at}.target`, plan.index).id;
  if (typeof p.type !== "string" || p.type === "" || new TextEncoder().encode(p.type).length > 32) {
    throw invalid(`${at}.type`, "`type` must be 1 to 32 bytes");
  }
  if (source === target) throw invalid(`${at}.target`, "an issue cannot depend on itself");
  if (runeLength(source) > 255 || runeLength(target) > 255) throw invalid(`${at}.target`, "an id is longer than 255 characters");
  if (p.metadata !== undefined && !isObject(p.metadata)) throw invalid(`${at}.metadata`, "`metadata` must be a JSON object");
  let metadata = isObject(p.metadata) && Object.keys(p.metadata).length > 0 ? p.metadata : undefined;
  if (p.type === "waits-for") {
    // A waits-for row must be self-describing: an absent gate is stored as the default one.
    metadata = metadata ?? { gate: "all-children" };
    const gate = metadata.gate ?? "all-children";
    if (gate !== "all-children" && gate !== "any-children") throw invalid(`${at}.metadata`, "the waits-for `gate` is neither all-children nor any-children");
    metadata = { ...metadata, gate };
  }
  const edge = { issue_id: source, depends_on_id: target, type: p.type, ...(metadata ? { metadata: JSON.stringify(metadata) } : {}) };
  let result;
  try {
    result = insertEdge(ctx, edge, { mode: "verb", skipCycleProbe: run.skipCycleProbe });
  } catch (e) {
    // The edge's own members are named by the item, not by the single-edge verb's `edges[0]`.
    if (e instanceof Refusal) {
      const body = e.out.body as Json;
      if (typeof body.param === "string") body.param = String(body.param).replace(/^edges\[\d+\]\.issue_id$/, `${at}.source`).replace(/^edges\[\d+\]\.depends_on_id$/, `${at}.target`);
    }
    throw e;
  }
  if (result !== "unchanged") recordEdgeAdded(ctx, edge);
  run.edges.push({ issue_id: source, depends_on_id: target, type: p.type });
  const changed = result !== "unchanged";
  return { kind: "dep_add", issue_id: source, depends_on_id: target, changed, revision: "0" };
}

// ---------------------------------------------------------------------------------------------
// Extension items

/** `x_dep_remove`: `{source, target}` Refs. Removes the edge between them; `changed` is false when there was none. */
function applyDepRemove(run: Run, plan: Plan, at: string): Json {
  const { ctx } = run;
  const p = plan.payload;
  checkMembers(p, ["source", "target"], at, `${at}.`);
  const source = refAt(run, p.source, `${at}.source`, plan.index).id;
  const target = refAt(run, p.target, `${at}.target`, plan.index).id;
  const existing = one<{ type: string; metadata: string }>(
    ctx.sql, "SELECT type, metadata FROM dependencies WHERE tracker = ?1 AND issue_id = ?2 AND depends_on_id = ?3", ctx.tracker, source, target);
  if (existing) {
    ctx.sql.exec("DELETE FROM dependencies WHERE tracker = ?1 AND issue_id = ?2 AND depends_on_id = ?3", ctx.tracker, source, target);
    recordEdgeRemoved(ctx, source, target, existing.type, existing.metadata);
    // An edge this request added and then removed is no longer one for the end gate to judge.
    run.edges = run.edges.filter((e) => !(e.issue_id === source && e.depends_on_id === target));
  }
  return { kind: "x_dep_remove", issue_id: source, depends_on_id: target, changed: existing !== undefined, revision: "0" };
}

/** `x_comment`: `{target, text}`. Adds a comment, authored by the verified principal like `addComment`. */
function applyComment(run: Run, plan: Plan, actor: string, at: string): Json {
  const { ctx } = run;
  const p = plan.payload;
  checkMembers(p, ["target", "text"], at, `${at}.`);
  const id = refAt(run, p.target, `${at}.target`, plan.index).id;
  const out = addComment(ctx, id, { author: actor, text: p.text });
  const comment = out.body as { id: string };
  return { kind: "x_comment", issue_id: id, x_comment_id: comment.id, changed: true, revision: String(loadIssue(ctx.sql, ctx.tracker, id)!.version) };
}

/** `x_set_config` `{key, value}` and `x_unset_config` `{key}`: the settings plane, as `POST /config` and `DELETE /config/{key}`. */
function applyConfig(run: Run, plan: Plan, at: string): Json {
  const { ctx } = run;
  const p = plan.payload;
  const setting = plan.kind === "x_set_config";
  checkMembers(p, setting ? ["key", "value"] : ["key"], at, `${at}.`);
  if (typeof p.key !== "string" || p.key === "") throw invalid(`${at}.key`, "`key` is required");
  if (setting && typeof p.value !== "string") throw invalid(`${at}.value`, "`value` is required and must be a string");
  const before = all<{ value: string }>(ctx.sql, "SELECT value FROM config WHERE tracker = ?1 AND key = ?2", ctx.tracker, p.key)[0]?.value;
  if (setting) setConfig(ctx, { key: p.key, value: p.value });
  else unsetSetting(ctx, p.key);
  const changed = setting ? before !== p.value : before !== undefined;
  return { kind: plan.kind, key: p.key, changed, revision: "0" };
}

/**
 * The end gate (batch_apply.go): after every item landed, each scheduling edge the request added is
 * validated against the graph the whole request produced. `skip_per_edge_cycle_check` never skips it.
 */
function endGate(run: Run): void {
  const { sql, tracker } = run.ctx;
  for (const e of run.edges) {
    if (!SCHEDULING_TYPES.includes(e.type)) continue;
    const target = one<{ n: number }>(sql, "SELECT COUNT(*) AS n FROM issues WHERE tracker = ?1 AND id = ?2", tracker, e.depends_on_id)!.n > 0;
    if (target && (e.type === "blocks" || e.type === "conditional-blocks")) {
      const ancestor = reaches(sql, tracker, e.issue_id, e.depends_on_id, ["parent-child"]);
      const descendant = reaches(sql, tracker, e.depends_on_id, e.issue_id, ["parent-child"]);
      if (ancestor || descendant) {
        throw refuse("dependency_cycle", "a blocking edge against the issue's own ancestor or descendant would never clear", {
          issue_id: e.issue_id,
          blocker_id: e.depends_on_id,
          blocker_is_ancestor: ancestor,
        });
      }
    }
    if (reaches(sql, tracker, e.depends_on_id, e.issue_id, SCHEDULING_TYPES)) {
      throw refuse("dependency_cycle", "the requested edges would create a dependency cycle; nothing was written");
    }
  }
}
