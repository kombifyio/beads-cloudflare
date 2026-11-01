import { createHash } from 'node:crypto';
import { invalid } from './problem';
import { isObject, type Json } from './util';

const digest = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const fields = ['id', 'criterion_id', 'criterion_digest', 'result', 'source', 'environment', 'run_id', 'observed_at', 'disposition'];
function inspect(value: unknown, acceptance: string): { state: string; results?: Record<string, number> } {
  if (value === undefined) return { state: 'missing' };
  if (!isObject(value) || Object.keys(value).some(k => !['version', 'entries'].includes(k)) || value.version !== 1 || !Array.isArray(value.entries) || value.entries.length > 32 || new TextEncoder().encode(JSON.stringify(value)).length > 32768) return { state: 'invalid' };
  const seen = new Set<string>();
  const results: Record<string, number> = { pass: 0, fail: 0, blocked: 0, not_run: 0 };
  let stale = false;
  for (const entry of value.entries) {
    if (!isObject(entry) || Object.keys(entry).some(k => !fields.includes(k))) return { state: 'invalid' };
    for (const k of ['id', 'criterion_id', 'environment', 'run_id', 'observed_at']) if (typeof entry[k] !== 'string' || !(entry[k] as string).trim() || (entry[k] as string).length > 512) return { state: 'invalid' };
    if (seen.has(entry.id as string)) return { state: 'invalid' };
    seen.add(entry.id as string);
    if (typeof entry.criterion_digest !== 'string' || !/^[a-f0-9]{64}$/.test(entry.criterion_digest)) return { state: 'invalid' };
    if (entry.criterion_digest !== digest(acceptance)) stale = true;
    if (typeof entry.result !== 'string' || !Object.hasOwn(results, entry.result)) return { state: 'invalid' };
    results[entry.result] = results[entry.result]! + 1;
    if (!isObject(entry.source) || Object.keys(entry.source).some(k => !['uri', 'revision', 'digest'].includes(k)) || typeof entry.source.uri !== 'string' || entry.source.uri.length > 2048 || !/^[a-z][a-z0-9+.-]*:/i.test(entry.source.uri) || !(typeof entry.source.revision === 'string' && entry.source.revision.length > 0 || typeof entry.source.digest === 'string' && entry.source.digest.length > 0) || Object.values(entry.source).some(v => typeof v !== 'string' || v.length > 2048)) return { state: 'invalid' };
    if (Number.isNaN(Date.parse(entry.observed_at as string)) || !/^\d{4}-\d\d-\d\dT/.test(entry.observed_at as string)) return { state: 'invalid' };
    if (entry.disposition !== undefined && (!isObject(entry.disposition) || Object.keys(entry.disposition).some(k => !['kind', 'reason', 'authority_uri'].includes(k)) || typeof entry.disposition.kind !== 'string' || !entry.disposition.kind.trim() || typeof entry.disposition.reason !== 'string' || !entry.disposition.reason.trim() || typeof entry.disposition.authority_uri !== 'string' || !/^[a-z][a-z0-9+.-]*:/i.test(entry.disposition.authority_uri) || Object.values(entry.disposition).some(v => typeof v !== 'string' || v.length > 2048))) return { state: 'invalid' };
  }
  return { state: stale ? 'stale' : 'recorded', results };
}
export function evidenceSummary(metadata: unknown, acceptance: string) {
  return inspect(isObject(metadata) ? metadata.beads_evidence : undefined, acceptance);
}
export function validateEvidence(metadata: Json, acceptance: string, param: string): void {
  const summary = evidenceSummary(metadata, acceptance);
  if (summary.state === 'invalid') throw invalid(param, 'beads_evidence must be version 1 with bounded entries and valid SHA-256 criterion digests');
}
