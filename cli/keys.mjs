// Agent keys for a store the user runs: `keys create|list|revoke` and `invite`, which mints a key for a teammate and
// prints the command they run. The admin token comes from the record setup keeps for the store (or BEADS_ADMIN_TOKEN);
// it is never printed. A new key is printed once, on standard output and nowhere else.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ambientBeadsStoreTrusted } from "./github-auth.mjs";
import { normalizeStoreUrl, trackerProblem } from "./lib.mjs";
import { registerSecret } from "./output.mjs";
import { Diagnosed, NPX, Report, createKey, findRepoConfig, request, userConfigDir } from "./commands.mjs";

/** The stores setup created on this machine: [{ name, origin, admin_token }]. */
function knownStores() {
  const dir = join(userConfigDir(), "beads-cloudflare", "stores");
  if (!existsSync(dir)) return [];
  const out = [];
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".json"))) {
    try {
      const state = JSON.parse(readFileSync(join(dir, file), "utf8"));
      if (typeof state.origin === "string") out.push({ name: state.name ?? file.slice(0, -5), origin: state.origin.replace(/\/+$/, ""), admin_token: state.admin_token });
    } catch {}
  }
  return out;
}

/** The admin token setup recorded on this machine for a store, or undefined. */
export function recordedAdminToken(base) {
  const token = knownStores().find((s) => s.origin === base)?.admin_token;
  return token ? registerSecret(token) : undefined;
}

/** The store to manage and its admin token. Throws a Diagnosed error naming the missing piece. */
function adminContext(flag) {
  const stores = knownStores();
  let repo;
  try {
    repo = findRepoConfig(process.cwd());
  } catch {}
  const given = flag.store ?? process.env.BEADS_CLOUDFLARE_BASE;
  const candidate = given ?? repo?.config?.base ?? (stores.length === 1 ? stores[0].origin : undefined);
  if (!candidate) {
    throw new Diagnosed("store", stores.length > 1 ? `this machine set up ${stores.length} stores: ${stores.map((s) => s.origin).join(", ")}` : "no store given and none set up on this machine", "name the store: --store <store url>");
  }
  const parsed = normalizeStoreUrl(candidate);
  if (parsed.error) throw new Diagnosed("store", parsed.error, "--store https://<your store>");
  const base = parsed.url;
  const recorded = stores.find((s) => s.origin === base)?.admin_token;
  if (recorded) return { base, admin: registerSecret(recorded), tracker: repo?.config?.base?.replace(/\/+$/, "") === base ? repo.config.tracker : undefined };
  const admin = process.env.BEADS_ADMIN_TOKEN;
  // An admin token from the environment goes only to a store the user named or the host trusts, never to an address a repository file supplied.
  if (admin && (flag.store || ambientBeadsStoreTrusted(base))) return { base, admin: registerSecret(admin), tracker: repo?.config?.tracker };
  throw new Diagnosed(
    "admin token",
    admin ? `BEADS_ADMIN_TOKEN is set, but ${base} came from .beads/cloudflare.json; name it yourself with --store` : `this machine has no admin token for ${base}`,
    [`run this on the machine that ran setup for ${base}`, `or set BEADS_ADMIN_TOKEN (the ADMIN_TOKEN of the store) and pass --store ${base}`],
  );
}

function scopesFrom(flag) {
  if (flag.import) return ["beads:read", "beads:write", "beads:import"];
  return flag["read-only"] ? ["beads:read"] : ["beads:read", "beads:write"];
}

function keyOptions(flag) {
  const trackers = flag.trackers ? flag.trackers.split(",").map((t) => t.trim()).filter(Boolean) : undefined;
  const bad = trackers?.find((t) => trackerProblem(t));
  if (bad) throw new Diagnosed("--trackers", trackerProblem(bad), "list tracker ids separated by commas");
  const days = flag.days === undefined ? undefined : Number(flag.days);
  if (days !== undefined && !(Number.isInteger(days) && days > 0 && days <= 3650)) throw new Diagnosed("--days", `"${flag.days}" is not a number of days`, "--days <1 to 3650>");
  return { trackers, days, scopes: scopesFrom(flag) };
}

const describe = (record, options) => `${record.id ?? "?"} (${record.label ?? "?"}; ${(record.scopes ?? options.scopes).join(" ")}; trackers ${(record.trackers ?? options.trackers ?? ["all"]).join(",")}${record.expires_at ? `; expires ${record.expires_at}` : ""})`;

export async function keysCommand(flag, positional) {
  const [action, argument] = positional;
  const usage = `${NPX} keys create <label> [--read-only|--import] [--trackers a,b] [--days n] | keys list | keys revoke <id>`;
  if (!["create", "list", "revoke"].includes(action)) throw new Diagnosed("keys", action ? `unknown action "${action}"` : "keys needs an action", usage);
  const { base, admin } = adminContext(flag);
  if (action === "create") {
    if (!argument || !/^[\x21-\x7e]{1,80}$/.test(argument)) throw new Diagnosed("keys create", "a key needs a label (the agent name it acts as)", usage);
    const options = keyOptions(flag);
    if (flag["dry-run"]) {
      console.error(`beads-cloudflare: dry run, would create key "${argument}" on ${base} with ${options.scopes.join(" ")}`);
      return 0;
    }
    const created = await createKey(base, admin, argument, { ...options, attempts: 3 });
    if (created.error) throw new Diagnosed("keys create", created.error, `check that ${base} is the store and its admin token is current`);
    console.error(`created key ${describe(created.record, options)} on ${base}; it is shown once:`);
    process.stdout.write(`${created.key}\n`);
    return 0;
  }
  if (action === "list") {
    const answer = await request("GET", `${base}/admin/keys`, { token: admin });
    if (answer.status !== 200 || !Array.isArray(answer.json?.items)) throw new Diagnosed("keys list", `${base}/admin/keys answered ${answer.status ? `HTTP ${answer.status}` : answer.error}`, "check the store address and the admin token");
    const now = new Date().toISOString();
    console.log(["id", "state", "label", "scopes", "trackers", "last used"].join("\t"));
    for (const k of answer.json.items) {
      const state = k.revoked_at ? "revoked" : k.expires_at && k.expires_at <= now ? "expired" : "active";
      console.log([k.id, state, k.label, (k.scopes ?? []).join(","), k.trackers ? k.trackers.join(",") : "all", k.last_used_at ?? "never"].join("\t"));
    }
    return 0;
  }
  if (!argument || !/^[A-Za-z0-9_-]{1,64}$/.test(argument)) throw new Diagnosed("keys revoke", "revoke needs a key id (from keys list)", usage);
  if (flag["dry-run"]) {
    console.log(`beads-cloudflare: dry run, would revoke ${argument} on ${base}`);
    return 0;
  }
  const answer = await request("DELETE", `${base}/admin/keys/${encodeURIComponent(argument)}`, { token: admin });
  if (answer.status !== 200) throw new Diagnosed("keys revoke", `${base} answered ${answer.status ? `HTTP ${answer.status}` : answer.error}`, `check the id with: ${NPX} keys list`);
  console.log(`revoked ${answer.json?.id ?? argument} at ${answer.json?.revoked_at ?? "now"}`);
  return 0;
}

/** Mints a key for a teammate (scoped to this repository's tracker by default) and prints what they run. */
export async function inviteCommand(flag) {
  const report = new Report(flag["dry-run"], `${NPX} invite`);
  const { base, admin, tracker: repoTracker } = adminContext(flag);
  const tracker = flag.tracker ?? repoTracker;
  if (tracker && trackerProblem(tracker)) throw new Diagnosed("--tracker", trackerProblem(tracker), "--tracker <id>");
  const options = keyOptions({ ...flag, trackers: flag.trackers ?? (flag["all-trackers"] ? undefined : tracker) });
  const label = flag.label ?? `invite-${new Date().toISOString().slice(0, 10)}-${Math.random().toString(36).slice(2, 6)}`;
  const join = `${NPX} join ${base}${tracker ? ` --tracker ${tracker}` : ""}`;
  if (flag["dry-run"]) {
    report.would(`create key "${label}" on ${base} (${options.scopes.join(" ")}; trackers ${options.trackers?.join(",") ?? "all"}) and print: ${join}`);
    return report.finish("invite");
  }
  const created = await createKey(base, admin, label, { ...options, attempts: 3 });
  if (created.error) throw new Diagnosed("invite", created.error, `check that ${base} is the store and its admin token is current`);
  console.log(`Invite for ${base}: key ${describe(created.record, options)}.
Send your teammate two things, the key by a private channel (not the same chat as the command):

  1. Run in their repository:
     ${join}
     (it asks for the key; without a terminal they save it to a file and add --token-file <file>)

  2. The key, shown only now:`);
  process.stdout.write(`     ${created.key}\n`);
  console.log(`\nRevoke it any time: ${NPX} keys revoke ${created.id ?? "<id>"}`);
  return 0;
}
