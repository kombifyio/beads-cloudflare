#!/usr/bin/env node
// beads-cloudflare: a shared Beads tracker in a Cloudflare Worker you own. This CLI creates the store, joins
// repositories to it, mints keys for teammates and moves existing Beads workspaces in.
//
//   npx beads-cloudflare init        (or: npm create beads-cloudflare)
//   npx beads-cloudflare join <store url>
//   npx beads-cloudflare dev         (a local store, no Cloudflare account)
//
// The package has no runtime dependencies. The deploy tooling (cf and Wrangler, pinned in package.json) is installed
// into the user cache the first time `setup` or `dev` needs it, so joining a store installs in seconds.
import { parseArgs } from "node:util";
import { redact } from "./output.mjs";
import { nodeProblem } from "./lib.mjs";

const HELP = `beads-cloudflare: a shared Beads tracker in a Cloudflare Worker you own.

Usage: npx beads-cloudflare <command> [options]

Start
  init, setup           Create the store in your Cloudflare account (signs in when needed), create the
                        first agent key, then join the current directory. Safe to run again: it updates.
  join <store url>      Use an existing store from the current directory: install bd, store the key,
                        write .beads/, check the setup. Asks for the key, or --token-file <file>.
  migrate <store url>   Move an existing Beads workspace here into the store: export, back up .beads,
                        join, import, compare counts.
  dev                   Run a store on this machine (wrangler dev --local, no account) and join a demo.

Team
  invite                Create a key for a teammate and print the command they run.
  keys create <label>   Create an agent key (printed once). --read-only, --import, --trackers a,b, --days n
  keys list | keys revoke <id>
  agents claude,codex   Add instructions (CLAUDE.md / AGENTS.md) and the MCP server for coding agents.

Machines
  bootstrap             A fresh clone of a joined repository: credential, matching bd, readiness check.
  doctor                Read-only check of bd, the credential and the tracker. --scratch adds a write test.
  credentials           Resolve the credential without changing anything; --json for a capturing process.
  mcp                   Stdio MCP server for agents, using the credential bd uses (--store <url>).
  cf <args>             Run the tested Cloudflare CLI, e.g. "cf auth login".
  uninstall             Remove bd and, with --store <url> or --all, the stored keys. Never touches the store.

Options
  --dry-run              Print what would be done and change nothing.
  --tracker <id>         Tracker for this repository (default: the directory name; migrate: the old id prefix).
  --token-file <file>    join/bootstrap: read the agent key from a file (- for standard input).
  --agents <list>        join/setup: claude, codex, both as "claude,codex", or none.
  --add-to-path          join/setup: add the bd directory to your shell profile when it is not on PATH.
  --store <url>          The store, where no .beads/cloudflare.json names it (doctor, keys, invite, mcp, uninstall).
  --github-repository <owner/repo>  Repository identity for the optional GitHub exchange.
  --trust-store          Trust this store on this host for the GitHub exchange and ambient keys.
  --scratch              doctor/join: also run a write round trip in a scratch tracker.
  --name <worker>        setup: Worker name (default beads-cloudflare).
  --origin <url>         setup: a custom domain you route to the Worker.
  --no-join              setup: only deploy the store.
  --admin-email <list>   setup: people allowed to manage keys through sign-in (optional).
  --github-policy <file> setup: JSON repository-to-tracker policy for the GitHub exchange.
  --access-issuer <url> --access-client-id <id> --access-client-secret <secret>
                         setup: turn on browser sign-in through Cloudflare Access (optional).
  --no-sign-in           setup: turn browser sign-in off again.
  --from <file.jsonl>    migrate: import this export instead of exporting .beads here.
  --upstream-bd <path>   migrate: the bd that reads the existing workspace (default: the first non-beads-cloudflare bd on PATH).
  --replace-existing-workspace
                         join: move an existing .beads aside (to .beads.backup-<time>) and start empty.
  --tracker/--trackers/--days/--label/--read-only/--import/--all-trackers   keys and invite.
  --port <n> --dir <dir> dev: local port (8788) and demo directory.
  --all                  uninstall: remove the keys of every store.
  --bin-dir <dir>        Where bd is installed (default ~/.local/bin, %LOCALAPPDATA%\\Programs\\beads-cloudflare\\bin).
  --bd-from <path> --release-base <url> --bd-path <path>   Development: a local bd build or release mirror.
  -h, --help, --version

Environment: BEADS_CLOUDFLARE_TOKEN with BEADS_CLOUDFLARE_BASE (containers and CI), BEADS_ADMIN_TOKEN (keys,
invite), BEADS_CLOUDFLARE_CF (another cf than the tested one), CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.
`;

const options = {
  "dry-run": { type: "boolean", default: false },
  tracker: { type: "string" },
  trackers: { type: "string" },
  token: { type: "string" },
  "token-file": { type: "string" },
  agents: { type: "string" },
  "add-to-path": { type: "boolean", default: false },
  "github-repository": { type: "string" },
  "trust-store": { type: "boolean", default: false },
  base: { type: "string" },
  json: { type: "boolean", default: false },
  scratch: { type: "boolean", default: false },
  name: { type: "string" },
  origin: { type: "string" },
  "no-join": { type: "boolean", default: false },
  "no-sign-in": { type: "boolean", default: false },
  all: { type: "boolean", default: false },
  "replace-existing-workspace": { type: "boolean", default: false },
  "admin-email": { type: "string" },
  "github-policy": { type: "string" },
  "access-issuer": { type: "string", default: process.env.ACCESS_ISSUER },
  "access-client-id": { type: "string", default: process.env.ACCESS_CLIENT_ID },
  "access-client-secret": { type: "string", default: process.env.ACCESS_CLIENT_SECRET },
  "bin-dir": { type: "string", default: process.env.BEADS_CLOUDFLARE_BIN_DIR },
  store: { type: "string" },
  from: { type: "string" },
  "upstream-bd": { type: "string" },
  label: { type: "string" },
  days: { type: "string" },
  "read-only": { type: "boolean", default: false },
  import: { type: "boolean", default: false },
  "all-trackers": { type: "boolean", default: false },
  port: { type: "string" },
  dir: { type: "string" },
  "bd-from": { type: "string" },
  "release-base": { type: "string" },
  "bd-path": { type: "string" },
  help: { type: "boolean", short: "h", default: false },
  version: { type: "boolean", default: false },
};

// The Node rule comes first and stands alone, so an old Node gets one clear line instead of a syntax error later.
const nodeIssue = nodeProblem(process.versions.node);
if (nodeIssue) {
  console.error(`beads-cloudflare: ${nodeIssue}. Install a current Node LTS from https://nodejs.org and run the command again.`);
  process.exit(1);
}

// `cf` passes its own arguments through untouched, so they are never parsed as options of this tool.
if (process.argv[2] === "cf") {
  const { cfCommandPassThrough } = await import("./commands.mjs");
  process.exit(await cfCommandPassThrough({}, process.argv.slice(3)));
}

let parsed;
try {
  parsed = parseArgs({ options, allowPositionals: true });
} catch (error) {
  console.error(`beads-cloudflare: ${redact(error.message)}\n\nRun with --help for the options.`);
  process.exit(2);
}
const { values: flag, positionals } = parsed;
const [command, ...rest] = positionals;

const commands = await import("./commands.mjs");
if (flag.version) {
  console.log(commands.CLI_VERSION);
  process.exit(0);
}
if (flag.help || !command) {
  console.log(HELP);
  process.exit(command || flag.help ? 0 : 2);
}

const table = {
  init: commands.setupCommand,
  setup: commands.setupCommand,
  join: commands.joinCommand,
  bootstrap: commands.bootstrapCommand,
  credentials: commands.credentialsCommand,
  doctor: commands.doctorCommand,
  uninstall: commands.uninstallCommand,
  mcp: commands.mcpCommand,
  migrate: async (f, args) => (await import("./migrate.mjs")).migrateCommand(f, args),
  dev: async (f, args) => (await import("./dev.mjs")).devCommand(f, args),
  keys: async (f, args) => (await import("./keys.mjs")).keysCommand(f, args),
  invite: async (f, args) => (await import("./keys.mjs")).inviteCommand(f, args),
  agents: async (f, args) => (await import("./agents.mjs")).agentsCommand(f, args, { findRepoConfig: commands.findRepoConfig, Report: commands.Report, version: commands.CLI_VERSION }),
};
if (!table[command]) {
  console.error(`beads-cloudflare: unknown command "${redact(command)}". Run with --help for the commands.`);
  process.exit(2);
}

try {
  process.exitCode = await table[command](flag, rest);
} catch (error) {
  // mcp speaks JSON-RPC on standard output; its diagnostics go to standard error like everyone's errors here.
  const out = command === "mcp" ? console.error : console.log;
  if (error instanceof commands.Diagnosed) {
    out(`  ${"FAILED".padEnd(7)} ${redact(`${error.label}: ${error.message}`)}`);
    for (const line of [error.fix].flat().filter(Boolean)) out(`          ${redact(`fix: ${line}`)}`);
    out(`\nbeads-cloudflare: FAILED (1 problem in ${command}). Apply the fix line above, then run the command again.`);
  } else {
    console.error(`\nbeads-cloudflare: FAILED unexpectedly: ${redact(error?.stack ?? error)}`);
    console.error(`This is a defect. Please report it with the output above: https://github.com/kombifyio/beads-cloudflare/issues`);
  }
  process.exitCode = 1;
}
