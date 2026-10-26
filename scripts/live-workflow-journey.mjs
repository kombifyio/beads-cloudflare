// A bounded part of pair-proof-live: real HTTP/MCP calls under its finite shared-test credential.
// The caller owns fixture cleanup and credential revocation, including after a failed assertion.
import { randomUUID } from 'node:crypto';

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
    const principal = context.x_identity.verified_principal.email;
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
      requireThat(readback.status === 'closed' && readback.close_reason === args.reason && readback.comments?.filter(item => item.id === comment?.x_comment_id && item.text === evidence && item.author === principal).length === 1 && readback.comment_count === before.comment_count + 1, 'atomic completion or replay changed/lost evidence');
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
