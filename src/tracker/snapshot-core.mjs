// Logical snapshot capture shared by `scripts/tracker-snapshot.mjs` (operator backups over HTTPS) and the
// Worker's scheduled backup (in-process reads). Plain JavaScript without Node or Worker APIs so both
// runtimes produce the same archive. A tracker that fits in SNAPSHOT_RESIDENT_BYTES stays one
// `logical-snapshot/v1` object. A larger one, journal included, is a v2 manifest plus part objects;
// each part stays within SNAPSHOT_MAX_BYTES and the walk holds one part, never the whole journal.

export const SNAPSHOT_FORMAT = "beads-cloudflare.logical-snapshot/v1";
export const SNAPSHOT_FORMAT_V2 = "beads-cloudflare.logical-snapshot/v2";
export const SNAPSHOT_PART_FORMAT = "beads-cloudflare.logical-snapshot-part/v2";
export const SNAPSHOT_MAX_BYTES = 64 << 20;
export const SNAPSHOT_PART_BYTES = 8 << 20;
export const SNAPSHOT_RESIDENT_BYTES = 32 << 20;
export const SNAPSHOT_EXCLUSIONS = ["api-keys", "oauth-kv-grants", "worker-secrets", "claim-principals-and-fencing", "idempotency-receipts"];
const DERIVED = new Set(["x_claim", "is_blocked", "dependency_count", "dependent_count", "comment_count", "parent", "revision", "comments_omitted", "lease_granted_node", "dependents", "epic_total_children", "epic_closed_children", "epic_closeable"]);
const RECORD_SECTIONS = ["issues", "dependencies", "memories", "settings"];
const PREFIX = "snapshots/";

export const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
export const cleanIssue = issue => Object.fromEntries(Object.entries(issue).filter(([key]) => !DERIVED.has(key)));
const orderBy = (items, key) => [...items].sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
export const snapshotPartName = index => `part-${String(index).padStart(5, "0")}.json`;

const budgetLimit = (value, fallback, allowZero) => {
  const n = value ?? fallback;
  if (!Number.isSafeInteger(n) || n > SNAPSHOT_MAX_BYTES || n < (allowZero ? 0 : 1)) throw new Error("snapshot part budget is invalid");
  return n;
};

/** One complete read. `spill: false` throws once the resident canonical bytes would pass `residentBytes`. */
async function walk(request, tracker, { byteLength, eventLimit = 10, sha256, capturedAt, spill, residentBytes, partBytes, journal, onPart }) {
  const before = await request(tracker, "/context");
  if (!before.capabilities?.includes("profile.logical_recovery_v1") || !Number.isSafeInteger(before.x_mutation_revision)) throw new Error("store does not advertise guarded logical recovery");
  const retained = { issues: [], dependencies: [], memories: [], settings: [], journal: [] };
  let retainedBytes = 0;
  let openBytes = 0;
  let peak = 0;
  let accounted = 0;
  let spilled = false;
  let partIndex = 0;
  let journalHead = 0;
  let journalCount = 0;
  let lastSeq = 0;
  let vocabBytes = 0;
  let retainedVocabulary = null;
  const parts = [];
  const open = { section: null, records: [], vocabulary: null, bytes: 0, seqFirst: null, seqLast: null };
  const note = () => { peak = Math.max(peak, retainedBytes + openBytes); };
  const sizeOf = value => byteLength(canonical(value));

  const sealOpen = async () => {
    if (open.section === null) return;
    if (partIndex > 99999) throw new Error("snapshot part index exceeded the archive name width");
    const payload = open.section === "vocabulary"
      ? { format: SNAPSHOT_PART_FORMAT, section: open.section, index: partIndex, tracker, captured_at: capturedAt, vocabulary: open.vocabulary }
      : { format: SNAPSHOT_PART_FORMAT, section: open.section, index: partIndex, tracker, captured_at: capturedAt, records: open.records };
    const body = open.section === "vocabulary" ? open.vocabulary : open.records;
    const count = open.section === "vocabulary" ? open.vocabulary.statuses.length + open.vocabulary.types.length : open.records.length;
    const digest = await sha256(canonical(payload));
    const recordsDigest = await sha256(canonical(body));
    const meta = { name: snapshotPartName(partIndex), section: open.section, index: partIndex, count, digest, recordsDigest, bytes: open.bytes, seqFirst: open.seqFirst, seqLast: open.seqLast };
    const envelope = { payload, integrity: { algorithm: "sha256", digest } };
    if (sizeOf(payload) > SNAPSHOT_MAX_BYTES) throw new Error("one snapshot part exceeds the 64 MiB memory budget");
    parts.push(meta);
    partIndex += 1;
    open.section = null;
    open.records = [];
    open.vocabulary = null;
    open.bytes = 0;
    open.seqFirst = null;
    open.seqLast = null;
    openBytes = 0;
    note();
    if (onPart) await onPart({ ...meta, envelope });
  };

  const addRecordStream = async (section, record, n) => {
    if (open.section && open.section !== section) await sealOpen();
    if (open.records.length && open.bytes + n > partBytes) await sealOpen();
    if (open.section === null) {
      open.section = section;
      open.seqFirst = section === "journal" ? record.seq : null;
    }
    open.records.push(record);
    open.bytes += n;
    openBytes = open.bytes;
    if (section === "journal") open.seqLast = record.seq;
    note();
    if (n > partBytes) await sealOpen();
  };

  const beginStream = async () => {
    if (spilled) return;
    spilled = true;
    if (typeof sha256 !== "function") throw new Error("snapshot archive needs a digest and a byte counter");
    for (const section of RECORD_SECTIONS) {
      const pending = retained[section];
      retained[section] = [];
      for (const record of pending) {
        const n = sizeOf(record);
        retainedBytes -= n;
        await addRecordStream(section, record, n);
      }
      pending.length = 0;
    }
    if (retainedVocabulary) {
      const vocabulary = retainedVocabulary;
      retainedVocabulary = null;
      retainedBytes -= vocabBytes;
      vocabBytes = 0;
      await sealVocabulary(vocabulary);
    }
    const pendingJournal = retained.journal;
    retained.journal = [];
    for (const record of pendingJournal) {
      const n = sizeOf(record);
      retainedBytes -= n;
      await addRecordStream("journal", record, n);
    }
    pendingJournal.length = 0;
    note();
  };

  const addRecord = async (section, record) => {
    const n = sizeOf(record);
    if (n > SNAPSHOT_MAX_BYTES) throw new Error("one snapshot record exceeds the 64 MiB memory budget");
    if (section === "journal") {
      if (!Number.isSafeInteger(record?.seq) || record.seq <= lastSeq) throw new Error("journal cursor did not advance");
      lastSeq = record.seq;
      journalHead = record.seq;
      journalCount += 1;
    }
    accounted += n;
    if (!spilled && retainedBytes + n <= residentBytes) {
      retained[section].push(record);
      retainedBytes += n;
      note();
      return;
    }
    if (!spill) throw new Error("snapshot exceeds the 64 MiB memory budget");
    await beginStream();
    await addRecordStream(section, record, n);
  };

  const sealVocabulary = async vocabulary => {
    const n = sizeOf(vocabulary);
    if (open.section) await sealOpen();
    open.section = "vocabulary";
    open.vocabulary = vocabulary;
    open.bytes = n;
    openBytes = n;
    note();
    await sealOpen();
  };

  const addVocabulary = async vocabulary => {
    const n = sizeOf(vocabulary);
    if (n > SNAPSHOT_MAX_BYTES) throw new Error("snapshot exceeds the 64 MiB memory budget");
    accounted += n;
    if (!spilled && retainedBytes + n <= residentBytes) {
      retainedVocabulary = vocabulary;
      vocabBytes = n;
      retainedBytes += n;
      note();
      return;
    }
    if (!spill) throw new Error("snapshot exceeds the 64 MiB memory budget");
    await beginStream();
    await sealVocabulary(vocabulary);
  };

  const pages = async (suffix, field, section, event = false) => {
    let cursor;
    let since = 0;
    let limit = eventLimit;
    for (;;) {
      let page;
      try {
        page = await request(tracker, event ? `${suffix}?limit=${limit}&since=${since}` : `${suffix}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      } catch (error) {
        // One events page is capped at the response budget. Read it again in smaller pages; one event over the budget still fails closed.
        if (!event || limit === 1 || !/byte budget/.test(error instanceof Error ? error.message : String(error))) throw error;
        limit = Math.max(1, Math.floor(limit / 2));
        continue;
      }
      const rows = page[field];
      if (!Array.isArray(rows)) throw new Error("invalid tracker export response");
      if (event) {
        if (!rows.length) { if (since !== page.head) throw new Error("incomplete journal export"); break; }
        for (const row of rows) await addRecord(section, row);
        const next = rows.at(-1).seq;
        if (!Number.isSafeInteger(next) || next <= since) throw new Error("journal cursor did not advance");
        since = next;
        if (since === page.head) break;
      } else {
        for (const row of rows) await addRecord(section, section === "issues" ? cleanIssue(row) : row);
        if (!page.has_more) break;
        if (!page.next_cursor || page.next_cursor === cursor) throw new Error("export cursor did not advance");
        cursor = page.next_cursor;
      }
    }
  };

  await pages("/issues:export?include_templates=true&include_gates=true&include_infra=true&include_ephemeral=true&limit=200", "items", "issues");
  await pages("/dependencies:export?limit=1000", "items", "dependencies");
  const memories = (await request(tracker, "/memories")).items;
  if (!Array.isArray(memories)) throw new Error("invalid tracker export response");
  for (const memory of memories) await addRecord("memories", memory);
  await pages("/config:export?limit=100", "items", "settings");
  const statuses = (await request(tracker, "/config:statuses:detailed")).statuses;
  const types = (await request(tracker, "/config:types")).types;
  if (!Array.isArray(statuses) || !Array.isArray(types)) throw new Error("invalid tracker export response");
  await addVocabulary({ statuses: orderBy(statuses, status => status.name), types });
  if (journal === "omit") {
    // Confirmation of restored state does not read the destination journal (import events are new).
  } else if (journal === "head") {
    const page = await request(tracker, "/events?limit=1&since=0");
    if (!Number.isSafeInteger(page.head) || page.head < 0) throw new Error("incomplete journal export");
    journalHead = page.head;
  } else {
    await pages("/events", "records", "journal", true);
  }
  if (spilled) await sealOpen();
  const after = await request(tracker, "/context");
  if (before.x_mutation_revision !== after.x_mutation_revision || before.project_id !== after.project_id ||
      before.x_store_version !== after.x_store_version || before.x_source_sha !== after.x_source_sha) throw new Error("tracker changed during snapshot; stop all writers before retrying a read");
  const capture = spilled ? null : {
    context: after,
    state: stateFrom(after.project_id, retained.issues, retained.dependencies, retained.memories, retained.settings, retainedVocabulary ?? { statuses: [], types: [] }),
    // `head` reports the journal length without retaining records when the caller did not ask for them.
    journal: journal === "full" ? { head: retained.journal.at(-1)?.seq ?? 0, records: retained.journal } : { head: journalHead, records: [] },
  };
  return { spilled, capture, parts, context: after, journalHead, journalCount, peak, accounted };
}

function stateFrom(projectId, issues, dependencies, memories, settings, vocabulary) {
  return {
    project_id: projectId,
    issues: orderBy(issues, issue => issue.id),
    dependencies: orderBy(dependencies, edge => `${edge.issue_id}\0${edge.depends_on_id}`),
    memories: orderBy(memories, memory => memory.key),
    settings: orderBy(settings, setting => setting.key),
    vocabulary,
  };
}

/** State parts only, in archive order. Journal parts are verified separately and are not retained here. */
export function assembleState(projectId, parts) {
  const take = section => parts.filter(part => part.section === section).flatMap(part => part.records);
  const vocabulary = parts.find(part => part.section === "vocabulary")?.vocabulary ?? { statuses: [], types: [] };
  return stateFrom(projectId, take("issues"), take("dependencies"), take("memories"), take("settings"), vocabulary);
}

/** One complete read of a tracker; throws if its revision or identity moved while reading. */
export async function captureSnapshot(request, tracker, { byteLength, eventLimit = 10, journal = "full" } = {}) {
  const walked = await walk(request, tracker, { byteLength, eventLimit, spill: false, residentBytes: SNAPSHOT_MAX_BYTES, partBytes: SNAPSHOT_PART_BYTES, journal, capturedAt: "" });
  return walked.capture;
}

const payloadFrom = (tracker, capture, origin, capturedAt) => ({
  format: SNAPSHOT_FORMAT,
  captured_at: capturedAt,
  source: { origin, tracker, store_version: capture.context.x_store_version, source_sha: capture.context.x_source_sha ?? null, mutation_revision: capture.context.x_mutation_revision },
  state: capture.state,
  journal: capture.journal,
  exclusions: SNAPSHOT_EXCLUSIONS,
});

/** Two identical complete reads, as one in-memory archive payload. Throws once the journal or state exceeds the resident budget. */
export async function snapshotPayload(request, tracker, { origin, byteLength, eventLimit, now = () => new Date() }) {
  const first = await captureSnapshot(request, tracker, { byteLength, eventLimit });
  const second = await captureSnapshot(request, tracker, { byteLength, eventLimit });
  if (canonical(first) !== canonical(second)) throw new Error("complete semantic snapshot changed across repeated reads; no archive was written");
  return payloadFrom(tracker, second, origin, now().toISOString());
}

const planIdentity = walked => canonical({
  project_id: walked.context.project_id,
  mutation_revision: walked.context.x_mutation_revision,
  store_version: walked.context.x_store_version,
  source_sha: walked.context.x_source_sha ?? null,
  journal_head: walked.journalHead,
  journal_count: walked.journalCount,
  parts: walked.parts.map(part => ({ section: part.section, count: part.count, digest: part.digest, records_digest: part.recordsDigest, seq_first: part.seqFirst, seq_last: part.seqLast })),
});

const manifestFrom = (tracker, walked, origin, capturedAt, partBytes) => ({
  format: SNAPSHOT_FORMAT_V2,
  captured_at: capturedAt,
  source: { origin, tracker, store_version: walked.context.x_store_version, source_sha: walked.context.x_source_sha ?? null, mutation_revision: walked.context.x_mutation_revision },
  state: { project_id: walked.context.project_id },
  journal: { head: walked.journalHead, records: walked.journalCount },
  part_bytes: partBytes,
  parts: walked.parts.map(part => ({
    name: part.name, section: part.section, index: part.index, count: part.count, digest: part.digest, records_digest: part.recordsDigest,
    ...(part.section === "journal" ? { seq_first: part.seqFirst, seq_last: part.seqLast } : {}),
  })),
  exclusions: SNAPSHOT_EXCLUSIONS,
});

const changed = () => { throw new Error("complete semantic snapshot changed across repeated reads; no archive was written"); };

/**
 * Read a tracker until two passes agree, then emit one v1 archive or a v2 manifest after its parts.
 * `emit` runs only after the two passes agree. A later mismatch calls `abort` with names already emitted
 * and does not emit the manifest. Peak resident data is one part once the tracker no longer fits.
 */
export async function archiveSnapshot(request, tracker, options) {
  const { origin, byteLength, eventLimit, sha256, emit, abort, now = () => new Date() } = options;
  if (typeof sha256 !== "function" || typeof byteLength !== "function" || typeof emit !== "function") throw new Error("snapshot archive needs a digest and a byte counter");
  const capturedAt = now().toISOString();
  const residentBytes = budgetLimit(options.residentBytes, SNAPSHOT_RESIDENT_BYTES, true);
  const partBytes = budgetLimit(options.partBytes, SNAPSHOT_PART_BYTES, false);
  const base = { byteLength, eventLimit, sha256, capturedAt, partBytes, journal: "full" };
  const first = await walk(request, tracker, { ...base, spill: true, residentBytes });
  const names = [];
  const rollback = async error => {
    if (abort && names.length) {
      try { await abort(names); }
      catch (abortError) { throw new Error(`${error instanceof Error ? error.message : String(error)}; snapshot rollback failed`, { cause: error }); }
    }
    throw error;
  };
  try {
    if (!first.spilled) {
      const second = await walk(request, tracker, { ...base, spill: false, residentBytes: SNAPSHOT_MAX_BYTES });
      if (canonical(first.capture) !== canonical(second.capture)) changed();
      const payload = payloadFrom(tracker, second.capture, origin, capturedAt);
      const digest = await sha256(canonical(payload));
      const envelope = { payload, integrity: { algorithm: "sha256", digest } };
      const body = `${JSON.stringify(envelope)}\n`;
      if (byteLength(body) > SNAPSHOT_MAX_BYTES) throw new Error("sealed snapshot exceeds the 64 MiB archive budget");
      await emit({ role: "archive", name: "archive", envelope, body });
      names.push("archive");
      return { format: SNAPSHOT_FORMAT, digest, bytes: byteLength(body), parts: 1, mutation_revision: second.capture.context.x_mutation_revision, peakResident: Math.max(first.peak, second.peak), journalHead: second.capture.journal.head, accounted: first.accounted };
    }
    const second = await walk(request, tracker, { ...base, spill: true, residentBytes: 0 });
    if (planIdentity(first) !== planIdentity(second)) changed();
    let stored = 0;
    const third = await walk(request, tracker, { ...base, spill: true, residentBytes: 0, onPart: async part => {
      const expected = second.parts[part.index];
      if (!expected || expected.digest !== part.digest || expected.recordsDigest !== part.recordsDigest) changed();
      const body = `${JSON.stringify(part.envelope)}\n`;
      if (byteLength(body) > SNAPSHOT_MAX_BYTES) throw new Error("sealed snapshot exceeds the 64 MiB archive budget");
      await emit({ role: "part", name: part.name, envelope: part.envelope, body });
      names.push(part.name);
      stored += byteLength(body);
    } });
    if (planIdentity(second) !== planIdentity(third)) changed();
    const payload = manifestFrom(tracker, second, origin, capturedAt, partBytes);
    const digest = await sha256(canonical(payload));
    const envelope = { payload, integrity: { algorithm: "sha256", digest } };
    const body = `${JSON.stringify(envelope)}\n`;
    if (byteLength(body) > SNAPSHOT_MAX_BYTES) throw new Error("sealed snapshot exceeds the 64 MiB archive budget");
    await emit({ role: "manifest", name: "manifest", envelope, body });
    names.push("manifest");
    stored += byteLength(body);
    return { format: SNAPSHOT_FORMAT_V2, digest, bytes: stored, parts: second.parts.length, mutation_revision: second.context.x_mutation_revision, peakResident: Math.max(first.peak, second.peak, third.peak), journalHead: second.journalHead, accounted: second.accounted };
  } catch (error) {
    await rollback(error);
  }
}

/** State-only part digests of a live tracker, packed with the archive's `partBytes`, for restore confirmation. */
export async function readStateParts(request, tracker, { byteLength, sha256, eventLimit, partBytes }) {
  const walked = await walk(request, tracker, {
    byteLength, sha256, eventLimit, capturedAt: "state-confirmation", spill: true, residentBytes: 0,
    partBytes: budgetLimit(partBytes, SNAPSHOT_PART_BYTES, false), journal: "omit",
  });
  return {
    context: walked.context,
    parts: walked.parts.map(part => ({ section: part.section, count: part.count, recordsDigest: part.recordsDigest })),
  };
}

/** `snapshots/<tracker>/<id>.snapshot.json` is a manifest; `snapshots/<tracker>/<id>/part-NNNNN.json` is one part. */
export function classifySnapshotKey(key) {
  if (typeof key !== "string" || !key.startsWith(PREFIX)) return null;
  const rest = key.slice(PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return null;
  const tracker = rest.slice(0, slash);
  const tail = rest.slice(slash + 1);
  if (!tail) return null;
  const nested = tail.indexOf("/");
  if (nested === -1) {
    const suffix = ".snapshot.json";
    if (!tail.endsWith(suffix)) return { tracker, id: "", role: "ignore", key };
    const id = tail.slice(0, -suffix.length);
    if (!id) return { tracker, id: "", role: "ignore", key };
    return { tracker, id, role: "manifest", key };
  }
  const id = tail.slice(0, nested);
  const name = tail.slice(nested + 1);
  if (!id || name.includes("/") || !/^part-\d{5}\.json$/.test(name)) return { tracker, id, role: "ignore", key };
  return { tracker, id, role: "part", key, name };
}

/**
 * Keys to delete. The newest manifest of each tracker is always kept, and so is every manifest
 * uploaded at or after the cutoff. Every part of a kept manifest is kept. Parts with no kept
 * manifest, including a failed upload that never wrote one, are deleted. Unrecognized keys are not.
 */
export function expiredSnapshotKeys(objects, cutoffMs) {
  if (!Array.isArray(objects) || !Number.isFinite(cutoffMs)) throw new Error("snapshot retention input is invalid");
  const groups = new Map();
  for (const object of objects) {
    if (!object || typeof object.key !== "string" || !Number.isFinite(object.uploaded)) throw new Error("snapshot retention input is invalid");
    const kind = classifySnapshotKey(object.key);
    if (!kind || kind.role === "ignore") continue;
    const group = groups.get(kind.tracker) ?? groups.set(kind.tracker, { manifests: [], parts: [] }).get(kind.tracker);
    (kind.role === "manifest" ? group.manifests : group.parts).push({ key: object.key, uploaded: object.uploaded, id: kind.id });
  }
  const expired = [];
  for (const group of groups.values()) {
    let newest = -Infinity;
    for (const manifest of group.manifests) if (manifest.uploaded > newest) newest = manifest.uploaded;
    const kept = new Set();
    for (const manifest of group.manifests) {
      if (manifest.uploaded === newest || manifest.uploaded >= cutoffMs) kept.add(manifest.id);
      else expired.push(manifest.key);
    }
    for (const part of group.parts) if (!kept.has(part.id)) expired.push(part.key);
  }
  return expired;
}
