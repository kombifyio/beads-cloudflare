// 20 concurrent claimNext requests against a deployed Worker; exactly one may win.
//   BASE_URL=https://beads-cloudflare.example.workers.dev TOKEN=... node scripts/claim-race.mjs
// TRACKER defaults to a fresh one so the single ready item is the only candidate.

const { BASE_URL, TOKEN } = process.env;
const TRACKER = process.env.TRACKER ?? `race-${Date.now().toString(36)}`;
if (!BASE_URL || !TOKEN) {
  console.error("Set BASE_URL and TOKEN (and optionally TRACKER, which must hold no other ready items).");
  process.exit(2);
}

const RACERS = 20;
const api = `${BASE_URL.replace(/\/+$/, "")}/t/${encodeURIComponent(TRACKER)}/v0/beads`;
const send = (method, path, body) =>
  fetch(api + path, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ actor: "claim-race-script", ...body }),
  }).then(async (response) => ({ status: response.status, body: await response.json() }));

const created = await send("POST", "/issues", { title: "claim race", issue_type: "task", priority: 2 });
if (created.status !== 200) throw new Error(`create failed: ${JSON.stringify(created.body)}`);

const replies = await Promise.all(Array.from({ length: RACERS }, () => send("POST", "/issues:claimNext", {})));
const winners = replies.filter((r) => r.status === 200 && r.body.claimed).length;
const empty = replies.filter((r) => r.status === 200 && r.body.claimed === undefined).length;
const other = replies.length - winners - empty;

console.log(`${BASE_URL} tracker=${TRACKER} item=${created.body.id}`);
console.log(`racers=${RACERS} winners=${winners} nothing-to-claim=${empty} other=${other}`);
process.exit(winners === 1 && other === 0 ? 0 : 1);
