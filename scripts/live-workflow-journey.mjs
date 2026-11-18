// A bounded part of pair-proof-live: real HTTP/MCP calls under its finite shared-test credential.
// The caller owns fixture cleanup and credential revocation, including after a failed assertion.
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

const requireThat = (value, message) => { if (!value) throw new Error(`workflow journey: ${message}`); };

export async function verifyLiveWorkflows({ base, token, tracker, outsideTracker = 'cf-test-workflow-outside', sourceSha, expectedSha = sourceSha, externalRefOnly = false, reclaimOnly = false }) {
  const preview = tracker === 'preview-smoke' && new URL(base).hostname.startsWith('preview-');
  requireThat((preview || tracker.startsWith('cf-test-')) && outsideTracker.startsWith('cf-test-') && tracker !== outsideTracker, 'requires an admitted Preview or distinct marked shared-test trackers');
  requireThat(/^[a-f0-9]{40}$/.test(expectedSha), 'requires an exact Worker source SHA');
  const actor = 'journey-worker';
  const path = `/t/${tracker}/v0/beads`;
  const request = async (route, { method = 'GET', body, key } = {}) => {
    const response = await fetch(`${base.replace(/\/$/, '')}${route}`, {
      method, redirect: 'error', signal: AbortSignal.timeout(20_000),
      headers: { Authorization: `Bearer ${token}`, 'X-Beads-Agent': actor,
        ...(body ? { 'Content-Type': 'application/json' } : {}), ...(key ? { 'Idempotency-Key': key } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };
  const owned = [];
  const markers = new Map();
  const journeyReport = { source_sha: expectedSha, tracker, owned_ids: owned, cleanup: [] };
  try {
    const context = (await request(`${path}/context`)).body;
    requireThat(context.x_source_sha === expectedSha && context.x_identity?.worker_actor === actor, 'context source/worker identity differs');
    if (reclaimOnly) {
      journeyReport.reclaim = await verifyScopedReclaim({ path, request, owned, markers, tracker, actor });
      return journeyReport;
    }
    journeyReport.external_ref = await verifyExternalRefQuery({ path, request, owned, markers, tracker, outsideTracker, actor, report: journeyReport });
    if (externalRefOnly) return journeyReport;
    const identity = context.x_identity.verified_principal;
    const principal = identity.subject;
    const auditActor = identity.email;
    const id = `${tracker}-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    owned.push(id);
    const created = await request(`${path}/issues`, { method: 'POST', key: randomUUID(), body: { id, actor, title: 'Shared-test completion journey', issue_type: 'task', priority: 2, labels: ['shared-test', 'workflow-journey'] } });
    requireThat(created.status === 201 || created.status === 200, 'create refused');
    requireThat(created.body.id === id, 'create changed its explicit fixture identity');
    const initial = (await request(`/portfolio/actionable?trackers=${tracker}&worker=${actor}&allow_shared_repo=true&limit=500`)).body;
    requireThat(initial.partial === false && initial.items?.some(item => item.id === id && item.native_ready && item.actionable), 'fresh executable fixture is absent from actionable work');
    // The dashboard focus projection reads the Preview catalog: the shared test tracker and the unreadable outside tracker.
    const focusRow = async () => (await request('/portfolio/focus?fresh=true')).body;
    if (preview) {
      journeyReport.dashboard_history = await verifyDashboardNativeHistory({ base, token });
      const focus = await focusRow(), row = focus.open?.find(item => item.id === id);
      requireThat(focus.schema === 'beads.focus.v1' && focus.partial === false && focus.stores?.some(item => item.tracker === tracker && item.kind === 'ok') && !focus.stores.some(item => item.tracker === outsideTracker) && row?.status === 'open' && row.ready && !row.container && !row.claim, 'dashboard focus lacks the fresh ready fixture or reads an outside tracker');
    }
    const claimed = await request(`${path}/issues/${id}:claim`, { method: 'POST', key: randomUUID(), body: { actor, x_lease_seconds: 300 } });
    requireThat(claimed.status === 200, 'claim refused');
    const before = (await request(`${path}/issues/${id}?include_comments=true`)).body;
    requireThat(before.x_claim?.state === 'live' && before.x_claim.assignee === actor && before.x_claim.verified_principal === principal && !before.x_claim.reclaimable, 'claim conflates principal and worker or loses its lease');
    const held = (await request(`/portfolio/actionable?trackers=${tracker}&worker=${actor}&allow_shared_repo=true`)).body;
    requireThat(held.items?.some(item => item.id === id && !item.actionable && item.reasons?.some(reason => reason.code === 'native_claim')), 'portfolio selected an issue with a live native lease');
    if (preview) {
      const row = (await focusRow()).open?.find(item => item.id === id);
      requireThat(row?.claim?.live === true && row.claim.thread === actor && !row.lapsed, 'dashboard focus does not show the live claim as work in progress');
    }
    const evidence = `Shared-test completion evidence ${randomUUID()}\n${'Observed real hosted workflow. '.repeat(20)}`;
    const batch = (reason, fencing = before.x_claim.fencing_token) => ({ actor, items: [
      { kind: 'close', close: { target: { id }, reason, expected_version: before.revision, x_fencing_token: fencing } },
      { kind: 'x_comment', x_comment: { target: { id }, text: evidence } },
    ] });
    for (const [body, reason] of [[batch('x'.repeat(256)), 'text_too_long'], [batch('verified completion', before.x_claim.fencing_token + 1), 'stale_claim']]) {
      const rejected = await request(`${path}/issues:batchApply`, { method: 'POST', body, key: randomUUID() });
      requireThat(rejected.status >= 400 && rejected.status < 500 && rejected.body.reason === reason && rejected.body.x_outcome === 'rejected' && rejected.body.x_mutation_applied === false, 'refusal does not prove nonmutation');
      const after = (await request(`${path}/issues/${id}?include_comments=true`)).body;
      requireThat(after.status === before.status && after.revision === before.revision && after.comment_count === before.comment_count && JSON.stringify(after.comments) === JSON.stringify(before.comments), 'refused batch changed the fixture issue or comments');
    }
    const mcp = async (name, args) => {
      const response = await fetch(`${base.replace(/\/$/, '')}/mcp`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20_000),
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      });
      const text = await response.text();
      const payload = response.headers.get('Content-Type')?.includes('text/event-stream')
        ? JSON.parse(text.split('\n').find(line => line.startsWith('data:'))?.slice(5) ?? '{}') : JSON.parse(text);
      requireThat(response.ok && !payload.error, 'MCP call failed');
      return payload.result;
    };
    const mutation = randomUUID();
    const args = { tracker, id, reason: 'verified completion', evidence_comment: evidence, expected_version: before.revision, fencing_token: before.x_claim.fencing_token, mutation_id: mutation, worker_actor: actor };
    for (let replay = 0; replay < 2; replay++) {
      const result = await mcp('beads_close', args);
      requireThat(!result.isError && result.structuredContent?.x_outcome === 'verified', 'MCP completion lacks verified receipt');
      const readback = (await request(`${path}/issues/${id}?include_comments=true`)).body;
      const comment = result.structuredContent.result.items.find(item => item.kind === 'x_comment');
      requireThat(readback.status === 'closed' && readback.close_reason === args.reason && readback.comments?.filter(item => item.id === comment?.x_comment_id && item.text === evidence && item.author === auditActor).length === 1 && readback.comment_count === before.comment_count + 1, 'atomic completion or replay changed/lost evidence');
    }
    const committed = (await request(`${path}/issues/${id}?include_comments=true`)).body;
    const conflict = await mcp('beads_close', { ...args, worker_actor: `${actor}-changed` });
    requireThat(conflict.isError && conflict.structuredContent?.reason === 'idempotency_key_reused' && conflict.structuredContent.x_outcome !== 'rejected' && conflict.structuredContent.x_mutation_applied !== false, 'reused mutation key falsely proves nonmutation');
    const afterConflict = (await request(`${path}/issues/${id}?include_comments=true`)).body;
    requireThat(afterConflict.status === 'closed' && afterConflict.revision === committed.revision && afterConflict.close_reason === committed.close_reason && afterConflict.comment_count === committed.comment_count && JSON.stringify(afterConflict.comments) === JSON.stringify(committed.comments), 'idempotency conflict lost or changed the committed completion');
    if (preview) {
      const focus = await focusRow(), done = focus.recent?.find(item => item.id === id);
      requireThat(!focus.open?.some(item => item.id === id) && done?.outcome === 'done' && focus.flow?.some(item => item.date === done.closed_at.slice(0, 10) && item.repo === done.repo && item.done > 0), 'dashboard focus does not count the verified completion as done');
    }
    const report = (await request(`/portfolio/actionable?trackers=${tracker}&worker=${actor}`)).body;
    const store = report.stores?.find(item => item.tracker === tracker);
    const ready = (await request(`${path}/ready:count`)).body;
    requireThat(report.schema === 'beads.actionable.v1' && report.partial === false && store?.kind === 'ok' && Object.values(store.counts.by_status).reduce((a, b) => a + b, 0) === store.counts.total && store.counts.native_ready === ready.total, 'portfolio counts or completeness disagree with native reads');
    const denied = (await request(`/portfolio/actionable?trackers=${outsideTracker}`)).body;
    requireThat(denied.partial === true && denied.stores?.some(item => item.tracker === outsideTracker && item.kind === 'inaccessible'), 'portfolio hid an inaccessible requested tracker');
    await verifyClaimLock({ path, request, principal, owned, tracker, actor });
    journeyReport.reclaim = await verifyScopedReclaim({ path, request, owned, markers, tracker, actor });
    console.log(`workflow journey passed: ${expectedSha}, ${tracker}, atomic completion, replay, typed rejections, identity, portfolio and the claim lock`);
    return journeyReport;
  } catch (error) {
    error.journeyEvidence = journeyReport;
    throw error;
  } finally {
    const cleanupErrors = [];
    for (const id of owned) {
      try {
        const present = await request(`${path}/issues/${id}`);
        if (present.status === 404) { journeyReport.cleanup.push({ id, absent: true }); continue; }
        requireThat(present.status === 200 && present.body.labels?.includes('workflow-journey') &&
          (!markers.has(id) || present.body.labels.includes(markers.get(id))), 'fixture cleanup could not establish owned issue');
        const deleted = await request(`${path}/issues:delete`, { method: 'POST', key: randomUUID(), body: { actor, ids: [id], force: true, cascade: false } });
        const absent = deleted.status === 200 && (await request(`${path}/issues/${id}`)).status === 404;
        journeyReport.cleanup.push({ id, delete_status: deleted.status, absent });
        requireThat(absent, 'owned fixture cleanup was not verified');
      } catch (error) { cleanupErrors.push({ id, message: error.message }); }
    }
    if (cleanupErrors.length) {
      const error = new Error('workflow journey: owned fixture cleanup incomplete');
      error.journeyEvidence = { ...journeyReport, cleanup_errors: cleanupErrors };
      throw error;
    }
  }
}

// The declared default lease is two hours. A one-hour future cutoff must leave
// it live; a three-hour cutoff exercises real reclamation without a clock wait.
// Every sweep is limited to this journey's exact ids, even on shared Preview.
async function verifyScopedReclaim({ path, request, owned, markers, tracker, actor }) {
  const marker = `reclaim:${randomUUID()}`;
  const lane = `${marker}:lane`;
  const otherLane = `${marker}:other`;
  const excluded = `${marker}:excluded`;
  const ids = [];
  const read = async id => {
    const result = await request(`${path}/issues/${id}`);
    requireThat(result.status === 200, 'reclaim fixture read refused');
    return result.body;
  };
  for (let i = 0; i < 3; i++) {
    const id = `${tracker}-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    owned.push(id); ids.push(id); markers.set(id, marker);
    const created = await request(`${path}/issues`, { method: 'POST', key: randomUUID(), body: {
      id, actor, title: 'Scoped reclaim journey', issue_type: 'task', priority: 2,
      labels: ['workflow-journey', marker, i === 1 ? otherLane : lane, ...(i === 2 ? [excluded] : [])],
    } });
    requireThat(created.status === 200 || created.status === 201, 'reclaim fixture create refused');
    const claim = await request(`${path}/issues/${id}:claim`, { method: 'POST', key: randomUUID(), body: { actor } });
    requireThat(claim.status === 200, 'reclaim fixture claim refused');
  }
  const before = await Promise.all(ids.map(read));
  requireThat(before.every(issue => issue.status === 'in_progress' && issue.assignee === actor &&
    Date.parse(issue.lease_expires_at) - Date.parse(issue.heartbeat_at) === 7200_000), 'default claim lease differs from the declared two hours');
  const reclaim = async (seconds, selected, filter = {}) => {
    const query = new URLSearchParams({ older_than: String(seconds), ids: selected.join(','), ...filter });
    const result = await request(`${path}/leases:reclaim?${query}`, { method: 'POST', key: randomUUID(), body: { actor } });
    requireThat(result.status === 200 && Array.isArray(result.body.reclaimed), 'scoped reclaim refused');
    return result.body.reclaimed;
  };
  for (const horizon of [0, -3600]) {
    requireThat((await reclaim(horizon, ids)).length === 0, 'reclaim took a lease newer than its cutoff');
  }
  requireThat((await reclaim(-10800, ids, { label: otherLane })).map(row => row.id).join() === ids[1], 'label reclaim did not select exactly its lane');
  const untouched = await Promise.all([ids[0], ids[2]].map(read));
  requireThat(untouched.every((issue, i) => issue.revision === before[i * 2].revision && issue.status === 'in_progress' && issue.assignee === actor), 'label reclaim disturbed an out-of-scope claim');
  requireThat((await reclaim(-10800, [ids[0], ids[2]], { label_any: lane, exclude_label: excluded })).map(row => row.id).join() === ids[0], 'label-any/exclude reclaim selected the wrong fixture');
  requireThat((await read(ids[2])).revision === before[2].revision, 'exclude-label reclaim disturbed the excluded claim');
  requireThat((await reclaim(-10800, [ids[2]], { assignee: `${actor}-other` })).length === 0, 'assignee reclaim widened its scope');
  const final = await reclaim(-10800, [ids[2]], { assignee: actor });
  requireThat(final.length === 1 && final[0].id === ids[2] && final[0].previous_owner === actor, 'id/assignee reclaim lost the previous owner');
  const after = await Promise.all(ids.map(read));
  requireThat(after.every(issue => issue.status === 'open' && !issue.assignee && !issue.lease_expires_at && !issue.started_at), 'reclaim did not clear claim state');
  return { default_lease_seconds: 7200, fresh_cutoffs_seconds: [0, -3600], reclaim_cutoff_seconds: -10800,
    filters: ['ids', 'label', 'label_any', 'exclude_label', 'assignee'], reclaimed_ids: ids, status: 'PASS' };
}

// Real list/export selection: the same reference has several rows, including a
// closed task and an epic. A one-row page must not hide duplicates or near-matches.
async function verifyExternalRefQuery({ path, request, owned, markers, tracker, outsideTracker, actor, report }) {
  const nonce = randomUUID().replaceAll('-', '').slice(0, 12);
  const marker = `external-ref-${nonce}`;
  const reference = `cf-test-external-ref:${nonce}:Exact`;
  const fixtures = [];
  const evidence = { reference, fixtures, reads: [], tenant_denials: [] };
  report.external_ref = evidence;
  for (const [suffix, type, ref, closed] of [
    ['a', 'task', reference, false], ['b', 'task', reference, false],
    ['c', 'task', reference, true], ['d', 'epic', reference, false],
    ['near', 'task', `${reference}-near`, false], ['case', 'task', reference.toLowerCase(), false],
  ]) {
    const id = `${tracker}-${nonce}-${suffix}`;
    owned.push(id); markers.set(id, marker);
    const created = await request(`${path}/issues`, { method: 'POST', key: randomUUID(), body: {
      id, actor, title: 'Shared-test external reference query', issue_type: type, priority: 3,
      external_ref: ref, labels: ['shared-test', 'workflow-journey', marker],
    } });
    requireThat((created.status === 200 || created.status === 201) && created.body.id === id, 'external_ref fixture create refused');
    if (closed) {
      const reply = await request(`${path}/issues/${id}:close`, { method: 'POST', key: randomUUID(), body: { actor, reason: 'Closed exact-reference duplicate' } });
      requireThat(reply.status === 200, 'external_ref closed duplicate refused');
    }
    fixtures.push({ id, type, reference: ref, closed });
  }
  const exact = fixtures.filter(row => row.reference === reference);
  for (const route of ['issues', 'issues:export']) {
    const params = new URLSearchParams({ external_ref: reference, limit: '1', ...(route === 'issues' ? { all: 'true' } : {}) });
    const ids = []; const cursors = new Set(); let pages = 0;
    for (;;) {
      const reply = await request(`${path}/${route}?${params}`);
      evidence.reads.push({ route, status: reply.status, code: reply.body.code, param: reply.body.param, reason: reply.body.reason });
      requireThat(reply.status === 200, `external_ref ${route} must select exact duplicates across cursor pages`);
      requireThat(Array.isArray(reply.body.items) && typeof reply.body.has_more === 'boolean' && reply.body.items.length <= 1, 'external_ref page envelope is incomplete');
      for (const row of reply.body.items) {
        requireThat(row.external_ref === reference && exact.some(fixture => fixture.id === row.id) && !ids.includes(row.id), 'external_ref query returned a near-match, foreign row or repeated ID');
        ids.push(row.id);
      }
      pages++;
      if (!reply.body.has_more) break;
      const cursor = reply.body.next_cursor;
      requireThat(typeof cursor === 'string' && cursor && !cursors.has(cursor) && pages < exact.length + 1, 'external_ref cursor continuation is missing or repeated');
      cursors.add(cursor); params.set('cursor', cursor);
    }
    requireThat(pages > 1 && ids.length === exact.length && exact.every(row => ids.includes(row.id)), 'external_ref query omitted an exact duplicate, closed row or page');
    evidence.reads.push({ route, pages, exact_ids: ids });
    for (const [filter, value, selected] of [
      ['status', 'closed', exact.filter(row => row.closed)], ['type', 'task', exact.filter(row => row.type === 'task')],
    ]) {
      const query = new URLSearchParams({ external_ref: reference, limit: '20', [filter]: value, ...(route === 'issues' ? { all: 'true' } : {}) });
      const reply = await request(`${path}/${route}?${query}`);
      requireThat(reply.status === 200 && reply.body.has_more === false && reply.body.items?.length === selected.length &&
        reply.body.items.every(row => row.external_ref === reference && selected.some(fixture => fixture.id === row.id)), 'external_ref status/type intersection differs');
    }
    const denied = await request(`/t/${outsideTracker}/v0/beads/${route}?${params}`);
    evidence.tenant_denials.push({ route, status: denied.status });
    requireThat(denied.status === 403, 'external_ref query crossed its authorized tracker');
  }
  return evidence;
}

// The claim lock, with two workers behind one credential (the shape of two sessions of one GitHub user): the
// first claim locks, a bare in_progress is a claim, the holder keeps its lease, and a lapsed lease releases itself.
async function verifyClaimLock({ path, request, principal, owned, tracker, actor }) {
  const [a, b] = [`${actor}-a`, `${actor}-b`];
  const lease = (issue) => Date.parse(issue.x_claim?.lease_expires_at ?? issue.lease_expires_at);
  const fixture = async (title) => {
    const id = `${tracker}-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    owned.push(id);
    const created = await request(`${path}/issues`, { method: 'POST', key: randomUUID(), body: { id, actor: a, title, issue_type: 'task', priority: 3, labels: ['shared-test', 'workflow-journey'] } });
    requireThat(created.status === 200 || created.status === 201, 'claim lock fixture create refused');
    return id;
  };
  const read = async (id) => (await request(`${path}/issues/${id}`)).body;
  const refused = (reply, message) => requireThat(reply.status === 409 && reply.body.code === 'already_claimed' && reply.body.reason === 'claimed_by_other' && reply.body.assignee === a && reply.body.x_same_principal === true && reply.body.x_mutation_applied === false, message);
  const patch = (id, who, change, extra = {}) => request(`${path}/issues/${id}`, { method: 'PATCH', key: randomUUID(), body: { actor: who, patch: change, ...extra } });

  // 1. A claims; B, on the same credential, is refused every way it could change or take the issue.
  const locked = await fixture('Claim lock journey: two workers');
  const claim = await request(`${path}/issues/${locked}:claim`, { method: 'POST', key: randomUUID(), body: { actor: a, x_lease_seconds: 600 } });
  requireThat(claim.status === 200 && claim.body.already_claimed === false && Number.isInteger(claim.body.x_fencing_token), 'worker A could not claim');
  const first = await read(locked);
  requireThat(first.status === 'in_progress' && first.assignee === a && first.x_claim.state === 'live' && first.x_claim.verified_principal === principal && first.x_claim.fencing_token === claim.body.x_fencing_token && first.heartbeat_at && lease(first) > Date.now(), 'the claim does not read back as live with holder, lease, heartbeat and fencing');
  refused(await request(`${path}/issues/${locked}:claim`, { method: 'POST', key: randomUUID(), body: { actor: b } }), 'worker B claimed a live claim');
  for (const change of [{ status: 'in_progress' }, { status: 'blocked' }, { status: 'closed' }, { assignee: b }, { assignee: '' }]) {
    refused(await patch(locked, b, change), `worker B changed a live claim with ${JSON.stringify(change)}`);
  }
  refused(await request(`${path}/issues/${locked}:close`, { method: 'POST', key: randomUUID(), body: { actor: b, reason: 'not the holder' } }), 'worker B closed a live claim');
  refused(await request(`${path}/issues/${locked}:heartbeat`, { method: 'POST', key: randomUUID(), body: { actor: b } }), 'worker B renewed a live claim');
  const untouched = await read(locked);
  requireThat(untouched.status === 'in_progress' && untouched.assignee === a && untouched.revision === first.revision, 'refused requests changed the claimed issue');

  // 2. A renews (heartbeat, then a write of its own) and stays locked past its original lease.
  const beat = await request(`${path}/issues/${locked}:heartbeat`, { method: 'POST', key: randomUUID(), body: { actor: a, x_lease_seconds: 3600 } });
  requireThat(beat.status === 200 && Date.parse(beat.body.lease_expires_at) > lease(first), 'the holder heartbeat did not extend the lease');
  const written = await patch(locked, a, { priority: 2 });
  requireThat(written.status === 200 && lease(await read(locked)) >= Date.parse(beat.body.lease_expires_at), 'a holder write shortened or lost the lease');

  // 3. A bare status of in_progress is a claim; an empty assignee gives it up.
  const plain = await fixture('Claim lock journey: bare status');
  const started = await patch(plain, a, { status: 'in_progress' });
  requireThat(started.status === 200 && started.body.issue.assignee === a && started.body.issue.x_claim.state === 'live' && started.body.issue.x_claim.verified_principal === principal && started.body.issue.x_claim.fencing_token >= 1, 'a status of in_progress did not become a claim');
  const takeover = await patch(plain, b, { status: 'in_progress' });
  requireThat(takeover.status === 409 && takeover.body.reason === 'claimed_by_other', 'a bare status took a live claim');
  const released = await patch(plain, a, { assignee: '' });
  requireThat(released.status === 200 && released.body.issue.status === 'open' && !released.body.issue.assignee, 'an empty assignee did not release the claim');
  requireThat((await patch(plain, b, { status: 'in_progress' })).status === 200, 'a released issue could not be claimed');

  // 4. A short lease lapses by itself: released with an event, claimable by B, and A's old fencing token is stale.
  const short = await fixture('Claim lock journey: lapse');
  const lapsing = await request(`${path}/issues/${short}:claim`, { method: 'POST', key: randomUUID(), body: { actor: a, x_lease_seconds: 1 } });
  requireThat(lapsing.status === 200, 'the short claim was refused');
  const head = (await request(`${path}/events?since=0&limit=1`)).body.head;
  await new Promise(resolve => setTimeout(resolve, 2500));
  const lapsed = await read(short);
  requireThat(lapsed.status === 'open' && !lapsed.assignee && lapsed.x_claim.state === 'none' && lapsed.x_claim.fencing_token === lapsing.body.x_fencing_token + 1, 'the lapsed claim was not released with a raised fencing token');
  const events = (await request(`${path}/events?since=${Math.max(0, head - 50)}&limit=500`)).body.records;
  requireThat(events.some(event => event.issue_id === short && event.x_event_type === 'lease_expired' && event.actor === 'system:lease-expiry' && event.x_client_actor === a), 'the release left no lease_expired event naming the lapsed worker');
  const retaken = await request(`${path}/issues/${short}:claim`, { method: 'POST', key: randomUUID(), body: { actor: b } });
  requireThat(retaken.status === 200 && retaken.body.x_fencing_token === lapsing.body.x_fencing_token + 2, 'worker B could not claim the lapsed issue');
  const stale = await patch(short, a, { title: 'Claim lock journey: stale write' }, { x_fencing_token: lapsing.body.x_fencing_token });
  requireThat(stale.status === 409 && stale.body.reason === 'stale_claim', 'a write with the old fencing token was not refused as stale');
  requireThat((await read(short)).assignee === b, 'the stale write disturbed the new holder');
}

// The existing isolated qualifier provisions finite keys; this checks the real HTTP/auth/store boundary.
export async function verifyKeyClaimOwnership({ base, operatorToken }) {
  requireThat(/^https:\/\/beads-backup-qualify-[a-f0-9]{8}\.[a-z0-9-]+\.workers\.dev$/.test(base), 'key ownership needs the isolated qualifier');
  const request = async (token, route, method = 'GET', body, key) => {
    const response = await fetch(base + route, { method, redirect: 'error', signal: AbortSignal.timeout(20000),
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}), ...(key ? { 'Idempotency-Key': key } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  const fixtures = await request(operatorToken, '/auth-fixtures', 'POST');
  requireThat(fixtures.status === 200, 'finite key provisioning refused');
  const { ordinary, exchange, tracker } = fixtures.body;
  const keys = [...ordinary, ...exchange];
  const path = `/t/${tracker}/v0/beads`;
  const owned = [];
  try {
    const contexts = await Promise.all(keys.map(key => request(key.key, path + '/context')));
    const subjects = contexts.map(context => context.body.x_identity?.verified_principal?.subject);
    requireThat(subjects[0] !== subjects[1] && subjects[2] === subjects[3], 'key subjects do not separate ordinary keys and preserve exchange rotation');
    for (const [index, pair] of [ordinary, exchange].entries()) {
      const id = `${tracker}-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
      owned.push(id);
      requireThat((await request(pair[0].key, path + '/issues', 'POST', { id, actor: 'same-worker', title: 'Shared-test key ownership', issue_type: 'task', labels: ['shared-test', 'key-ownership'] })).status === 200, 'key fixture create refused');
      const claimKey = randomUUID();
      const claimed = await request(pair[0].key, `${path}/issues/${id}:claim`, 'POST', { actor: 'same-worker', x_lease_seconds: 60 }, claimKey);
      requireThat(claimed.status === 200, 'original key claim refused');
      const replay = await request(pair[0].key, `${path}/issues/${id}:claim`, 'POST', { actor: 'same-worker', x_lease_seconds: 60 }, claimKey);
      requireThat(JSON.stringify(replay.body) === JSON.stringify(claimed.body), 'claim idempotent replay changed');
      const read = async () => (await request(pair[0].key, `${path}/issues/${id}`)).body;
      const before = await read();
      requireThat(before.x_claim.verified_principal === subjects[index * 2], 'claim stores display label instead of subject');
      if (index === 0) {
        for (const [suffix, method, body] of [
          [':claim', 'POST', { actor: 'same-worker' }], [':heartbeat', 'POST', { actor: 'same-worker' }],
          [':close', 'POST', { actor: 'same-worker', reason: 'foreign key' }], [':release', 'POST', { actor: 'same-worker' }],
          ['', 'PATCH', { actor: 'same-worker', patch: { status: 'closed' } }],
        ]) {
          const denied = await request(pair[1].key, `${path}/issues/${id}${suffix}`, method, body);
          requireThat(denied.status === 409 && denied.body.reason === 'claimed_by_other' && denied.body.x_mutation_applied === false, 'same-label foreign key refusal: ' + JSON.stringify({ suffix, status: denied.status, code: denied.body.code, param: denied.body.param, reason: denied.body.reason, outcome: denied.body.x_outcome }));
        }
        requireThat(JSON.stringify(await read()) === JSON.stringify(before), 'foreign-key refusals changed claim state');
      } else {
        requireThat((await request(pair[1].key, `${path}/issues/${id}:heartbeat`, 'POST', { actor: 'same-worker' })).status === 200, 'exchange rotation lost original claim');
      }
      requireThat((await request(pair[0].key, `${path}/issues/${id}:heartbeat`, 'POST', { actor: 'same-worker' })).status === 200, 'original holder heartbeat refused');
      const stale = await request(pair[0].key, `${path}/issues/${id}:close`, 'POST', { actor: 'same-worker', reason: 'stale fencing probe', x_fencing_token: before.x_claim.fencing_token - 1 });
      requireThat(stale.status === 409 && stale.body.reason === 'stale_claim', 'stale fencing token accepted');
      requireThat((await request(pair[0].key, `${path}/issues/${id}:close`, 'POST', { actor: 'same-worker', reason: 'key ownership verified' })).status === 200, 'holder completion refused');
      const closed = await read();
      requireThat(closed.status === 'closed' && closed.created_by === contexts[index * 2].body.x_identity.verified_principal.email, 'ownership change damaged completion or readable audit identity');
    }
    return { ordinary_same_label_isolation: 'PASS', original_holder_heartbeat_completion: 'PASS', exchange_rotation: 'PASS', idempotency_and_fencing: 'PASS', audit_identity_preserved: 'PASS' };
  } finally {
    for (const id of owned) {
      const before = await request(ordinary[0].key, `${path}/issues/${id}`);
      if (before.status === 404) continue;
      requireThat(before.body.labels?.includes('key-ownership'), 'key fixture cleanup ownership unconfirmed');
      requireThat((await request(ordinary[0].key, `${path}/issues:delete`, 'POST', { ids: [id], force: true, cascade: true })).status === 200, 'owned key fixture cleanup refused');
      requireThat((await request(ordinary[0].key, `${path}/issues/${id}`)).status === 404, 'owned key fixture deletion did not read back');
    }
    for (const key of keys) {
      requireThat((await request(operatorToken, `/admin/keys/${key.id}`, 'DELETE')).status === 200, 'test key revocation refused');
      const denied = await fetch(base + path + '/context', { headers: { Authorization: `Bearer ${key.key}` }, redirect: 'error', signal: AbortSignal.timeout(20000) });
      await denied.body?.cancel();
      requireThat(denied.status === 401, 'revoked key still grants access');
    }
  }
}

// Exercise the delivered dashboard and its authenticated data contract together.
export async function verifyDashboardNativeHistory({ base, token }) {
  const read = route => fetch(`${base.replace(/\/$/, '')}${route}`, {
    headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(20_000),
  });
  const overview = await read('/portfolio/overview');
  requireThat(overview.ok, 'dashboard overview refused the admitted test identity');
  const data = await overview.json();
  requireThat(data.source?.authority === 'cloudflare' && Array.isArray(data.history) && !Object.hasOwn(data, 'archive'),
    'dashboard overview exposed archived tracker data or lost native history');
  const page = await read('/dashboard');
  requireThat(page.ok && !(await page.text()).includes('id="history-source"'),
    'delivered dashboard still offers the retired history source selector');
  return { authority: 'cloudflare', native_history: true, archive_absent: true, source_selector_absent: true };
}

// Native operation custody and compact reads share the real hosted HTTP/store boundary.
export async function verifyNativeOperations({ base, operatorToken, saveStage = () => {} }) {
  requireThat(/^https:\/\/beads-backup-qualify-[a-f0-9]{8}\.[a-z0-9-]+\.workers\.dev$/.test(base), 'native operations need the isolated qualifier');
  const tracker = 'cf-backup-qualify-253', path = `/t/${tracker}/v0/beads`, actor = 'native-operation-worker';
  const request = async (token, route, method = 'GET', body, key) => {
    const response = await fetch(base + route, { method, redirect: 'error', signal: AbortSignal.timeout(20000),
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}), ...(key ? { 'Idempotency-Key': key } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await response.text();
    return { status: response.status, replayed: response.headers.get('Idempotency-Replayed'), body: text ? JSON.parse(text) : {} };
  };
  const expect = (response, status, step) => {
    if (response.status !== status) saveStage('native-operation-refusal', { step, status: response.status, code: response.body.code, param: response.body.param, reason: response.body.reason, outcome: response.body.x_outcome, mutation_applied: response.body.x_mutation_applied });
    requireThat(response.status === status, `native operation ${step}: HTTP ${response.status}`);
    return response.body;
  };
  const keys = [], owned = [], report = { tracker };
  try {
    for (let i = 0; i < 2; i++) keys.push(expect(await request(operatorToken, '/admin/keys', 'POST', { label: 'shared-test:native-operation-duplicate', scopes: ['beads:read', 'beads:write', 'beads:import'], trackers: [tracker], expires_in_days: 1 }), 201, 'finite key'));
    const [owner, foreign] = keys;
    const read = async (route, key = owner) => expect(await request(key.key, path + route), 200, route);
    const write = async (route, body, key = owner, idem = randomUUID()) => expect(await request(key.key, path + route, 'POST', body, idem), 200, route);
    const checkpoint = async () => read('/issues:analysis');
    const context = await read('/context'), other = await read('/context', foreign);
    requireThat(context.x_identity.verified_principal.subject !== other.x_identity.verified_principal.subject && context.x_identity.verified_principal.email === other.x_identity.verified_principal.email, 'same-label keys lost separate stable principals');
    requireThat((await read('/issues?limit=1')).items.length === 0, 'native operation tracker must begin empty');
    const id = `${tracker}-${randomUUID().replaceAll('-', '').slice(0, 12)}`, locked = `${tracker}-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    owned.push(id, locked);
    const operation = `native-${randomUUID()}`, createKey = randomUUID();
    const plan = { operation_id: operation, expected_revision: context.x_mutation_revision, chunks: [
      { actor, items: [{ kind: 'create', create: { id, title: 'Shared-test native operation', issue_type: 'task', labels: ['shared-test', 'native-operations'] } }] },
      { actor, items: [{ kind: 'update', update: { target: { id }, patch: { title: 'Shared-test native operation committed' } } }, { kind: 'x_comment', x_comment: { target: { id }, text: 'Synthetic operation evidence Ω' } }] },
    ] };
    const created = await write('/operations', plan, owner, createKey);
    const afterCreate = await checkpoint();
    const createReplay = await request(owner.key, path + '/operations', 'POST', plan, createKey);
    requireThat(createReplay.status === 200 && createReplay.replayed === 'true' && JSON.stringify(createReplay.body) === JSON.stringify(created) && (await checkpoint()).revision === afterCreate.revision, 'operation create replay changed durable state');
    const inspected = await read('/operations/' + operation);
    requireThat(inspected.next_chunk === 0 && inspected.results.length === 0 && isDeepStrictEqual(inspected.plan, plan.chunks), 'operation inspect lost the immutable plan');
    requireThat((await read('/operations')).items.some(item => item.operation_id === operation), 'operation discovery omitted the caller plan');
    for (const [route, method, body] of [['/operations/' + operation, 'GET'], ['/operations/' + operation + ':advance', 'POST', { expected_index: 0 }]]) {
      const denied = await request(foreign.key, path + route, method, body, method === 'POST' ? randomUUID() : undefined);
      requireThat(denied.status === 404 && (method !== 'POST' || denied.body.x_mutation_applied === false), 'same-label foreign principal accessed a native operation');
    }
    requireThat((await read('/operations', foreign)).items.length === 0 && (await checkpoint()).revision === afterCreate.revision, 'foreign operation access changed or disclosed custody');
    requireThat(afterCreate.items.length === 0 && afterCreate.revision === context.x_mutation_revision + 1, 'operation-only native revision differs');
    const sweep = expect(await request(operatorToken, '/sweep', 'POST'), 200, 'operation-only discovery sweep');
    const archive = expect(await request(operatorToken, '/archive?tracker=' + tracker), 200, 'operation-only archive');
    requireThat(sweep.progress.last_tracker === null && archive.payload.state.issues.length === 0 && !Object.hasOwn(archive.payload.state, 'operations') && !Object.hasOwn(archive.payload.state, 'analysis_changes'), 'operation-only discovery or documented snapshot exclusion differs');
    report.operation_only_discovery = { revision: afterCreate.revision, archive_digest: archive.integrity.digest, active_issues: 0, table_only_without_meta_fixture: false };
    saveStage('native-operation-discovery', report.operation_only_discovery);
    for (let index = 0; index < plan.chunks.length; index++) {
      const key = randomUUID(), body = { expected_index: index };
      const advanced = await write('/operations/' + operation + ':advance', body, owner, key);
      const beforeReplay = await checkpoint();
      const replay = await request(owner.key, path + '/operations/' + operation + ':advance', 'POST', body, key);
      const afterReplay = await checkpoint();
      saveStage('native-operation-replay-' + index, { status: replay.status, replayed: replay.replayed, code: replay.body.code, param: replay.body.param, reason: replay.body.reason, mutation_applied: replay.body.x_mutation_applied, before_revision: beforeReplay.revision, after_revision: afterReplay.revision, next_chunk: (await read('/operations/' + operation)).next_chunk });
      requireThat(replay.status === 200 && replay.replayed === 'true' && JSON.stringify(replay.body) === JSON.stringify(advanced) && beforeReplay.revision === afterReplay.revision, 'native advance Idempotency-Key replay did not return its saved receipt');
      const conflict = await request(owner.key, path + '/operations/' + operation + ':advance', 'POST', { expected_index: 99 }, key);
      requireThat(conflict.status === 409 && conflict.body.reason === 'idempotency_key_reused' && (await checkpoint()).revision === afterReplay.revision, 'changed native advance reused a receipt or mutated state');
    }
    const page = await read('/operations/' + operation + '?result_limit=1');
    const last = await read('/operations/' + operation + '?result_limit=1&result_cursor=' + page.next_result_cursor);
    requireThat(page.status === 'complete' && page.next_chunk === 2 && page.results[0].index === 0 && page.has_more_results && last.results[0].index === 1 && !last.has_more_results, 'committed native result pagination differs');
    const complete = await read('/issues/' + id + '?include_comments=true');
    requireThat(complete.title === 'Shared-test native operation committed' && complete.comments?.filter(comment => comment.text === 'Synthetic operation evidence Ω').length === 1, 'native chunks lost or duplicated committed effects');
    const compact = await checkpoint();
    requireThat(compact.items.some(item => item.id === id && item.title === complete.title && !Object.hasOwn(item, 'comments')) && compact.revision === last.expected_revision, 'native effects absent from compact analysis');
    const unchanged = await read(`/issues:changes?since=${compact.event_head}&since_revision=${compact.revision}`);
    requireThat(!unchanged.full_refresh_required && unchanged.items.length === 0 && unchanged.revision === compact.revision, 'unchanged analysis checkpoint did not remain stable');
    await write('/issues', { id: locked, title: 'Shared-test guarded native operation', issue_type: 'task', actor, labels: ['shared-test', 'native-operations'] });
    await write('/issues/' + locked + ':claim', { actor, x_lease_seconds: 300 });
    const guarded = `guard-${randomUUID()}`;
    await write('/operations', { operation_id: guarded, expected_revision: (await checkpoint()).revision, chunks: [{ actor, items: [
      { kind: 'update', update: { target: { id }, patch: { title: 'MUST ROLL BACK' } } }, { kind: 'close', close: { target: { id: locked }, reason: 'foreign principal must not close' } },
    ] }] }, foreign);
    const beforeGuard = await checkpoint(), beforeIssue = await read('/issues/' + id), firstPage = await read('/issues:analysis?limit=1');
    const denied = await request(foreign.key, path + '/operations/' + guarded + ':advance', 'POST', { expected_index: 0 }, randomUUID());
    requireThat(denied.status === 409 && denied.body.reason === 'claimed_by_other' && denied.body.x_mutation_applied === false, 'native chunk bypassed the claim guard');
    const guardState = await read('/operations/' + guarded, foreign), afterGuard = await checkpoint();
    requireThat(guardState.next_chunk === 0 && guardState.results.length === 0 && afterGuard.revision === beforeGuard.revision && afterGuard.event_head === beforeGuard.event_head && JSON.stringify(await read('/issues/' + id)) === JSON.stringify(beforeIssue), 'refused native chunk left partial issue, result, revision or event effects');
    const secondPage = await read('/issues:analysis?limit=1&cursor=' + encodeURIComponent(firstPage.next_cursor));
    requireThat(firstPage.has_more && firstPage.revision === secondPage.revision && firstPage.evaluated_at === secondPage.evaluated_at && !secondPage.has_more, 'refused chunk broke a stable analysis cursor');
    const patch = await request(owner.key, path + '/issues/' + id, 'PATCH', { actor, patch: { priority: 1 } }, randomUUID());
    expect(patch, 200, 'analysis delta update');
    const changes = await read(`/issues:changes?since=${afterGuard.event_head}&since_revision=${afterGuard.revision}`);
    requireThat(!changes.full_refresh_required && changes.items.some(item => item.id === id && item.priority === 1) && changes.revision === afterGuard.revision + 1, 'native revision/changes lost a direct issue delta');
    const fenced = await request(foreign.key, path + '/operations/' + guarded + ':advance', 'POST', { expected_index: 0 }, randomUUID());
    requireThat(fenced.status === 409 && fenced.body.reason === 'revision_changed' && fenced.body.x_mutation_applied === false && (await checkpoint()).revision === changes.revision, 'native operation silently rebased after another write');
    const stale = await request(owner.key, path + '/issues:analysis?limit=1&cursor=' + encodeURIComponent(firstPage.next_cursor));
    requireThat(stale.status === 409 && stale.body.reason === 'revision_changed', 'analysis cursor did not fence a later write');
    Object.assign(report, { native_create_inspect_list_advance: 'PASS', stable_principal_same_label_isolation: 'PASS', immutable_plan_result_pagination: 'PASS', idempotent_create_and_advance: 'PASS', claim_guard_atomic_rollback: 'PASS', analysis_revision_changes_and_cursor_fence: 'PASS' });
    saveStage('native-operations', report);
    return report;
  } finally {
    if (keys[0]) for (const id of owned) {
      const present = await request(keys[0].key, path + '/issues/' + id);
      if (present.status === 404) continue;
      requireThat(present.status === 200 && present.body.labels?.includes('native-operations'), 'native fixture cleanup ownership lost');
      requireThat((await request(keys[0].key, path + '/issues:delete', 'POST', { actor, ids: [id], force: true, cascade: false }, randomUUID())).status === 200 && (await request(keys[0].key, path + '/issues/' + id)).status === 404, 'native fixture cleanup failed');
    }
    for (const key of keys) {
      expect(await request(operatorToken, '/admin/keys/' + key.id, 'DELETE'), 200, 'native key revocation');
      requireThat((await request(key.key, path + '/context')).status === 401, 'native revoked key still grants access');
    }
  }
}

export async function verifyTerminalBackupLifecycle({ base, operatorToken, saveStage = () => {} }) {
  requireThat(/^https:\/\/beads-backup-qualify-[a-f0-9]{8}\.[a-z0-9-]+\.workers\.dev$/.test(base), 'terminal backup needs the isolated qualifier');
  const terminal = 'restore-drill-qualifier', ordinary = 'cf-backup-qualify-253', keys = [];
  const request = async (token, route, method = 'GET', body) => {
    const response = await fetch(base + route, { method, redirect: 'error', signal: AbortSignal.timeout(60000),
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await response.text(), data = text ? JSON.parse(text) : {};
    if (!response.ok && response.status !== 404 && response.status !== 401) saveStage('terminal-backup-refusal', { status: response.status, code: data.code, param: data.param, reason: data.reason });
    return { status: response.status, body: data };
  };
  const operator = async (route, method = 'GET', body) => {
    const response = await request(operatorToken, route, method, body);
    requireThat(response.status >= 200 && response.status < 300, 'terminal backup operator refused: ' + response.status);
    return response.body;
  };
  const mint = async tracker => {
    const key = await operator('/admin/keys', 'POST', { label: tracker + ' import', scopes: ['beads:read', 'beads:write'], trackers: [tracker], expires_in_days: 1 });
    keys.push(key); return key;
  };
  const revoke = key => operator('/admin/keys/' + key.id, 'DELETE');
  const clearedHistory = async (tracker, key) => {
    const id = tracker + '-terminal-history';
    for (const [route, method, body] of [['/memories', 'POST', { key: 'terminal-fixture', content: 'synthetic history retained after clearance' }], ['/memories/terminal-fixture', 'DELETE'],
      ['/issues', 'POST', { id, title: 'Synthetic retained terminal history', issue_type: 'task', actor: 'terminal-qualifier', labels: ['shared-test', 'terminal-lifecycle'] }],
      ['/issues:delete', 'POST', { actor: 'terminal-qualifier', ids: [id], force: true, cascade: false }]]) {
      const response = await request(key.key, `/t/${tracker}/v0/beads${route}`, method, body);
      requireThat(response.status === 200, 'terminal fixture supported write refused');
    }
  };
  const archive = (tracker, day) => request(operatorToken, '/archive?tracker=' + tracker + '&day=' + day);
  const sweep = day => operator('/sweep?day=' + day, 'POST');
  try {
    requireThat((await operator('/backup-discovery')).all.length === 0, 'terminal lifecycle needs fresh isolated resources');
    const exchange = await operator('/lifecycle-exchange-key', 'POST'); keys.push(exchange);
    const realKey = await mint(ordinary);
    await clearedHistory(terminal, exchange); await clearedHistory(ordinary, realKey);
    await revoke(exchange); await revoke(realKey);
    await sweep('2099-01-01');
    requireThat((await operator('/backup-discovery')).candidates.includes(terminal), 'short-lived GitHub exchange was mistaken for fixture admission');
    const firstTerminal = await archive(terminal, '2099-01-01');
    requireThat(firstTerminal.status === 200 && firstTerminal.body.payload.state.issues.length === 0 && firstTerminal.body.payload.journal.records.length >= 2, 'first terminal logical archive or retained journal missing');
    const admitted = await mint(terminal); await revoke(admitted);
    await sweep('2099-01-01');
    const retired = await operator('/backup-discovery');
    requireThat(retired.all.includes(terminal) && !retired.candidates.includes(terminal) && retired.candidates.includes(ordinary), 'terminal watermark lost full discovery or suppressed ordinary history');
    await sweep('2099-01-02');
    requireThat((await archive(terminal, '2099-01-02')).status === 404 && (await archive(ordinary, '2099-01-02')).status === 200 && (await archive(terminal, '2099-01-01')).status === 200, 'terminal archive multiplied or ordinary history/latest archive disappeared');
    const fresh = await mint(terminal);
    requireThat((await operator('/backup-discovery')).candidates.includes(terminal), 'new live fixture key did not re-enlist a terminal tracker');
    const retainedJournal = await request(fresh.key, `/t/${terminal}/v0/beads/events?since=0&limit=1000`);
    requireThat(retainedJournal.status === 200 && retainedJournal.body.head === firstTerminal.body.payload.journal.head && retainedJournal.body.records.length === firstTerminal.body.payload.journal.records.length, 'terminal retirement removed retained database history');
    await clearedHistory(terminal, fresh); await revoke(fresh);
    await sweep('2099-01-03');
    const revised = await archive(terminal, '2099-01-03');
    requireThat(revised.status === 200 && revised.body.payload.source.mutation_revision > firstTerminal.body.payload.source.mutation_revision && revised.body.payload.journal.records.length > firstTerminal.body.payload.journal.records.length && !(await operator('/backup-discovery')).candidates.includes(terminal), 'new history was not archived and acknowledged at its new revision');
    const lifecycle = { terminal_single_archive_per_unchanged_revision: 'PASS', ordinary_empty_history_stays_daily: 'PASS', github_exchange_is_not_fixture_admission: 'PASS', new_key_and_revision_reenlist: 'PASS', history_untouched: 'PASS', terminal_latest_retained: 'PASS', initial_digest: firstTerminal.body.integrity.digest, revised_digest: revised.body.integrity.digest };
    saveStage('terminal-backup-lifecycle', lifecycle);
    const prepared = await operator('/prepare-retention', 'POST');
    requireThat(prepared.seeded === 129 && (await operator('/retention-evidence')).old_marker_present, 'independent retention fixture admission differs');
    const incomplete = await sweep('2099-01-04'), retained = await operator('/retention-evidence');
    requireThat(incomplete.progress.last_tracker !== null && incomplete.progress.pending_tracker === null && retained.progress && retained.progress.lease_until === 0 && !retained.old_marker_present && retained.newest_marker_present, 'bounded retention did not advance while the backup sweep remained incomplete');
    const report = { ...lifecycle, independent_retention_during_incomplete_sweep: 'PASS', minimal_incomplete_fixture_trackers: 129, backup_cursor: incomplete.progress.last_tracker, retention_phase: retained.progress.phase };
    saveStage('terminal-backup-and-retention', report); return report;
  } finally {
    for (const key of keys) {
      await revoke(key);
      requireThat((await request(key.key, `/t/${key.trackers[0]}/v0/beads/context`)).status === 401, 'terminal fixture key revocation did not deny access');
    }
  }
}
