// Interactive sign-in for local clients and the check scripts: dynamic client registration,
// authorization code with PKCE on a loopback redirect, then the token is stored for reuse.
//   BASE_URL=https://beads-cloudflare.example.workers.dev node scripts/login.mjs
//   BASE_URL=... node scripts/login.mjs --refresh     (renews the stored token without a browser)
// Credentials go to ~/.config/beads-cloudflare/credentials.json; nothing here prints a token.

import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const base = (process.env.BASE_URL ?? "").replace(/\/+$/, "");
if (!base) {
  console.error("Set BASE_URL.");
  process.exit(2);
}
const store = join(homedir(), ".config", "beads-cloudflare");
const file = join(store, "credentials.json");
const SCOPE = "beads:read beads:write offline_access";
const b64url = (buf) => buf.toString("base64url");

const meta = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();

function save(client, token) {
  mkdirSync(store, { recursive: true });
  const all = (() => {
    try {
      return JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return {};
    }
  })();
  all[base] = {
    client_id: client.client_id,
    access_token: token.access_token,
    refresh_token: token.refresh_token ?? all[base]?.refresh_token,
    expires_at: Date.now() + (token.expires_in ?? 3600) * 1000,
    scope: token.scope,
  };
  writeFileSync(file, JSON.stringify(all, null, 2), { mode: 0o600 });
  console.log(`Signed in to ${base}; scope "${token.scope}"; stored in ${file}.`);
}

async function tokenRequest(params) {
  const response = await fetch(meta.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...params, resource: base }),
  });
  const json = await response.json();
  if (!response.ok) throw new Error(`token endpoint ${response.status}: ${json.error ?? "error"}`);
  return json;
}

if (process.argv.includes("--refresh")) {
  const saved = JSON.parse(readFileSync(file, "utf8"))[base];
  if (!saved?.refresh_token) throw new Error("No stored refresh token; sign in first.");
  const token = await tokenRequest({
    grant_type: "refresh_token",
    refresh_token: saved.refresh_token,
    client_id: saved.client_id,
  });
  save({ client_id: saved.client_id }, token);
  process.exit(0);
}

const server = createServer();
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const redirectUri = `http://127.0.0.1:${server.address().port}/callback`;

const registration = await fetch(meta.registration_endpoint, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    client_name: "beads-cloudflare local login",
    redirect_uris: [redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  }),
});
const client = await registration.json();
if (!registration.ok) throw new Error(`registration ${registration.status}: ${client.error ?? "error"}`);

const verifier = b64url(randomBytes(32));
const state = b64url(randomBytes(16));
const authorize = new URL(meta.authorization_endpoint);
authorize.search = new URLSearchParams({
  response_type: "code",
  client_id: client.client_id,
  redirect_uri: redirectUri,
  scope: SCOPE,
  state,
  code_challenge: b64url(createHash("sha256").update(verifier).digest()),
  code_challenge_method: "S256",
  resource: base,
}).toString();

const code = await new Promise((resolve, reject) => {
  server.on("request", (req, res) => {
    const url = new URL(req.url, redirectUri);
    if (url.pathname !== "/callback") {
      res.writeHead(404).end();
      return;
    }
    const ok = url.searchParams.get("state") === state && url.searchParams.get("code");
    res.writeHead(ok ? 200 : 400, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(ok ? "Signed in. You can close this tab." : "Sign-in failed.");
    server.close();
    ok ? resolve(url.searchParams.get("code")) : reject(new Error(url.searchParams.get("error") ?? "state mismatch"));
  });
  console.log(`Open to sign in: ${authorize}`);
  // rundll32 avoids cmd.exe, which would split the URL at "&".
  const opener = process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", authorize.toString()]]
    : process.platform === "darwin" ? ["open", [authorize.toString()]] : ["xdg-open", [authorize.toString()]];
  spawn(opener[0], opener[1], { stdio: "ignore", detached: true }).unref();
});

save(client, await tokenRequest({
  grant_type: "authorization_code",
  code,
  redirect_uri: redirectUri,
  client_id: client.client_id,
  code_verifier: verifier,
}));
