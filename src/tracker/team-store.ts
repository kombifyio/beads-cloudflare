// One Durable Object per team. The Worker decides who may call; this object runs each mutation as
// one synchronous transaction: invariant checks, the change, its events and the idempotency receipt.
import { DurableObject } from "cloudflare:workers";
import { trackerAllowed, type Principal } from "../auth/scopes";
import { addDependencies, removeDependency } from "./edges";
import { listEvents, type Ctx } from "./events";
import { addComment, createIssue, getIssue, idCandidates, listIssues, updateIssue, type GetOptions, type ListQuery } from "./issues";
import { claimIssue, claimNext, closeIssue, heartbeatIssue, reclaimExpiredLeases, releaseIssue, reopenIssue } from "./lifecycle";
import { hasExpiredClaims, migrateLegacyClaims, releaseExpiredClaims } from "./claims";
import { forgetMemory, getMemory, listMemories, rememberMemory } from "./memories";
import { authenticateKey, generateKey, insertKey, insertExchangeKey, listKeys, revokeKey, type KeyInfo, type KeyRequest, type NewKey } from "./keys";
import { forbiddenTracker, Refusal, refuse, problemOut, rejectedWrite } from "./problem";
import type { Out } from "./problem";
import { countReady, listReady, type ReadyFilter } from "./ready";
import { migrateColumns, normalizeRows, SCHEMA, SCHEMA_VERSION } from "./schema";
import { customStatusNames, customStatusesDetailed, customTypeNames, exportSettings, getConfig, infraTypes, listSettings, setConfig, setSetting, settingJson, unsetSetting } from "./config";
import { countIssues, getStats } from "./counts";
import { applyBatch, batchCloseIssues, batchCreateIssues } from "./batch";
import { countDependencyEdges, getDependencyTree, listBlockingAnnotations, listDependencies, listDependencyCycles, listRelatedIssues } from "./graph";
import { importRecords, projectIdOf } from "./import";
import { exportDependencies, exportIssues } from "./export";
import { compareAndSetMetadata, deleteIssues, sweepIssues } from "./maintenance";
import { queryIssues } from "./query";
import { isTrackerId, nowIso, safeJson, setOwn, type Json } from "./util";
import { advanceTrackerRevision, trackerRevision } from "./revision";
import { contextFor } from "./context";
import { HealthMeter, type HealthSample } from "./health";

export type WriteOp =
  | "createIssue" | "updateIssue" | "closeIssue" | "reopenIssue" | "claimIssue" | "releaseIssue" | "claimNextIssue"
  | "heartbeatIssue" | "reclaimExpiredLeases"
  | "setConfig" | "setSetting" | "unsetSetting"
  | "batchCreateIssues" | "batchCloseIssues" | "applyBatch" | "deleteIssues" | "sweepIssues" | "compareAndSetMetadata" | "importRecords"
  | "addComment" | "addDependencies" | "removeDependency" | "rememberMemory" | "forgetMemory";

export type ReadOp =
  | "getIssue" | "listIssues" | "listReadyWork" | "countReadyWork" | "listMemories" | "getMemory" | "listEvents"
  | "getSetting" | "listSettings" | "exportSettings" | "getCustomStatuses" | "getCustomStatusesDetailed" | "getCustomTypes" | "getInfraTypes"
  | "getStats" | "countIssues" | "queryIssues" | "listDependencies" | "countDependencyEdges" | "listBlockingAnnotations"
  | "getDependencyTree" | "listDependencyCycles" | "listRelatedIssues" | "exportIssues" | "exportDependencies";

/** Everything an operation needs; the principal is the verified identity the Worker passes in. */
export interface Call {
  tracker: string;
  principal: Principal;
  /** Path id (issue id, memory key). */
  id?: string;
  /** Request body of a write, as parsed JSON. */
  body?: Json;
  /** Typed parameters of the reads added after the first release (decoded by src/http/params.ts). */
  params?: Json;
  /** Typed filters of a read. */
  filter?: ReadyFilter;
  list?: ListQuery;
  get?: GetOptions;
  search?: string;
  since?: number;
  limit?: number;
  /** X-Beads-Agent: client-asserted agent or session name, recorded as client actor only. */
  agent?: string;
  /** Version from an If-Match header. */
  ifMatch?: number;
  /** The caller holds beads:import (decided by the Worker from the credential's scopes). */
  preserveProvenance?: boolean;
  /** Idempotency-Key and the SHA-256 of the canonical request, for writes. */
  idem?: { key: string; hash: string };
}

const badTracker = () =>
  problemOut("invalid_argument", "`tracker` must be lower-case letters, digits and single dashes, at most 40 characters", {
    param: "tracker",
    reason: "invalid_value",
  });

const RECEIPT_TTL_MS = 7 * 24 * 3600_000;
const PRUNE_EVERY_MS = 3600_000;

export class TeamStore extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private lastPrune = 0;
  private lastExchangePrune = 0;
  private readonly meter = new HealthMeter();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(SCHEMA);
    // SCHEMA only creates missing tables; an object that predates a new column
    // keeps the old shape. See COLUMN_MIGRATIONS for why that is not theoretical.
    migrateColumns(this.sql);
    normalizeRows(this.sql);
    this.sql.exec("INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', ?)", String(SCHEMA_VERSION));
    // Locks that predate real claims are released once, before the first request sees them.
    // A failure rolls the migration back and is retried at the next activation; it must never keep the store down.
    try {
      const migrated = this.ctx.storage.transactionSync(() => migrateLegacyClaims(this.sql, nowIso()));
      if (migrated) console.log(JSON.stringify({ event: "claims_migrated", ...migrated }));
    } catch (e) {
      console.error(JSON.stringify({ event: "claims_migration_failed", error: e instanceof Error ? e.message : String(e) }));
    }
  }

  /**
   * Releases the tracker's lapsed claims before a request looks at it, in a transaction of their own so a refused
   * write cannot roll the release back. Returns how many claims it released.
   */
  private releaseLapsed(tracker: string): number {
    const now = nowIso();
    if (!hasExpiredClaims(this.sql, tracker, now)) return 0;
    return this.ctx.storage.transactionSync(() => releaseExpiredClaims(this.sql, tracker, now));
  }

  /** The scheduled sweep: every tracker's lapsed claims, so an idle tracker shows the truth too. */
  releaseLapsedClaims(): { tracker: string; released: number }[] {
    const trackers = this.sql.exec<{ tracker: string }>("SELECT DISTINCT tracker FROM issues WHERE status = 'in_progress' AND lease_expires_at IS NOT NULL").toArray();
    return trackers.map(({ tracker }) => ({ tracker, released: this.releaseLapsed(tracker) })).filter((r) => r.released > 0);
  }

  read(op: ReadOp, call: Call): Out {
    if (!isTrackerId(call.tracker)) return badTracker();
    if (!trackerAllowed(call.principal, call.tracker)) return forbiddenTracker(call.tracker);
    this.meter.request();
    try {
      this.releaseLapsed(call.tracker);
      return this.runRead(op, call);
    } catch (e) {
      if (e instanceof Refusal) return e.out;
      this.meter.failure();
      throw e;
    }
  }

  async write(op: WriteOp, call: Call): Promise<Out> {
    if (!isTrackerId(call.tracker)) return badTracker();
    if (!trackerAllowed(call.principal, call.tracker)) return forbiddenTracker(call.tracker);
    const now = nowIso();
    const started = Date.now();
    this.meter.request();
    // Hashing is async in workerd, so id candidates are prepared before the synchronous transaction.
    const candidates = await this.candidatesFor(op, call, now);
    try {
      this.releaseLapsed(call.tracker);
      const out = this.ctx.storage.transactionSync(() => this.runWrite(op, call, now, candidates));
      this.meter.write(Date.now() - started);
      return out;
    } catch (e) {
      if (e instanceof Refusal) return rejectedWrite(e.out);
      this.meter.failure();
      throw e;
    }
  }

  // Agent API keys. Management is authorized by the Worker; these methods only run the storage.

  /** Creates a key; the returned `key` is the only time the secret is available. */
  async createKey(request: KeyRequest, createdBy: string): Promise<KeyInfo & { key: string }> {
    const key = await generateKey();
    const created = this.ctx.storage.transactionSync(() => insertKey(this.sql, key, request, createdBy, nowIso()));
    return { ...created, key: key.token };
  }

  /** The Worker has verified GitHub access; storage keeps only the derived credential's digest. */
  createExchangeKey(key: NewKey, request: KeyRequest, createdBy: string): KeyInfo | null {
    const now = nowIso();
    return this.ctx.storage.transactionSync(() => {
      if (Date.parse(now) - this.lastExchangePrune >= PRUNE_EVERY_MS) {
        this.sql.exec("DELETE FROM api_keys WHERE created_by LIKE 'github-exchange:%' AND expires_at < ?", new Date(Date.parse(now) - 86_400_000).toISOString());
        this.lastExchangePrune = Date.parse(now);
      }
      return insertExchangeKey(this.sql, key, request, createdBy, now);
    });
  }

  listKeys(): KeyInfo[] {
    return listKeys(this.sql);
  }

  /** Returns the revoked key, or null when no key has that id. */
  revokeKey(id: string): KeyInfo | null {
    try {
      return revokeKey(this.sql, id, nowIso());
    } catch (e) {
      if (e instanceof Refusal) return null;
      throw e;
    }
  }

  /** The principal for a presented key (id and SHA-256 of the secret), or null. */
  authenticateKey(id: string, secretHash: string): Principal | null {
    return authenticateKey(this.sql, id, secretHash, nowIso());
  }

  /** Project id of a tracker (the one an import stored, else its own name). */
  projectIdOf(tracker: string): string {
    return projectIdOf(this.sql, tracker);
  }

  /** Project identity and revision are read synchronously from the same tracker state. */
  contextOf(tracker: string) {
    if (!isTrackerId(tracker)) throw refuse("invalid_argument", "invalid tracker");
    return contextFor(tracker, projectIdOf(this.sql, tracker), trackerRevision(this.sql, tracker));
  }

  /** Storage figures read now plus the request, error and write-latency figures since the previous sample. */
  healthSample(): HealthSample {
    const n = (table: string) => this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).one().n;
    return {
      at: nowIso(),
      storage_bytes: this.sql.databaseSize,
      rows: { issues: n("issues"), events: n("events"), comments: n("comments"), dependencies: n("dependencies") },
      ...this.meter.drain(),
    };
  }

  /** Issue counts per tracker and status, for an operator checking a migration. */
  trackerSummary(): { tracker: string; issues: number; by_status: Record<string, number>; memories: number; settings: number }[] {
    const out = new Map<string, { tracker: string; issues: number; by_status: Record<string, number>; memories: number; settings: number }>();
    const entry = (tracker: string) => {
      let e = out.get(tracker);
      if (!e) out.set(tracker, (e = { tracker, issues: 0, by_status: {}, memories: 0, settings: 0 }));
      return e;
    };
    for (const r of this.sql.exec<{ tracker: string; status: string; n: number }>("SELECT tracker, status, COUNT(*) AS n FROM issues GROUP BY tracker, status").toArray()) {
      const e = entry(r.tracker);
      e.issues += r.n;
      setOwn(e.by_status, r.status, r.n);
    }
    for (const r of this.sql.exec<{ tracker: string; n: number }>("SELECT tracker, COUNT(*) AS n FROM memories GROUP BY tracker").toArray()) entry(r.tracker).memories = r.n;
    for (const r of this.sql.exec<{ tracker: string; n: number }>("SELECT tracker, COUNT(*) AS n FROM config GROUP BY tracker").toArray()) entry(r.tracker).settings = r.n;
    return [...out.values()].sort((a, b) => (a.tracker < b.tracker ? -1 : 1));
  }

  /**
   * Hashing is async in workerd, so the id candidates of every create the request carries are prepared
   * before the synchronous transaction: one list per item (a single create is item 0).
   */
  private async candidatesFor(op: WriteOp, call: Call, now: string): Promise<string[][]> {
    const forItem = async (item: unknown, index = 0): Promise<string[]> => {
      const b = item !== null && typeof item === "object" ? (item as Json) : {};
      const title = typeof b.title === "string" ? b.title.trim() : "";
      const description = typeof b.description === "string" ? b.description : "";
      return idCandidates(this.sql, call.tracker, title, description, call.principal.email, now, index);
    };
    const body = call.body ?? {};
    if (op === "createIssue") return [await forItem(body)];
    if (op === "batchCreateIssues" && Array.isArray(body.items)) return Promise.all(body.items.map((item, index) => forItem(item, index)));
    if (op === "applyBatch" && Array.isArray(body.items)) {
      return Promise.all(body.items.map((i, index) => (i !== null && typeof i === "object" && (i as Json).kind === "create" ? forItem((i as Json).create, index) : [])));
    }
    return [];
  }

  private runRead(op: ReadOp, call: Call): Out {
    const { sql } = this;
    const { tracker } = call;
    switch (op) {
      case "getIssue": return getIssue(sql, tracker, call.id ?? "", call.get ?? {});
      case "listIssues": return listIssues(sql, tracker, call.list ?? {});
      case "listReadyWork": return { status: 200, body: listReady(sql, tracker, call.filter ?? {}, nowIso()) };
      case "countReadyWork": return { status: 200, body: countReady(sql, tracker, call.filter ?? {}, nowIso()) };
      case "listMemories": return listMemories(sql, tracker, call.search);
      case "getMemory": return getMemory(sql, tracker, call.id ?? "");
      case "listEvents": return listEvents(sql, tracker, call.since, call.limit);
      case "getSetting": return { status: 200, body: settingJson(call.id ?? "", getConfig(sql, tracker, call.id ?? "")) };
      case "listSettings": return { status: 200, body: listSettings(sql, tracker) };
      case "exportSettings": return { status: 200, body: exportSettings(sql, tracker, call.params as { cursor?: string; limit?: number }) };
      case "getStats": return getStats(sql, tracker, call.params as never, nowIso());
      case "countIssues": return countIssues(sql, tracker, call.params as never);
      case "queryIssues": return queryIssues(sql, tracker, call.params as never, new Date());
      case "exportIssues": return exportIssues(sql, tracker, call.params as never);
      case "exportDependencies": return exportDependencies(sql, tracker, call.params as never);
      case "listDependencies": return listDependencies(sql, tracker, call.params as never);
      case "countDependencyEdges": return countDependencyEdges(sql, tracker, call.params as never);
      case "listBlockingAnnotations": return listBlockingAnnotations(sql, tracker, (call.params as { ids: string[] }).ids);
      case "getDependencyTree": return getDependencyTree(sql, tracker, call.params as never);
      case "listDependencyCycles": return listDependencyCycles(sql, tracker);
      case "listRelatedIssues": return listRelatedIssues(sql, tracker, call.id ?? "", call.params as never);
      case "getCustomStatuses": return { status: 200, body: { statuses: customStatusNames(sql, tracker) } };
      case "getCustomStatusesDetailed":
        return { status: 200, body: { statuses: customStatusesDetailed(sql, tracker) } };
      case "getCustomTypes": return { status: 200, body: { types: customTypeNames(sql, tracker) } };
      case "getInfraTypes": return { status: 200, body: { types: infraTypes(sql, tracker) } };
    }
  }

  private runWrite(op: WriteOp, call: Call, now: string, candidates: string[][]): Out {
    const { principal, idem } = call;
    if (idem) {
      // An expired receipt must not replay: drop it, inside this transaction, before the lookup.
      this.sql.exec("DELETE FROM receipts WHERE principal = ? AND key = ? AND created_at < ?", principal.sub, idem.key, Date.parse(now) - RECEIPT_TTL_MS);
      const receipt = this.sql
        .exec<{ request_hash: string; status: number; body: string; etag: string | null }>(
          "SELECT request_hash, status, body, etag FROM receipts WHERE principal = ? AND key = ?",
          principal.sub,
          idem.key,
        )
        .toArray()[0];
      const replay = receipt ? safeJson(receipt.body, undefined) : undefined;
      // A receipt whose stored body no longer parses cannot be replayed: drop it and run the request.
      if (receipt && replay === undefined) this.sql.exec("DELETE FROM receipts WHERE principal = ? AND key = ?", principal.sub, idem.key);
      if (receipt && replay !== undefined) {
        if (receipt.request_hash !== idem.hash) {
          throw refuse("precondition_failed", "this Idempotency-Key was already used with a different request; send a new key for a new request", {
            param: "Idempotency-Key",
            reason: "idempotency_key_reused",
          });
        }
        return { status: receipt.status, body: replay, ...(receipt.etag ? { etag: receipt.etag } : {}), replayed: true };
      }
    }

    const ctx: Ctx = { sql: this.sql, tracker: call.tracker, actor: principal.email, agent: call.agent, preserveProvenance: call.preserveProvenance, now };
    const out = this.dispatch(op, ctx, call, candidates);
    if (out.status < 400) {
      const revision = advanceTrackerRevision(this.sql, call.tracker);
      if (op === "importRecords" && call.body?.restore_guard !== undefined) {
        out.body = { ...(out.body as Json), x_mutation_revision: revision };
      }
    }

    if (idem) {
      this.sql.exec(
        "INSERT INTO receipts (principal, key, request_hash, status, body, etag, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        principal.sub, idem.key, idem.hash, out.status, JSON.stringify(out.body), out.etag ?? null, Date.parse(now),
      );
      this.pruneReceipts(Date.parse(now));
    }
    return out;
  }

  private dispatch(op: WriteOp, ctx: Ctx, call: Call, candidates: string[][]): Out {
    const body = call.body ?? {};
    const id = call.id ?? "";
    switch (op) {
      case "createIssue": return createIssue(ctx, body, candidates[0] ?? []);
      case "updateIssue": return updateIssue(ctx, id, body, { ifMatch: call.ifMatch });
      case "closeIssue": return closeIssue(ctx, id, body);
      case "reopenIssue": return reopenIssue(ctx, id, body);
      case "claimIssue": return claimIssue(ctx, id, body);
      case "releaseIssue": return releaseIssue(ctx, id, body);
      case "claimNextIssue": return claimNext(ctx, call.filter ?? {}, body);
      case "heartbeatIssue": return heartbeatIssue(ctx, id, body);
      case "reclaimExpiredLeases": return reclaimExpiredLeases(ctx, call.filter ?? {}, body);
      case "addComment": return addComment(ctx, id, body);
      case "addDependencies": return addDependencies(ctx, body);
      case "removeDependency": return removeDependency(ctx, body);
      case "rememberMemory": return rememberMemory(ctx, body);
      case "forgetMemory": return forgetMemory(ctx, id);
      case "setConfig": return setConfig(ctx, body);
      case "setSetting": return setSetting(ctx, id, body);
      case "unsetSetting": return unsetSetting(ctx, id);
      case "batchCreateIssues": return batchCreateIssues(ctx, body, candidates);
      case "applyBatch": return applyBatch(ctx, body, candidates);
      case "batchCloseIssues": return batchCloseIssues(ctx, body);
      case "deleteIssues": return deleteIssues(ctx, body);
      case "sweepIssues": return sweepIssues(ctx, body);
      case "compareAndSetMetadata": return compareAndSetMetadata(ctx, id, body);
      case "importRecords": return importRecords(ctx, body);
      default: return problemOut("internal", "internal server error");
    }
  }

  /** Receipts live seven days; pruning is opportunistic, at most once an hour per object. */
  private pruneReceipts(nowMs: number): void {
    if (nowMs - this.lastPrune < PRUNE_EVERY_MS) return;
    this.lastPrune = nowMs;
    this.sql.exec("DELETE FROM receipts WHERE created_at < ?", nowMs - RECEIPT_TTL_MS);
  }
}
