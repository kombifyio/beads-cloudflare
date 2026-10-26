// Canonical workspace policy, projected verbatim into beads-cloudflare.
// Native leases own allocation; comments retain train provenance only. Native ready is unchanged.
export const WAITING_LABEL = /^(train-blocked|blocked-.+|test-window|build-phase-test-window|pending-window)$/;
const WAITING = WAITING_LABEL;
const WINDOW = 24 * 3600_000;
const done = (issue) => issue.status === "closed" || issue.status === "pinned";
const key = (tracker, id) => `${tracker}/${id}`;
export function claimState(issue = {}, now = Date.now()) {
    const native = issue.x_claim;
    const worker = native?.assignee ?? issue.assignee;
    const thread = typeof worker === "string" && worker ? worker : null;
    const until = native?.lease_expires_at ?? issue.lease_expires_at ?? null;
    const expiry = typeof until === "string" ? Date.parse(until) : NaN;
    // An authoritative live state excludes work even if its supporting fields
    // are malformed. Ownership below still requires a qualified future lease.
    const live = native?.state === "live" || (!native?.state && issue.status === "in_progress" &&
        thread !== null && Number.isFinite(expiry) && expiry > now);
    const principal = typeof native?.verified_principal === "string" && native.verified_principal ? native.verified_principal : null;
    const started = [issue.started_at, native?.heartbeat_at, issue.updated_at].find(value => typeof value === "string" && Number.isFinite(Date.parse(value)));
    // This marks an existing train worker's repository lane. It cannot create,
    // renew or release ownership, and never holds a repository after expiry.
    const train = live && (issue.comments ?? []).some(comment =>
        /^\s*thread:\s*([^\s,;]+)/i.exec(comment.text)?.[1] === thread && /\(issue train\b/.test(comment.text));
    return { live, thread, principal, until, at: thread ? started ?? new Date(now).toISOString() : null, train };
}
export function claimOwnedBy(issue, worker, verifiedPrincipal, now = Date.now()) {
    const claim = claimState(issue, now);
    return claim.live && issue.status === "in_progress" && typeof claim.until === "string" && Number.isFinite(Date.parse(claim.until)) &&
        Date.parse(claim.until) > now && claim.thread !== null && claim.thread === worker && typeof verifiedPrincipal === "string" &&
        verifiedPrincipal !== "" && claim.principal === verifiedPrincipal;
}
export function threadClaim(issue, now) {
    const { at, ...claim } = claimState(issue, now);
    return { ...claim, since: at };
}
export function projectWork(stores, catalog, options = {}) {
    const now = Date.now();
    // An explicit order is a priority prefix; unlisted repositories retain the train's P0/name ranking.
    const repositoryOrder = options.repositoryOrder ?? catalog.map(repo => repo.name);
    const rank = (repo) => { const i = repositoryOrder.indexOf(repo); return i < 0 ? repositoryOrder.length : i; };
    const successful = stores.filter(store => store.kind === "ok");
    const byKey = new Map(successful.flatMap(store => store.issues.map(issue => [key(store.tracker, issue.id), issue])));
    const byId = new Map();
    const children = new Map();
    const readyByTracker = new Map(successful.map(store => [store.tracker, new Set(store.ready_ids)]));
    for (const store of successful)
        for (const issue of store.issues) {
            const matches = byId.get(issue.id) ?? [];
            matches.push({ tracker: store.tracker, issue });
            byId.set(issue.id, matches);
            if (issue.status !== "closed")
                for (const parent of [issue.parent, ...(issue.dependencies ?? []).filter(edge => edge.type === "parent-child").map(edge => edge.depends_on_id)]) {
                    if (!parent)
                        continue;
                    const parentKey = key(store.tracker, parent);
                    const ids = children.get(parentKey) ?? new Set();
                    ids.add(issue.id);
                    children.set(parentKey, ids);
                }
        }
    const repository = (issue, store) => {
        let current = issue;
        const seen = new Set();
        while (current && !seen.has(current.id)) {
            seen.add(current.id);
            const labels = (current.labels ?? []).filter(label => label.startsWith("repo:")).map(label => label.slice(5));
            if (labels.length && store.repository === options.sharedRepository)
                return labels.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))[0] ?? store.repository;
            current = current.parent ? byKey.get(key(store.tracker, current.parent)) : undefined;
        }
        return store.repository;
    };
    const countsOf = (rows) => {
        const by_status = {};
        for (const issue of rows)
            by_status[issue.status] = (by_status[issue.status] ?? 0) + 1;
        return { total: rows.length, by_status, nonterminal: rows.filter(issue => !done(issue)).length, epics: rows.filter(issue => issue.issue_type === "epic").length, deferred: rows.filter(issue => issue.status === "deferred").length };
    };
    const targets = (issue, store) => (issue.dependencies ?? []).map(edge => {
        const local = byKey.get(key(store.tracker, edge.depends_on_id));
        if (local)
            return { id: edge.depends_on_id, type: edge.type, tracker: store.tracker, state: "resolved", status: local.status, title: local.title, executable_dependency: true };
        const found = byId.get(edge.depends_on_id) ?? [];
        if (found.length === 1) {
            const target = found[0];
            return { id: edge.depends_on_id, type: edge.type, tracker: target.tracker, state: "resolved", status: target.issue.status, title: target.issue.title, executable_dependency: false };
        }
        const hinted = catalog.filter(repo => edge.depends_on_id.startsWith(`${repo.tracker}-`)).sort((a, b) => b.tracker.length - a.tracker.length)[0];
        const read = hinted && stores.find(other => other.tracker === hinted.tracker);
        return { id: edge.depends_on_id, type: edge.type, tracker: hinted?.tracker ?? null, state: found.length > 1 ? "ambiguous" : read?.kind === "inaccessible" ? "inaccessible" : read?.kind === "unavailable" ? "unavailable" : "unresolved", executable_dependency: false };
    });
    const rows = successful.flatMap(store => store.issues.filter(issue => !done(issue)).map(issue => {
        const claim = { ...threadClaim(issue, now), owned: claimOwnedBy(issue, options.worker, store.identity?.verified_principal?.subject, now) };
        const native = issue.x_claim;
        const nativeLive = claim.live;
        const repo = repository(issue, store);
        const dependencies = targets(issue, store);
        const reasons = [];
        const ready = readyByTracker.get(store.tracker)?.has(issue.id) ?? false;
        const quiet = now - (Date.parse(issue.updated_at) || 0) > WINDOW;
        const expired = typeof claim.until === "string" && Number.isFinite(Date.parse(claim.until)) && Date.parse(claim.until) <= now;
        const lapsed = !claim.live && claim.thread && issue.status === "in_progress" && (expired || quiet);
        if (!ready && !lapsed)
            reasons.push({ code: "native_not_ready", detail: `native ready excludes status ${issue.status}, blockers, defer date, or infrastructure type` });
        if (issue.issue_type === "epic" || issue.issue_type === "milestone" || issue.labels?.includes("milestone"))
            reasons.push({ code: "planning_container", detail: "epics and milestones organize work; select an executable child" });
        for (const label of issue.labels ?? [])
            if (WAITING.test(label))
                reasons.push({ code: "waiting_label", detail: label });
        if (nativeLive)
            reasons.push({ code: "native_claim", detail: native && typeof native === "object" && "assignee" in native ? `claimed by ${native.assignee} until ${native.lease_expires_at ?? issue.lease_expires_at}; the holder's writes renew the lease and a lapsed lease releases itself` : "a live claim holds this issue until its lease lapses" });
        if (issue.assignee && issue.assignee !== options.worker)
            reasons.push({ code: "assignee_reassignment", detail: `assigned to ${issue.assignee}; a verified principal must reassign it to the current worker before train status or close commands, without --force or impersonation` });
        // A foreign reference has display resolution only. It must never pass as an enforced native gate.
        for (const target of dependencies)
            if (["blocks", "conditional-blocks", "waits-for"].includes(target.type) && !target.executable_dependency && !(target.state === "resolved" && ["closed", "pinned"].includes(target.status ?? "")))
                reasons.push({ code: "foreign_dependency", detail: `${target.tracker ?? "unknown"}/${target.id}: ${target.state}; cross-tracker execution is unsupported` });
        if (lapsed && issue.is_blocked)
            reasons.push({ code: "blocked", detail: "lapsed native claim still has native blockers" });
        if (lapsed && issue.defer_until && (Date.parse(issue.defer_until) || Infinity) > now)
            reasons.push({ code: "deferred_until", detail: `deferred until ${issue.defer_until}` });
        const open_children = [...(children.get(key(store.tracker, issue.id)) ?? [])];
        const summary = { id: issue.id, title: issue.title, status: issue.status, priority: issue.priority, issue_type: issue.issue_type, created_at: issue.created_at, updated_at: issue.updated_at, assignee: issue.assignee ?? null, lease_expires_at: issue.lease_expires_at ?? null, x_claim: issue.x_claim ?? null, revision: issue.revision, parent: issue.parent ?? null, is_blocked: issue.is_blocked, dependencies: issue.dependencies ?? [] };
        return { ...summary, labels: issue.labels ?? [], tracker: store.tracker, store: store.repository, repo, native_ready: ready, thread_claim: claim, dependency_targets: dependencies, open_children, completion_reasons: open_children.length ? [{ code: "open_children", detail: `${open_children.length} children are not closed; native close also requires pinned children to close` }] : [], reasons, actionable: reasons.length === 0, ...(lapsed ? { lapsed_claim: claim.thread } : {}) };
    }));
    const claimed = rows.filter(row => row.thread_claim.live).map(row => ({ id: row.id, tracker: row.tracker, store: row.store, repo: row.repo, thread: row.thread_claim.thread, principal: row.thread_claim.principal, until: row.thread_claim.until, owned: row.thread_claim.owned, since: row.thread_claim.since, train: row.thread_claim.train, status: row.status, priority: row.priority, title: row.title }));
    const held = new Map(claimed.filter(row => row.train && !row.owned).map(row => [row.repo, row.thread]));
    for (const row of rows)
        if (row.actionable && !options.allowSharedRepo && held.has(row.repo)) {
            row.reasons.push({ code: "repository_claim", detail: `${row.repo} held by ${held.get(row.repo)}` });
            row.actionable = false;
        }
    const p0 = {};
    for (const row of rows)
        if (row.priority === 0 && row.issue_type !== "epic" && ["open", "in_progress", "blocked"].includes(row.status))
            p0[row.repo] = (p0[row.repo] ?? 0) + 1;
    rows.sort((a, b) => a.priority - b.priority || rank(a.repo) - rank(b.repo) || (rank(a.repo) === repositoryOrder.length ? (p0[b.repo] ?? 0) - (p0[a.repo] ?? 0) || a.repo.localeCompare(b.repo) : 0) || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
    return {
        schema: "beads.actionable.v1", generated_at: new Date(now).toISOString(), authority: "cloudflare", partial: stores.some(store => store.kind !== "ok"),
        definitions: { scope: "all stored issue types and tiers, including templates, gates, ephemeral records, epics and deferred", nonterminal: "every status except closed and pinned, including epics and deferred", native_ready: "unchanged upstream-compatible ready membership before train policy", actionable: "native ready or expired/quiet unleased in-progress work, excluding containers, waiting labels, active claims, held repositories, and unsupported foreign blockers", cross_tracker_dependencies: "display resolution only; native scheduling does not enforce cross-tracker edges", consistency: "revision-stable within each tracker; observations across trackers are not atomic", details: "items are selection summaries; retrieve the authoritative full issue through bead_get or beads:read show before working" },
        stores: stores.map(store => store.kind === "ok" ? { tracker: store.tracker, repository: store.repository, kind: store.kind, read_at: store.read_at, revision: store.revision, counts: { ...countsOf(store.issues), native_ready: store.ready_ids.length, actionable: rows.filter(row => row.tracker === store.tracker && row.actionable).length } } : store),
        totals: { ...countsOf(successful.flatMap(store => store.issues)), native_ready: successful.reduce((n, store) => n + store.ready_ids.length, 0), actionable: rows.filter(row => row.actionable).length },
        open_p0: p0, claimed, resume: claimed.filter(row => row.owned), selection: rows.filter(row => row.actionable).slice(0, options.limit ?? 20), items: rows,
    };
}
