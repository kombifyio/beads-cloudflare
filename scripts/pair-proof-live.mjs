#!/usr/bin/env node
// Maintainer admission: the deployed wrapper must expose exact source identity.
// Provision only finite shared-test access; the tested processes never receive admin custody.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';

const base = process.env.BEADS_CLOUDFLARE_BASE;
const origin = base ? new URL(base) : null;
const expectedSha = process.env.PAIR_WORKER_SOURCE_SHA;
const admin = process.env.BEADS_CLOUDFLARE_ADMIN_TOKEN;
if (!origin || origin.protocol !== 'https:' || origin.pathname !== '/' || origin.username || origin.password || origin.search || origin.hash
    || !/^[a-f0-9]{40}$/.test(expectedSha || '') || !admin) {
  throw new Error('live pair requires an explicit HTTPS store, full Worker source SHA and company test-provisioner custody');
}
const version = fs.readFileSync(new URL('../VERSION', import.meta.url), 'utf8').trim();
const prefix = `cf-test-${randomBytes(5).toString('hex')}`;
const pool = Array.from({ length: 400 }, (_, index) => `${prefix}-t${String(index).padStart(3, '0')}`);
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'beads-live-pair-'));
if (path.dirname(path.resolve(work)) !== path.resolve(os.tmpdir()) || !path.basename(work).startsWith('beads-live-pair-')) throw new Error('unsafe live pair scratch path');
const usedFile = path.join(work, 'used-trackers.jsonl');
fs.writeFileSync(usedFile, pool.slice(0, 2).map(tracker => JSON.stringify(tracker)).join('\n') + '\n');
let key;
let failure;
const request = async (route, token, method = 'GET', body) => {
  const response = await fetch(`${base.replace(/\/$/, '')}${route}`, {
    method, redirect: 'error', signal: AbortSignal.timeout(15_000),
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`live pair request refused: ${method} ${route}, HTTP ${response.status}`); }
  return response.json();
};
const exportRoute = '/issues:export?include_templates=true&include_gates=true&include_infra=true&include_ephemeral=true&limit=500';
try {
  // A combined Worker/public Delivery can activate this exact source concurrently.
  let ready = false;
  const activationDeadline = Date.now() + 5 * 60_000;
  while (Date.now() < activationDeadline) {
    const response = await fetch(`${base.replace(/\/$/, '')}/healthz`, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
    const health = response.ok ? await response.json() : null;
    if (health?.status === 'ok' && health.source_sha === expectedSha && health.worker_version?.tag === expectedSha) { ready = true; break; }
    await new Promise(resolve => setTimeout(resolve, Math.min(60_000, Math.max(0, activationDeadline - Date.now()))));
  }
  if (!ready) throw new Error('live pair Worker source identity did not activate');
  key = await request('/admin/keys', admin, 'POST', {
    label: `shared-test:${prefix}`, scopes: ['beads:read', 'beads:write', 'beads:import'], trackers: pool, expires_in_days: 1,
  });
  const expiry = Date.parse(key.expires_at);
  if (!key.id || !key.key || key.trackers?.length !== pool.length || !pool.every(tracker => key.trackers.includes(tracker))
      || !Number.isFinite(expiry) || expiry <= Date.now() || expiry > Date.now() + 25 * 3600_000) throw new Error('test credential qualification failed');
  const denied = await fetch(`${base.replace(/\/$/, '')}/t/${prefix}-outside/v0/beads/context`, {
    headers: { Authorization: `Bearer ${key.key}` }, redirect: 'error', signal: AbortSignal.timeout(10_000),
  });
  await denied.body?.cancel();
  if (denied.status !== 403) throw new Error('shared test key is not restricted to its admitted pool');
  const context = await request(`/t/${pool[0]}/v0/beads/context`, key.key);
  if (context.x_store_version !== version || context.x_source_sha !== expectedSha) throw new Error('live pair version/source mismatch');
  console.log(`live pair: Worker ${expectedSha}, version ${version}, finite shared-test pool ${prefix}`);
  const childEnv = { ...process.env, BEADS_CLOUDFLARE_TOKEN: key.key, PAIR_TEST_POOL: JSON.stringify(pool), PAIR_USED_TRACKERS: usedFile };
  for (const name of Object.keys(childEnv)) {
    if (name !== 'BEADS_CLOUDFLARE_TOKEN' && /TOKEN|SECRET|PRIVATE_KEY|PASSWORD/i.test(name)) delete childEnv[name];
  }
  await new Promise((resolve, reject) => {
    const bash = process.platform === 'win32' ? path.join(process.env.ProgramFiles || 'C:/Program Files', 'Git', 'bin', 'bash.exe') : 'bash';
    const child = spawn(bash, ['scripts/pair-proof.sh'], { cwd: path.resolve(import.meta.dirname, '..'), env: childEnv, stdio: 'inherit', windowsHide: true });
    const stop = () => child.kill('SIGTERM');
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    child.once('error', reject);
    child.once('exit', code => {
      process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop);
      code === 0 ? resolve() : reject(new Error(`live pair child failed (${code})`));
    });
  });
} catch (error) { failure = error; }
finally {
  const cleanupErrors = [];
  if (key?.id && key?.key) {
    let used = pool;
    try { used = [...new Set(fs.readFileSync(usedFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)))]; }
    catch { cleanupErrors.push('test-fixture-report'); }
    for (const tracker of used) {
      try {
        if (!pool.includes(tracker)) throw new Error('cleanup tracker is outside the admitted pool');
        const route = `/t/${tracker}/v0/beads`;
        for (;;) {
          const page = await request(route + exportRoute, key.key);
          if (!page.items.length) break;
          await request(route + '/issues:delete', key.key, 'POST', { ids: page.items.map(issue => issue.id), force: true, cascade: true });
        }
        for (const memory of (await request(route + '/memories', key.key)).items) await request(route + `/memories/${encodeURIComponent(memory.key)}`, key.key, 'DELETE');
        // Unset intentionally preserves normalized vocabularies in the upstream contract.
        // Clear their projections before deleting the fixture's setting rows.
        for (const name of ['status.custom', 'types.custom']) await request(route + `/config/${name}`, key.key, 'PUT', { value: '' });
        // Ordinary enumeration deliberately hides kv.*. Drain bounded full export
        // pages instead, so portable generic key fixtures cannot survive cleanup.
        for (;;) {
          const page = await request(route + '/config:export?limit=200', key.key);
          if (!page.items.length) break;
          for (const setting of page.items) await request(route + `/config/${encodeURIComponent(setting.key)}`, key.key, 'DELETE');
        }
        const [issues, memories, settings, edges] = await Promise.all([
          request(route + exportRoute, key.key), request(route + '/memories', key.key),
          request(route + '/config:export?limit=1', key.key), request(route + '/dependencies:export', key.key),
        ]);
        if ([issues, memories, settings, edges].some(page => page.items.length || page.has_more)) throw new Error('live test fixture cleanup did not empty active state');
        const statuses = await request(route + '/config:statuses', key.key);
        const types = await request(route + '/config:types', key.key);
        if (statuses.statuses.length || types.types.length) throw new Error('live test vocabulary cleanup did not empty fixture projections');
      } catch (error) { cleanupErrors.push(tracker); console.error(`live pair cleanup refused for ${tracker}: ${error.message}`); }
    }
    try {
      await request(`/admin/keys/${encodeURIComponent(key.id)}`, admin, 'DELETE');
      const listed = await request('/admin/keys', admin);
      if (!listed.items.find(item => item.id === key.id)?.revoked_at) throw new Error('test key revocation was not read back');
      const denied = await fetch(`${base.replace(/\/$/, '')}/t/${pool[0]}/v0/beads/context`, { headers: { Authorization: `Bearer ${key.key}` }, redirect: 'error', signal: AbortSignal.timeout(10_000) });
      await denied.body?.cancel();
      if (denied.status !== 401 && denied.status !== 403) throw new Error('revoked key still grants tracker access');
    } catch { cleanupErrors.push('test-credential-revocation'); }
    console.log(`live pair cleanup: ${used.length} test trackers, ${cleanupErrors.length ? 'FAILED' : 'empty active fixtures; key revoked and denial verified'}`);
  }
  fs.rmSync(work, { recursive: true, force: true });
  if (cleanupErrors.length) failure = new Error(`live pair cleanup failed for ${cleanupErrors.join(', ')}`);
}
if (failure) throw failure;
