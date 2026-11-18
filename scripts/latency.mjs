// Write latency against a deployed Worker: 100 sequential writes (50 creates, each followed by an update).
//   BASE_URL=https://beads-cloudflare.example.workers.dev TRACKER=latency TOKEN=... node scripts/latency.mjs
// TOKEN is an OAuth access token with beads:write. Nothing here prints it.

const { BASE_URL, TRACKER, TOKEN } = process.env;
if (!BASE_URL || !TRACKER || !TOKEN) {
  console.error("Set BASE_URL, TRACKER and TOKEN.");
  process.exit(2);
}

const WRITES = 100;
const api = `${BASE_URL.replace(/\/+$/, "")}/t/${encodeURIComponent(TRACKER)}/v0/beads`;
const run = Date.now().toString(36);

async function timed(label, method, path, body) {
  const started = performance.now();
  const response = await fetch(api + path, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      "Idempotency-Key": `latency-${run}-${label}`,
    },
    body: JSON.stringify({ actor: "latency-script", ...body }),
  });
  const elapsed = performance.now() - started;
  const json = await response.json();
  if (response.status !== 200) {
    throw new Error(`${method} ${path} -> ${response.status} ${JSON.stringify(json)}`);
  }
  return { elapsed, json };
}

const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
const report = (name, samples) => {
  const sorted = [...samples].sort((a, b) => a - b);
  const f = (ms) => ms.toFixed(1).padStart(7);
  console.log(`${name.padEnd(8)} n=${String(sorted.length).padStart(3)}  p50=${f(percentile(sorted, 50))} ms  p95=${f(percentile(sorted, 95))} ms  p99=${f(percentile(sorted, 99))} ms`);
};

const creates = [];
const updates = [];
for (let i = 0; i < WRITES / 2; i++) {
  const created = await timed(`c${i}`, "POST", "/issues", { title: `latency ${run} ${i}`, issue_type: "task", priority: 2 });
  creates.push(created.elapsed);
  const updated = await timed(`u${i}`, "PATCH", `/issues/${encodeURIComponent(created.json.id)}`, { patch: { description: `update ${i}` } });
  updates.push(updated.elapsed);
}

console.log(`${BASE_URL} tracker=${TRACKER}`);
report("create", creates);
report("update", updates);
report("all", [...creates, ...updates]);
