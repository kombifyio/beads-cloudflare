import { createHash } from 'node:crypto';
import { applyBatch } from './batch';
import { checkMembers } from './body';
import { all, one } from './model';
import { invalid, refuse, type Out } from './problem';
import { trackerRevision } from './revision';
import { canonicalJson, isObject, safeJson, type Json } from './util';
import type { Ctx } from './events';

interface Row { [key: string]: SqlStorageValue; plan: string; plan_hash: string; next_chunk: number; expected_revision: number; created_at: string }
const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
function idCheck(id: string) { if (!/^[A-Za-z0-9._:-]{1,200}$/.test(id)) throw invalid('operation_id', 'operation id must be 1 to 200 ASCII letters, digits, dots, underscores, colons or dashes'); }
function get(sql: SqlStorage, tracker: string, principal: string, id: string): { row: Row; chunks: Json[] } {
  idCheck(id);
  const row = one<Row>(sql, 'SELECT plan,plan_hash,next_chunk,expected_revision,created_at FROM operations WHERE tracker = ? AND principal = ? AND id = ?', tracker, principal, id);
  if (!row) throw refuse('not_found', 'operation not found for this principal and tracker');
  const chunks = safeJson(row.plan, null);
  if (!Array.isArray(chunks) || !chunks.length || chunks.length > 100 || !chunks.every(isObject) || hash(row.plan) !== row.plan_hash || canonicalJson(chunks) !== row.plan || !Number.isSafeInteger(row.next_chunk) || row.next_chunk < 0 || row.next_chunk > chunks.length) throw refuse('internal', 'durable operation state is corrupt');
  let count = 0;
  let previous = -1;
  for (const r of sql.exec<{ chunk_index: number; result: string; result_hash: string; revision: number }>('SELECT chunk_index,result,result_hash,revision FROM operation_chunks WHERE tracker = ? AND principal = ? AND operation_id = ? ORDER BY chunk_index', tracker, principal, id)) {
    if (r.chunk_index !== count || safeJson(r.result, undefined) === undefined || hash(r.result) !== r.result_hash || !Number.isSafeInteger(r.revision) || (count > 0 && r.revision !== previous + 1)) throw refuse('internal', 'durable operation results are incomplete or corrupt');
    count++; previous = r.revision;
  }
  if (count !== row.next_chunk || (count > 0 && previous !== row.expected_revision)) throw refuse('internal', 'durable operation results are incomplete or corrupt');
  return { row, chunks };
}
export function inspectOperation(sql: SqlStorage, tracker: string, principal: string, id: string, params: { result_cursor?: number; result_limit?: number }): Out {
  const { row, chunks } = get(sql, tracker, principal, id);
  const cursor = params.result_cursor ?? 0, limit = params.result_limit ?? 20;
  if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > row.next_chunk) throw invalid('result_cursor', 'invalid operation result cursor');
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw invalid('result_limit', 'result_limit must be between 1 and 100');
  const records = all<{ chunk_index: number; result: string; revision: number }>(sql, 'SELECT chunk_index,result,revision FROM operation_chunks WHERE tracker = ? AND principal = ? AND operation_id = ? AND chunk_index >= ? ORDER BY chunk_index LIMIT ?', tracker, principal, id, cursor, limit);
  const results: { index: number; revision: number; result: unknown }[] = [];
  let bytes = 0;
  for (const r of records) {
    const size = new TextEncoder().encode(r.result).length + 128;
    if (bytes + size > 512 * 1024) { if (!results.length) throw refuse('internal', 'operation result exceeds response budget'); break; }
    bytes += size; results.push({ index: r.chunk_index, revision: r.revision, result: JSON.parse(r.result) });
  }
  const next = cursor + results.length;
  return { status: 200, body: { operation_id: id, tracker, plan_hash: row.plan_hash, plan: chunks, chunks: chunks.length, next_chunk: row.next_chunk, expected_revision: row.expected_revision, status: row.next_chunk === chunks.length ? 'complete' : 'pending', created_at: row.created_at, results, has_more_results: next < row.next_chunk, next_result_cursor: next < row.next_chunk ? next : null } };
}

export function createOperation(ctx: Ctx, principal: string, body: Json): Out {
  checkMembers(body, ['operation_id', 'expected_revision', 'chunks']);
  if (typeof body.operation_id !== 'string') throw invalid('operation_id', 'operation_id is required');
  idCheck(body.operation_id);
  if (!Number.isSafeInteger(body.expected_revision) || body.expected_revision !== trackerRevision(ctx.sql, ctx.tracker)) throw refuse('precondition_failed', 'tracker revision changed; recompose the operation', { reason: 'revision_changed' });
  if (!Array.isArray(body.chunks) || body.chunks.length < 1 || body.chunks.length > 100 || body.chunks.some(c => !isObject(c) || !Array.isArray(c.items) || c.items.length < 1 || c.items.length > 100)) throw invalid('chunks', 'chunks must contain 1 to 100 batch bodies, each with 1 to 100 items');
  const plan = canonicalJson(body.chunks);
  if (new TextEncoder().encode(plan).length > 3 * 1024 * 1024) throw invalid('chunks', 'operation plan exceeds 3 MiB');
  if (one(ctx.sql, 'SELECT 1 FROM operations WHERE tracker = ? AND principal = ? AND id = ?', ctx.tracker, principal, body.operation_id)) throw refuse('already_exists', 'operation id already exists; inspect it rather than replaying');
  const plan_hash = hash(plan);
  ctx.sql.exec('INSERT INTO operations (tracker,principal,id,plan,plan_hash,next_chunk,expected_revision,created_at) VALUES (?,?,?,?,?,0,?,?)', ctx.tracker, principal, body.operation_id, plan, plan_hash, (body.expected_revision as number) + 1, ctx.now);
  return { status: 200, body: { operation_id: body.operation_id, plan_hash, next_chunk: 0, chunks: body.chunks.length, expected_revision: (body.expected_revision as number) + 1 } };
}
export function operationChunk(sql: SqlStorage, tracker: string, principal: string, id: string, index: unknown): Json {
  const { row, chunks } = get(sql, tracker, principal, id);
  if (!Number.isSafeInteger(index) || index !== row.next_chunk || row.next_chunk >= chunks.length) throw refuse('precondition_failed', 'operation is not at that chunk; inspect its durable state', { reason: 'operation_position_changed' });
  return chunks[row.next_chunk]!;
}
export function advanceOperation(ctx: Ctx, principal: string, id: string, body: Json, candidates: string[][]): Out {
  checkMembers(body, ['expected_index']);
  const chunk = operationChunk(ctx.sql, ctx.tracker, principal, id, body.expected_index);
  const { row } = get(ctx.sql, ctx.tracker, principal, id);
  if (trackerRevision(ctx.sql, ctx.tracker) !== row.expected_revision) throw refuse('precondition_failed', 'tracker changed since the previous chunk; operation cannot silently rebase', { reason: 'revision_changed' });
  const out = applyBatch(ctx, chunk, candidates);
  const nextRevision = row.expected_revision + 1;
  const result = JSON.stringify(out.body);
  ctx.sql.exec('INSERT INTO operation_chunks (tracker,principal,operation_id,chunk_index,result,result_hash,revision) VALUES (?,?,?,?,?,?,?)', ctx.tracker, principal, id, row.next_chunk, result, hash(result), nextRevision);
  ctx.sql.exec('UPDATE operations SET next_chunk = next_chunk + 1, expected_revision = ? WHERE tracker = ? AND principal = ? AND id = ?', nextRevision, ctx.tracker, principal, id);
  return { status: 200, body: { operation_id: id, index: row.next_chunk, revision: nextRevision, result: out.body } };
}

export function listOperations(sql: SqlStorage, tracker: string, principal: string, after: string | undefined): Out {
  if (after !== undefined) idCheck(after);
  const rows = all<{ id: string; plan_hash: string; next_chunk: number; expected_revision: number; created_at: string }>(sql, 'SELECT id,plan_hash,next_chunk,expected_revision,created_at FROM operations WHERE tracker = ? AND principal = ? AND id > ? ORDER BY id LIMIT 101', tracker, principal, after ?? '');
  const items = rows.slice(0, 100).map(r => ({ operation_id: r.id, plan_hash: r.plan_hash, next_chunk: r.next_chunk, expected_revision: r.expected_revision, created_at: r.created_at }));
  return { status: 200, body: { tracker, items, has_more: rows.length > 100, next_cursor: rows.length > 100 ? items[items.length - 1]!.operation_id : null } };
}
