// Focused hosted Preview drill. Snapshot/restore are the existing operator CLI, not a second protocol.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { canonical, captureSnapshot, SNAPSHOT_MAX_BYTES } from '../src/tracker/snapshot-core.mjs';
import { assertEmptyDestination, snapshotFailureEvidence, verifySnapshot, writePrivateSnapshot } from './tracker-snapshot.mjs';

const requireThat = (ok, message) => { if (!ok) throw new Error(`logical recovery journey: ${message}`); };
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
const counts = state => ({ issues: state.issues.length, dependencies: state.dependencies.length,
  comments: state.issues.reduce((sum, issue) => sum + (issue.comments?.length ?? 0), 0), memories: state.memories.length, settings: state.settings.length });
const capture = (request, tracker) => captureSnapshot(request, tracker, { byteLength: text => Buffer.byteLength(text), eventLimit: 1000 });
const assertIdentity = (context, tracker, sourceSha) => {
  requireThat(context.x_source_sha === sourceSha, 'runtime source identity differs');
  const identity = context.x_identity;
  requireThat(identity?.verified_principal?.kind === 'key' && identity.authorized_trackers?.length === 1 && identity.authorized_trackers[0] === tracker,
    'requires an authenticated credential scoped only to its admitted tracker');
  if (identity.credential_expires_at !== undefined) {
    const expiry = Date.parse(identity.credential_expires_at);
    requireThat(Number.isFinite(expiry) && expiry > Date.now() && expiry <= Date.now() + 25 * 60 * 60_000, 'credential must have a finite test-session expiry');
  }
};

function api(base, token) {
  return async (tracker, suffix, method = 'GET', body) => {
    const response = await fetch(`${base}/t/${tracker}/v0/beads${suffix}`, {
      method, redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { Authorization: `Bearer ${token}`, 'X-Beads-Agent': 'shared-test-recovery',
        ...(body ? { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`logical recovery request refused: HTTP ${response.status}`); }
    const reader = response.body.getReader();
    const chunks = []; let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        requireThat(size <= SNAPSHOT_MAX_BYTES, 'response exceeds snapshot budget');
        chunks.push(value);
      }
    } catch (error) { await reader.cancel().catch(() => {}); throw error; }
    finally { reader.releaseLock(); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new Error('logical recovery response is invalid JSON; content withheld'); }
  };
}

async function snapshotCommand(command, file, { base, tracker, token }) {
  const args = [fileURLToPath(new URL('./tracker-snapshot.mjs', import.meta.url)), command, file];
  if (command !== 'verify') args.push('--tracker', tracker, '--quiesced');
  if (command === 'restore') args.push('--exclusive');
  const output = await new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(process.execPath, args, { env: { ...process.env, BEADS_CLOUDFLARE_BASE: base, BEADS_SNAPSHOT_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', size = 0, termination;
    child.stdout.on('data', chunk => { size += chunk.length; if (size > 65536) { termination = 'output-budget'; child.kill('SIGTERM'); } else stdout += chunk; });
    child.stderr.on('data', chunk => { size += chunk.length; if (size > 65536) { termination = 'output-budget'; child.kill('SIGTERM'); } else stderr += chunk; });
    const failed = (code, signal) => {
      let reported;
      try { reported = snapshotFailureEvidence(JSON.parse(stderr.trim().split('\n').at(-1)).snapshot_failure); }
      catch { /* Arbitrary operator stderr is never forwarded. */ }
      return Object.assign(new Error(`snapshot ${command} stopped; inspect before another restore`), {
        snapshotFailure: snapshotFailureEvidence({ ...reported, schema: 'beads.snapshot-failure.v1', command,
          subprocess: { elapsed_ms: Date.now() - started, exit_code: code, signal, termination } }),
      });
    };
    const timer = setTimeout(() => { termination = 'deadline'; child.kill('SIGKILL'); }, 120_000);
    child.once('error', () => { clearTimeout(timer); termination = 'spawn-error'; reject(failed()); });
    child.once('close', (code, signal) => { clearTimeout(timer); code === 0 && size <= 65536 ? resolve(stdout) : reject(failed(code, signal)); });
  });
  try { return JSON.parse(output.trim().split('\n').at(-1)); }
  catch { throw new Error(`snapshot ${command} acknowledgement is invalid; inspect before another restore`); }
}

/** Caller admits and exclusively owns this finite pool with expiring tracker-only read/write/import tokens.
 * The source may be reused after verified active-state cleanup; a destination is never reused.
 */
export async function verifyLogicalRecovery({ base, sourceSha, source, destinations }) {
  const started = Date.now();
  const origin = new URL(base);
  requireThat(origin.protocol === 'https:' && origin.hostname.startsWith('preview-') && origin.pathname === '/' && !origin.search && !origin.hash && !origin.username && !origin.password, 'requires an isolated HTTPS Preview origin');
  requireThat(/^[a-f0-9]{40}$/.test(sourceSha), 'requires an exact deployed source SHA');
  const prefix = `cf-test-drill-${sourceSha.slice(0, 8)}-`;
  requireThat(source?.tracker === `${prefix}s` && typeof source.token === 'string' && source.token, 'source must be the admitted source tracker');
  requireThat(Array.isArray(destinations) && destinations.length > 0 && destinations.length <= 4 && new Set(destinations.map(item => item.tracker)).size === destinations.length &&
    destinations.every(item => new RegExp(`^${prefix}d[0-3]$`).test(item.tracker) && typeof item.token === 'string' && item.token && item.token !== source.token) && new Set(destinations.map(item => item.token)).size === destinations.length, 'requires distinct tracker-scoped destination credentials in the bounded pool');
  base = origin.origin;
  const readSource = api(base, source.token);
  const initial = await capture(readSource, source.tracker);
  assertIdentity(initial.context, source.tracker, sourceSha);
  requireThat(initial.context.project_id === source.tracker, 'source project identity differs');
  requireThat([initial.state.issues, initial.state.dependencies, initial.state.memories, initial.state.settings, initial.state.vocabulary.statuses, initial.state.vocabulary.types].every(rows => rows.length === 0), 'source namespace has active state; inspect it before another drill');
  let destination;
  for (const candidate of destinations) {
    const request = api(base, candidate.token);
    const state = await capture(request, candidate.tracker);
    assertIdentity(state.context, candidate.tracker, sourceSha);
    try { assertEmptyDestination(state, candidate.tracker); }
    catch { continue; } // Inspection only. No restore has started on any candidate.
    destination = { ...candidate, request }; break;
  }
  requireThat(destination, 'all admitted destinations have prior state; a fresh exact-source pool is required');
  const artifactRoot = process.env.BEADS_RECOVERY_ARTIFACT_DIR;
  if (artifactRoot) {
    fs.mkdirSync(artifactRoot, { recursive: true, mode: 0o700 });
    fs.chmodSync(artifactRoot, 0o700);
  }
  const directory = fs.mkdtempSync(path.join(artifactRoot || os.tmpdir(), 'beads-preview-recovery-'));
  fs.chmodSync(directory, 0o700);
  const file = path.join(directory, 'fixture.snapshot.json');
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const ids = [`${source.tracker}-${suffix}a`, `${source.tracker}-${suffix}b`];
  const memory = `drill-${suffix}`;
  const setting = `kv.drill-${suffix}`;
  const marker = `shared-test recovery ${sourceSha} ${suffix}`;
  // Record ownership before the first write so an interrupted seed is inspectable
  // even when backup has not produced an archive yet. Credentials stay in memory.
  writePrivateSnapshot(path.join(directory, 'drill-manifest.json'), `${JSON.stringify({ source_sha: sourceSha, origin: base,
    source: source.tracker, destination: destination.tracker, ids, memory, setting, marker })}\n`);
  let sourceStarted = false, restoreStarted = false, restoredVerified = false, receipt, failure;
  let stage = 'seed', sourceCleanup, destinationCleanup;
  const clean = async (request, tracker, { allowRestored = false } = {}) => {
    const state = await capture(request, tracker);
    requireThat(state.context.project_id === (allowRestored ? source.tracker : tracker) &&
      state.state.issues.every(issue => ids.includes(issue.id) && issue.description === marker && issue.labels?.includes('shared-test') && issue.labels.includes('recovery-journey')) &&
      state.state.dependencies.every(edge => edge.issue_id === ids[1] && edge.depends_on_id === ids[0] && edge.type === 'blocks') &&
      state.state.memories.every(item => item.key === memory && item.value === marker) && state.state.settings.every(item => item.key === setting && item.value === marker) &&
      state.state.vocabulary.statuses.length === 0 && state.state.vocabulary.types.length === 0, 'cleanup found unexpected active state; retain namespace for inspection');
    if (state.state.issues.length) await request(tracker, '/issues:delete', 'POST', { actor: 'shared-test-recovery', ids: state.state.issues.map(issue => issue.id), force: true, cascade: false });
    for (const item of state.state.memories) await request(tracker, `/memories/${encodeURIComponent(item.key)}`, 'DELETE');
    for (const item of state.state.settings) await request(tracker, `/config/${encodeURIComponent(item.key)}`, 'DELETE');
    const after = await capture(request, tracker);
    requireThat([after.state.issues, after.state.dependencies, after.state.memories, after.state.settings].every(rows => rows.length === 0), 'cleanup did not empty owned active state');
    requireThat(after.context.project_id === (allowRestored ? source.tracker : tracker), 'cleanup changed project identity');
    requireThat(after.journal.head >= state.journal.head && after.context.x_mutation_revision >= state.context.x_mutation_revision, 'cleanup lost tracker history');
    return { active_state: 'empty', journal_retained: true, source_reusable: !allowRestored, destination_reusable: false,
      journal_head: after.journal.head, journal_sha256: digest(after.journal), mutation_revision: after.context.x_mutation_revision };
  };
  try {
    sourceStarted = true;
    for (const [index, id] of ids.entries()) await readSource(source.tracker, '/issues', 'POST', { actor: 'shared-test-recovery', id,
      title: `Shared-test recovery ${index + 1}`, issue_type: 'task', priority: index + 1, labels: ['shared-test', 'recovery-journey'], description: marker });
    await readSource(source.tracker, `/issues/${ids[1]}/comments`, 'POST', { author: 'shared-test-recovery', text: `${marker}\nComment and Unicode Ω survive recovery.` });
    await readSource(source.tracker, '/dependencies:add', 'POST', { actor: 'shared-test-recovery', edges: [{ issue_id: ids[1], depends_on_id: ids[0], type: 'blocks' }] });
    await readSource(source.tracker, '/memories', 'POST', { key: memory, content: marker });
    await readSource(source.tracker, `/config/${setting}`, 'PUT', { value: marker });
    stage = 'backup';
    const saved = await snapshotCommand('backup', file, { base, ...source });
    stage = 'verify';
    const checked = await snapshotCommand('verify', file, { base, ...source });
    stage = 'snapshot-assertion';
    const envelope = JSON.parse(fs.readFileSync(file, 'utf8'));
    const snapshot = verifySnapshot(envelope);
    requireThat(saved.digest === checked.digest && checked.digest === envelope.integrity.digest && snapshot.source.source_sha === sourceSha &&
      canonical(counts(snapshot.state)) === canonical({ issues: 2, dependencies: 1, comments: 1, memories: 1, settings: 1 }), 'snapshot fixture counts or digest differ');
    stage = 'restore'; restoreStarted = true;
    const restoration = await snapshotCommand('restore', file, { base, ...destination });
    stage = 'restore-readback';
    const restored = await capture(destination.request, destination.tracker);
    requireThat(restoration.recovery === 'VERIFIED' && restoration.digest === checked.digest && restored.context.x_source_sha === sourceSha &&
      canonical(restored.state) === canonical(snapshot.state), 'independent restore state differs from source');
    restoredVerified = true;
    receipt = { schema: 'beads.logical-recovery-journey.v1', source_sha: sourceSha, origin: base, snapshot_digest: checked.digest,
      source: { tracker: source.tracker, reused_empty_source: initial.context.x_mutation_revision > 0, store_version: snapshot.source.store_version, mutation_revision: snapshot.source.mutation_revision, counts: counts(snapshot.state), state_sha256: digest(snapshot.state), journal_head: snapshot.journal.head, journal_sha256: digest(snapshot.journal) },
      destination: { tracker: destination.tracker, store_version: restored.context.x_store_version, mutation_revision: restored.context.x_mutation_revision, counts: counts(restored.state), state_sha256: digest(restored.state), journal_head: restored.journal.head, journal_sha256: digest(restored.journal) },
      logical_restore: 'VERIFIED', journal: 'new-import-events-source-journal-archived', exclusions: snapshot.exclusions };
  } catch (error) {
    failure = error;
  } finally {
    const cleanupErrors = [];
    if (restoredVerified) {
      try { destinationCleanup = await clean(destination.request, destination.tracker, { allowRestored: true }); receipt.cleanup_destination = destinationCleanup; }
      catch (error) { cleanupErrors.push(error); }
    }
    if (sourceStarted) {
      try {
        sourceCleanup = await clean(readSource, source.tracker);
        if (receipt) receipt.cleanup_source = sourceCleanup;
      } catch (error) { cleanupErrors.push(error); }
    }
    if (receipt && cleanupErrors.length === 0) fs.rmSync(directory, { recursive: true, force: true });
    else if (restoreStarted && !restoredVerified) console.error(`logical recovery is uncertain; preserve ${destination.tracker} and private snapshot ${file} for inspection; no restore was replayed`);
    else console.error(`logical recovery did not complete; private snapshot custody retained at ${directory}`);
    if (cleanupErrors.length) {
      const original = failure;
      failure = new AggregateError([...(original ? [original] : []), ...cleanupErrors], `logical recovery cleanup could not be verified; private snapshot retained at ${directory}`);
      failure.snapshotFailure = snapshotFailureEvidence(original?.snapshotFailure);
    }
  }
  if (failure) throw Object.assign(failure, { recoveryEvidence: { source_sha: sourceSha,
    source: { tracker: source.tracker }, destination: { tracker: destination.tracker }, stage,
    restore_started: restoreStarted, restored_verified: restoredVerified,
    cleanup_source: sourceCleanup ? 'verified' : sourceStarted ? 'unknown' : 'not-started',
    cleanup_destination: destinationCleanup ? 'verified' : restoreStarted ? 'unknown' : 'not-started',
  } });
  receipt.elapsed_ms = Date.now() - started;
  receipt.report_sha256 = digest(receipt);
  return receipt;
}
