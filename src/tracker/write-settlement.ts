import type { Call } from "./team-store";
import { canonicalJson } from "./util";
import { z } from "zod";
import { refuse, type Out } from "./problem";

const storedReceipt = z.object({ status: z.number().int().min(100).max(599), body: z.unknown(), etag: z.string().optional(), replayed: z.boolean().optional() }).strict();
// Permanent fences survive the expiring upstream idempotency cache. Only governed
// requests carrying a UUID operation header enter this ledger; old clients are unchanged.
export const WRITE_SETTLEMENT_SCHEMA = `
CREATE TABLE IF NOT EXISTS governed_write_operations (
  principal TEXT NOT NULL, tracker TEXT NOT NULL, operation TEXT NOT NULL, settled INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (principal, tracker, operation)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS governed_write_receipts (
  principal TEXT NOT NULL, tracker TEXT NOT NULL, operation TEXT NOT NULL, key TEXT NOT NULL,
  request_hash TEXT NOT NULL, response TEXT NOT NULL,
  PRIMARY KEY (principal, tracker, operation, key)
) WITHOUT ROWID;`;

export function governedReplay(sql: SqlStorage, call: Call): Out | undefined {
  if (!call.operationId) return;
  const { principal, tracker, operationId, idem } = call;
  if (!idem) throw refuse("invalid_argument", "Governed operations require an Idempotency-Key.");
  const receipt = sql.exec<{ request_hash: string; response: string }>(
    "SELECT request_hash, response FROM governed_write_receipts WHERE principal = ? AND tracker = ? AND operation = ? AND key = ?",
    principal.sub, tracker, operationId, idem.key).toArray()[0];
  if (receipt) {
    if (receipt.request_hash !== idem.hash) throw refuse("precondition_failed", "Operation key was already used for a different request.", { reason: "idempotency_key_reused" });
    return { ...storedReceipt.parse(JSON.parse(receipt.response)), replayed: true };
  }
  const operation = sql.exec<{ settled: number }>("SELECT settled FROM governed_write_operations WHERE principal = ? AND tracker = ? AND operation = ?", principal.sub, tracker, operationId).toArray()[0];
  if (operation?.settled) throw refuse("precondition_failed", "Operation is settled; this request was not applied.", { reason: "operation_settled" });
}

export function recordGovernedWrite(sql: SqlStorage, call: Call, out: Out): void {
  if (!call.operationId || !call.idem) return;
  sql.exec("INSERT OR IGNORE INTO governed_write_operations (principal, tracker, operation) VALUES (?, ?, ?)", call.principal.sub, call.tracker, call.operationId);
  sql.exec("INSERT OR IGNORE INTO governed_write_receipts (principal, tracker, operation, key, request_hash, response) VALUES (?, ?, ?, ?, ?, ?)",
    call.principal.sub, call.tracker, call.operationId, call.idem.key, call.idem.hash, canonicalJson(out));
}

/** Called inside the same synchronous storage transaction as writes. A seal fences even requests not yet received. */
export function writeSettlement(sql: SqlStorage, call: Call, seal: boolean): Out {
  const operationId = call.id!;
  if (seal) sql.exec("INSERT INTO governed_write_operations (principal, tracker, operation, settled) VALUES (?, ?, ?, 1) ON CONFLICT (principal, tracker, operation) DO UPDATE SET settled = 1", call.principal.sub, call.tracker, operationId);
  const operation = sql.exec<{ settled: number }>("SELECT settled FROM governed_write_operations WHERE principal = ? AND tracker = ? AND operation = ?", call.principal.sub, call.tracker, operationId).toArray()[0];
  // Project summaries in SQLite so a large batch does not hydrate every business response into Worker memory.
  const receipts = sql.exec<{ key: string; request_hash: string; status: number; id: string | null }>(
    "SELECT key, request_hash, json_extract(response, '$.status') AS status, json_extract(response, '$.body.id') AS id FROM governed_write_receipts WHERE principal = ? AND tracker = ? AND operation = ? ORDER BY key",
    call.principal.sub, call.tracker, operationId).toArray();
  return { status: 200, body: { operation: operationId, tracked: operation !== undefined, settled: operation?.settled === 1,
    outcome: operation?.settled ? receipts.some(row => row.status < 400) ? "applied" : "not_applied" : "unsettled", receipts } };
}
