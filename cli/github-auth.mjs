// Portable GitHub exchange. Repository configuration never authorizes sending a
// host's GitHub credential: that decision belongs to the host's trust settings.
import { spawnSync } from "node:child_process";
import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

export const repositoryValid = (value) => typeof value === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value);
export const beadsTokenEnvValid = (value) => !value || /^BEADS_CLOUDFLARE_(?:[A-Z0-9_]+_)?TOKEN$/.test(value);
export const credentialFresh = (entry, now = Date.now()) => Boolean(typeof entry?.token === "string" && /^[!-~]+$/.test(entry.token) && (!entry.expires_at || Date.parse(entry.expires_at) > now + 60_000));
export const githubCredentialFresh = (entry, now = Date.now()) => typeof entry?.expires_at === "string" && credentialFresh(entry, now);
export const githubCredentialKey = (repository, tracker) => `${repository.toLowerCase()}#${tracker}`;

export function exchangeOrigin(base) {
  const url = new URL(base);
  if (url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname)) throw new Error("GitHub exchange needs a store origin without a path or credentials");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new Error("GitHub exchange requires HTTPS (HTTP is allowed only on loopback)");
  return url.origin;
}

export function readGithubCredentials(file) {
  try {
    if (!credentialFilePrivate(file)) throw new Error("unsafe-permissions");
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    if (error.message === "unsafe-permissions") throw new Error("GitHub trust file is readable by other users; restrict it to its owner");
    if (error.code === "ENOENT") return {};
    throw new Error("GitHub credential file is unreadable or invalid");
  }
}

export function credentialFilePrivate(file) {
  const info = statSync(file);
  if (process.platform !== "win32") return (info.mode & 0o077) === 0;
  const script = `$ErrorActionPreference='Stop'; $acl=Get-Acl -LiteralPath $env:BEADS_CREDENTIAL_CHECK_PATH; $owner=(New-Object System.Security.Principal.NTAccount($acl.Owner)).Translate([System.Security.Principal.SecurityIdentifier]).Value; $allowed=@($owner,'S-1-5-18','S-1-5-32-544'); foreach($rule in $acl.Access){ if($rule.AccessControlType -eq 'Allow' -and (([int64]$rule.FileSystemRights.value__ -band 0xF00D0007) -ne 0) -and $rule.PropagationFlags -ne 'InheritOnly'){ $sid=$rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value; if($sid -notin $allowed){ exit 1 } } }; exit 0`;
  const env = { ...process.env, BEADS_CREDENTIAL_CHECK_PATH: file };
  // PowerShell 7's inherited module path cannot load the inbox 5.1 security module.
  delete env.PSModulePath;
  const result = spawnSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-NonInteractive", "-Command", script], { env, timeout: 10_000, maxBuffer: 65536, windowsHide: true, shell: false, stdio: "ignore" });
  return !result.error && result.status === 0;
}

// The lock serializes short file updates only, never network calls. Atomic replacement
// preserves all other repository bindings even when agents refresh concurrently.
export async function updateCredentialFile(file, update) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const lock = `${file}.lock`;
  const candidate = `${lock}.${randomUUID()}`;
  const owner = JSON.stringify({ pid: process.pid, nonce: randomUUID() });
  // Linking a fully written contender publishes the PID atomically: a killed
  // process cannot leave an empty lock whose owner is impossible to determine.
  writeFileSync(candidate, owner, { mode: 0o600, flag: "wx" });
  let held = false;
  const deadline = Date.now() + 15_000;
  const staged = `${file}.${randomUUID()}.tmp`;
  try {
    while (!held) {
      try { linkSync(candidate, lock); held = true; }
      catch (error) {
        if (error.code !== "EEXIST" || Date.now() >= deadline) throw new Error("credential cache is busy or unwritable; no credential was changed");
        reapDeadCredentialLock(lock);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    const document = update(readGithubCredentials(file));
    if (document === undefined) { rmSync(file, { force: true }); return; }
    writeFileSync(staged, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    if (process.platform === "win32") {
      const result = spawnSync("icacls", [staged, "/inheritance:r", "/grant:r", `${process.env.USERNAME}:F`], { timeout: 10_000, windowsHide: true, shell: false, stdio: "ignore" });
      if (result.error || result.status !== 0 || !credentialFilePrivate(staged)) throw new Error("could not secure the credential cache for its owner");
    }
    renameSync(staged, file);
  } finally { rmSync(staged, { force: true }); if (held) rmSync(lock, { force: true }); rmSync(candidate, { force: true }); }
}

function reapDeadCredentialLock(lock) {
  let owner;
  try { owner = JSON.parse(readFileSync(lock, "utf8")); } catch { return; }
  if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || !/^[0-9a-f-]{36}$/.test(owner.nonce ?? "")) return;
  try { process.kill(owner.pid, 0); return; } catch (error) { if (error.code !== "ESRCH") return; }
  const claim = `${lock}.reap.${owner.nonce}`;
  let claimed = false;
  try {
    linkSync(lock, claim); claimed = true;
    const current = JSON.parse(readFileSync(lock, "utf8"));
    if (current.pid === owner.pid && current.nonce === owner.nonce) rmSync(lock);
  } catch { /* Another agent acquired or reclaimed it first. */ }
  finally { if (claimed) rmSync(claim, { force: true }); }
}

export function githubOidcUrl(input, audience) {
  const url = new URL(input);
  if (url.protocol !== "https:" || url.username || url.password || url.hash || !(url.hostname === "actions.githubusercontent.com" || url.hostname.endsWith(".actions.githubusercontent.com"))) throw new Error("GitHub OIDC request URL is not a trusted Actions endpoint");
  url.searchParams.set("audience", audience);
  return url.href;
}

async function boundedJson(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("empty response");
  const chunks = [];
  let size = 0;
  try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 65536) throw new Error("response too large"); chunks.push(part.value); } }
  finally { await reader.cancel().catch(() => {}); }
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder().decode(joined));
}

export function githubStoreTrusted(base, { env = process.env, credentials = {} } = {}) {
  const origin = exchangeOrigin(base);
  const listed = String(env.BEADS_CLOUDFLARE_TRUSTED_ORIGINS ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  return listed.some((value) => { try { return exchangeOrigin(value) === origin; } catch { return false; } }) || credentials[origin]?.github_trusted === true;
}

export function ambientBeadsStoreTrusted(base, options = {}) {
  const env = options.env ?? process.env;
  const origin = exchangeOrigin(base);
  const pairedBase = env.BEADS_CLOUDFLARE_BASE;
  let paired = false;
  try { paired = Boolean(pairedBase && exchangeOrigin(pairedBase) === origin); } catch { /* Invalid host pairing is not authority. */ }
  return paired || githubStoreTrusted(origin, options) || credentialFresh(options.credentials?.[origin]);
}

export async function resolveGithubCredential({ base, repository, tracker, env = process.env, credentials = {}, fetchImpl = fetch, spawnImpl = spawnSync, now = Date.now() }) {
  if (!repositoryValid(repository)) throw new Error("GitHub exchange needs github_repository in owner/repository form");
  const origin = exchangeOrigin(base);
  if (!githubStoreTrusted(origin, { env, credentials })) throw new Error(`GitHub exchange refused: ${origin} is not trusted by this host; set BEADS_CLOUDFLARE_TRUSTED_ORIGINS or run join with --trust-store`);
  const cached = credentials[origin]?.github?.[githubCredentialKey(repository, tracker)];
  if (githubCredentialFresh(cached, now)) return { ...cached, cached: true };
  let identity = env.GH_TOKEN || env.GITHUB_TOKEN;
  if (env.ACTIONS_ID_TOKEN_REQUEST_URL || env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) {
    if (!env.ACTIONS_ID_TOKEN_REQUEST_URL || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) throw new Error("GitHub Actions OIDC is incomplete; grant this job id-token: write");
    const oidcUrl = githubOidcUrl(env.ACTIONS_ID_TOKEN_REQUEST_URL, origin);
    try {
      const oidc = await fetchImpl(oidcUrl, { headers: { Authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` }, redirect: "error", signal: AbortSignal.timeout(10_000) });
      if (!oidc.ok) throw new Error("refused");
      identity = (await boundedJson(oidc)).value;
      if (typeof identity !== "string" || !/^[!-~]+$/.test(identity)) throw new Error("invalid");
    } catch { throw new Error("GitHub Actions OIDC identity request failed; grant id-token: write and verify runner identity"); }
  }
  if (!identity) {
    const result = spawnImpl("gh", ["auth", "token", "--hostname", "github.com"], { encoding: "utf8", env, timeout: 10_000, maxBuffer: 65_536, windowsHide: true, shell: false });
    if (!result.error && result.status === 0) identity = result.stdout?.trim();
  }
  if (!identity || !/^[!-~]+$/.test(identity)) throw new Error("No GitHub identity: sign in with gh auth login, or provide GH_TOKEN/GITHUB_TOKEN through the host's credential custody");
  let response;
  try {
    response = await fetchImpl(`${origin}/auth/github`, { method: "POST", headers: { Authorization: `Bearer ${identity}`, "Content-Type": "application/json" }, body: JSON.stringify({ repository, tracker }), redirect: "error", signal: AbortSignal.timeout(15_000) });
  } catch { throw new Error("GitHub credential exchange failed (network, timeout or redirect)"); }
  if (!response.ok) throw new Error(`GitHub credential exchange refused (HTTP ${response.status}); check repository access and the server's repository-to-tracker policy`);
  let entry;
  try { entry = await boundedJson(response); } catch { throw new Error("GitHub exchange returned an invalid response"); }
  if (typeof entry.token !== "string" || !/^[!-~]+$/.test(entry.token) || !githubCredentialFresh(entry, now)) throw new Error("GitHub exchange returned an invalid or expired credential");
  return { token: entry.token, expires_at: entry.expires_at };
}
