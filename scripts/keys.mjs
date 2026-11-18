// Manage agent API keys on a deployed Worker.
//   BASE_URL=https://beads-cloudflare.example.workers.dev BEADS_ADMIN_TOKEN=... \
//     node scripts/keys.mjs create <label> [--write] [--import] [--trackers a,b] [--days 90]
//     node scripts/keys.mjs list
//     node scripts/keys.mjs revoke <id>
// `create` prints the new key to stdout, once and alone, so it can be captured with $(...).
// Everything else goes to stderr. The admin token is never printed.

const { BASE_URL, BEADS_ADMIN_TOKEN } = process.env;
if (!BASE_URL || !BEADS_ADMIN_TOKEN) {
  console.error("Set BASE_URL and BEADS_ADMIN_TOKEN.");
  process.exit(2);
}

const base = BASE_URL.replace(/\/+$/, "");
const [command, ...rest] = process.argv.slice(2);

async function admin(method, path, body) {
  const response = await fetch(base + path, {
    method,
    headers: {
      Authorization: `Bearer ${BEADS_ADMIN_TOKEN}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await response.json();
  if (!response.ok) {
    console.error(`${method} ${path} -> ${response.status} ${json.detail ?? json.error_description ?? ""}`);
    process.exit(1);
  }
  return json;
}

function option(name) {
  const at = rest.indexOf(name);
  return at === -1 ? undefined : rest[at + 1];
}

if (command === "create") {
  const label = rest[0];
  if (!label || label.startsWith("--")) {
    console.error("Usage: keys.mjs create <label> [--write] [--import] [--trackers a,b] [--days 90]");
    process.exit(2);
  }
  const days = option("--days");
  const trackers = option("--trackers");
  const created = await admin("POST", "/admin/keys", {
    label,
    scopes: rest.includes("--import") ? ["beads:read", "beads:write", "beads:import"] : rest.includes("--write") ? ["beads:read", "beads:write"] : ["beads:read"],
    ...(trackers ? { trackers: trackers.split(",") } : {}),
    ...(days ? { expires_in_days: Number(days) } : {}),
  });
  console.error(`created key ${created.id} (${created.label}), scopes ${created.scopes.join(" ")}`);
  console.log(created.key);
} else if (command === "list") {
  const { items } = await admin("GET", "/admin/keys");
  for (const k of items) {
    const state = k.revoked_at ? "revoked" : k.expires_at && k.expires_at <= new Date().toISOString() ? "expired" : "active";
    console.log([k.id, state, k.label, k.scopes.join(","), k.trackers ? k.trackers.join(",") : "all", k.last_used_at ?? "never used"].join("\t"));
  }
} else if (command === "revoke") {
  if (!rest[0]) {
    console.error("Usage: keys.mjs revoke <id>");
    process.exit(2);
  }
  const revoked = await admin("DELETE", `/admin/keys/${encodeURIComponent(rest[0])}`);
  console.error(`revoked ${revoked.id} at ${revoked.revoked_at}`);
} else {
  console.error("Usage: keys.mjs create|list|revoke ...");
  process.exit(2);
}
