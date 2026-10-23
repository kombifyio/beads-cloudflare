// Shared policy, projected verbatim from its registered source; edit that source.
// The issue train's waiting and first-comment-wins claim policy. Native ready remains unchanged.
export const WAITING_LABEL = /^(train-blocked|blocked-.+|test-window|build-phase-test-window|pending-window)$/;
const WAITING = WAITING_LABEL;
const WINDOW = 24 * 3600_000;
const done = (issue) => issue.status === "closed" || issue.status === "pinned";
const key = (tracker, id) => `${tracker}/${id}`;
export function claimState(comments = [], now = Date.now(), hours = 24) {
    const window = hours * 3600_000;
    let thread = null, at = 0, train = false;
    for (const comment of [...comments].sort((a, b) => (Date.parse(a.created_at) || now) - (Date.parse(b.created_at) || now))) {
        const time = Date.parse(comment.created_at) || now;
        if (/^\s*(released:|train-blocked\b)/i.test(comment.text)) {
            thread = null;
            at = 0;
            train = false;
            continue;
        }
        const name = /^\s*thread:\s*([^\s,;]+)/i.exec(comment.text)?.[1];
        if (name && (thread === null || name === thread || time - at > window)) {
            thread = name;
            at = time;
            train = /\(issue train\b/.test(comment.text);
        }
    }
    return { live: thread !== null && now - at <= window, thread, at: thread ? new Date(at).toISOString() : null, train };
}
export function threadClaim(issue, now) {
    const { at, ...claim } = claimState(issue.comments ?? [], now);
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
        const claim = threadClaim(issue, now);
        const native = issue.x_claim;
        const nativeLive = Boolean(native && typeof native === "object" && "state" in native && native.state === "live") || Boolean(issue.lease_expires_at && (Date.parse(issue.lease_expires_at) || Infinity) > now);
        const repo = repository(issue, store);
        const dependencies = targets(issue, store);
        const reasons = [];
        const ready = readyByTracker.get(store.tracker)?.has(issue.id) ?? false;
        const quiet = now - (Date.parse(issue.updated_at) || 0) > WINDOW && (issue.comments ?? []).every(comment => now - (Date.parse(comment.created_at) || 0) > WINDOW);
        const lapsed = !claim.live && claim.thread && issue.status === "in_progress" && quiet && !nativeLive;
        if (!ready && !lapsed)
            reasons.push({ code: "native_not_ready", detail: `native ready excludes status ${issue.status}, blockers, defer date, or infrastructure type` });
        if (issue.issue_type === "epic" || issue.issue_type === "milestone" || issue.labels?.includes("milestone"))
            reasons.push({ code: "planning_container", detail: "epics and milestones organize work; select an executable child" });
        for (const label of issue.labels ?? [])
            if (WAITING.test(label))
                reasons.push({ code: "waiting_label", detail: label });
        if (claim.live)
            reasons.push({ code: "thread_claim", detail: `held by ${claim.thread} since ${claim.since}` });
        if (nativeLive)
            reasons.push({ code: "native_claim", detail: native && typeof native === "object" && "assignee" in native ? `claimed by ${native.assignee} until ${native.lease_expires_at ?? issue.lease_expires_at}; the holder's writes renew the lease and a lapsed lease releases itself` : "a live claim holds this issue until its lease lapses" });
        if (issue.assignee && issue.assignee !== options.worker)
            reasons.push({ code: "assignee_reassignment", detail: `assigned to ${issue.assignee}; a verified principal must reassign it to the current worker before train status or close commands, without --force or impersonation` });
        // A foreign reference has display resolution only. It must never pass as an enforced native gate.
        for (const target of dependencies)
            if (["blocks", "conditional-blocks", "waits-for"].includes(target.type) && !target.executable_dependency && !(target.state === "resolved" && ["closed", "pinned"].includes(target.status ?? "")))
                reasons.push({ code: "foreign_dependency", detail: `${target.tracker ?? "unknown"}/${target.id}: ${target.state}; cross-tracker execution is unsupported` });
        if (lapsed && issue.is_blocked)
            reasons.push({ code: "blocked", detail: "lapsed thread claim still has native blockers" });
        if (lapsed && issue.defer_until && (Date.parse(issue.defer_until) || Infinity) > now)
            reasons.push({ code: "deferred_until", detail: `deferred until ${issue.defer_until}` });
        const open_children = [...(children.get(key(store.tracker, issue.id)) ?? [])];
        const summary = { id: issue.id, title: issue.title, status: issue.status, priority: issue.priority, issue_type: issue.issue_type, created_at: issue.created_at, updated_at: issue.updated_at, assignee: issue.assignee ?? null, lease_expires_at: issue.lease_expires_at ?? null, x_claim: issue.x_claim ?? null, revision: issue.revision, parent: issue.parent ?? null, is_blocked: issue.is_blocked, dependencies: issue.dependencies ?? [] };
        return { ...summary, labels: issue.labels ?? [], tracker: store.tracker, store: store.repository, repo, native_ready: ready, thread_claim: claim, dependency_targets: dependencies, open_children, completion_reasons: open_children.length ? [{ code: "open_children", detail: `${open_children.length} children are not closed; native close also requires pinned children to close` }] : [], reasons, actionable: reasons.length === 0, ...(lapsed ? { lapsed_claim: claim.thread } : {}) };
    }));
    const claimed = rows.filter(row => row.thread_claim.live).map(row => ({ id: row.id, tracker: row.tracker, store: row.store, repo: row.repo, thread: row.thread_claim.thread, since: row.thread_claim.since, train: row.thread_claim.train, status: row.status, priority: row.priority, title: row.title }));
    const held = new Map(claimed.filter(row => row.train && row.thread !== options.worker).map(row => [row.repo, row.thread]));
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
        definitions: { scope: "all stored issue types and tiers, including templates, gates, ephemeral records, epics and deferred", nonterminal: "every status except closed and pinned, including epics and deferred", native_ready: "unchanged upstream-compatible ready membership before train policy", actionable: "native ready or quiet lapsed thread claim, excluding containers, waiting labels, active claims, held repositories, and unsupported foreign blockers", cross_tracker_dependencies: "display resolution only; native scheduling does not enforce cross-tracker edges", consistency: "revision-stable within each tracker; observations across trackers are not atomic", details: "items are selection summaries; retrieve the authoritative full issue through bead_get or beads:read show before working" },
        stores: stores.map(store => store.kind === "ok" ? { tracker: store.tracker, repository: store.repository, kind: store.kind, read_at: store.read_at, revision: store.revision, counts: { ...countsOf(store.issues), native_ready: store.ready_ids.length, actionable: rows.filter(row => row.tracker === store.tracker && row.actionable).length } } : store),
        totals: { ...countsOf(successful.flatMap(store => store.issues)), native_ready: successful.reduce((n, store) => n + store.ready_ids.length, 0), actionable: rows.filter(row => row.actionable).length },
        open_p0: p0, claimed, resume: claimed.filter(row => row.thread === options.worker), selection: rows.filter(row => row.actionable).slice(0, options.limit ?? 20), items: rows,
    };
}
