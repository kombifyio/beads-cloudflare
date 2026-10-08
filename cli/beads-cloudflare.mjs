#!/usr/bin/env node
// beads-cloudflare: set up the Cloudflare store for Beads and join it from a repository.
//
//   npx --yes github:kombifyio/beads-cloudflare setup
//   npx --yes github:kombifyio/beads-cloudflare join <store url>
//   npx --yes github:kombifyio/beads-cloudflare doctor
//   npx --yes github:kombifyio/beads-cloudflare uninstall
//
// Plain Node 22+ with no dependencies of its own. Everything in the Cloudflare account goes through the Cloudflare CLI
// (`cf`, installed and signed in; setup checks it first); `cf deploy` runs the project's pinned Wrangler internally.
import { parseArgs } from "node:util";
import { CLI_VERSION, bootstrapCommand, credentialsCommand, doctorCommand, joinCommand, setupCommand, uninstallCommand } from "./commands.mjs";

const HELP = `beads-cloudflare ${CLI_VERSION}

Usage: npx --yes github:kombifyio/beads-cloudflare <command> [options]

Commands
  setup               Deploy the store into your Cloudflare account, create the first agent key,
                      then do everything "join" does for the current directory.
  join <store url>    Use an existing store from the current directory: install bd, store the key,
                      write .beads/, run the self-test.
  bootstrap           Provision an existing clone's credentials and matching bd; preserve repository files.
  credentials         Resolve credentials only, including for a Dolt workspace; --json is for custody callers.
  doctor              Read-only tracker context, credential and binary readiness. --scratch opts into writes.
  uninstall           Remove the bd binary and the stored credentials from this machine. The store
                      and its data are never touched.

Every command is safe to run twice and supports --dry-run (print what would be done).

Options
  --dry-run              Print what would be done and change nothing.
  --tracker <id>         Tracker for this repository (default: derived from the directory name).
  --token <key>          Agent key for "join" (or BEADS_CLOUDFLARE_TOKEN, or BEADS_ADMIN_TOKEN to ask the store).
  --github-repository <owner/repo>  Commit repository identity for automatic GitHub exchange.
  --trust-store          Explicitly trust this origin on this host for GitHub credential exchange.
  --base <url> --json    credentials: explicit store; output the secret response only for a capturing caller.
  --scratch              doctor/join: explicitly exercise a scratch write round trip (requires scratch scope).
  --name <worker>        setup: Worker name (default beads-cloudflare).
  --origin <url>         setup: a custom domain you route to the Worker.
  --no-join              setup: only deploy the store.
  --allow-outdated-cf    setup: continue with an older cf than the newest release (offline use; by default an old cf is a failure).
  --admin-email <list>   setup: people allowed to manage keys through sign-in (optional).
  --access-issuer <url> --access-client-id <id> --access-client-secret <secret>
                         setup: turn on human sign-in through Cloudflare Access (optional).
  --bin-dir <dir>        Where bd is installed (default ~/.local/bin, %LOCALAPPDATA%\\Programs\\beads-cloudflare\\bin).
  --store <url>          doctor: the store to check when no repository is configured; uninstall: the store whose credentials to remove.
  --all                  uninstall: remove the credentials of every store (without --store or --all they are left).
  --no-sign-in           setup: deploy without human sign-in (an omitted --admin-email/--access-issuer keeps the last deployment's value).
  --replace-existing-workspace
                         join: this directory is already a Beads workspace; move .beads to .beads.backup-<time> and start fresh.
  --bd-from <path>       Development: install this bd binary instead of downloading the release.
  --release-base <url>   Development: download releases from here instead of GitHub.
  --bd-path <path>       doctor: test this bd instead of the one on PATH.
  -h, --help, --version
`;

const options = {
  "dry-run": { type: "boolean", default: false },
  tracker: { type: "string" },
  token: { type: "string" },
  "github-repository": { type: "string" },
  "trust-store": { type: "boolean", default: false },
  base: { type: "string" },
  json: { type: "boolean", default: false },
  scratch: { type: "boolean", default: false },
  name: { type: "string" },
  origin: { type: "string" },
  "no-join": { type: "boolean", default: false },
  "no-sign-in": { type: "boolean", default: false },
  "allow-outdated-cf": { type: "boolean", default: false },
  all: { type: "boolean", default: false },
  "replace-existing-workspace": { type: "boolean", default: false },
  "admin-email": { type: "string" },
  "access-issuer": { type: "string", default: process.env.ACCESS_ISSUER },
  "access-client-id": { type: "string", default: process.env.ACCESS_CLIENT_ID },
  "access-client-secret": { type: "string", default: process.env.ACCESS_CLIENT_SECRET },
  "bin-dir": { type: "string" },
  store: { type: "string" },
  "bd-from": { type: "string" },
  "release-base": { type: "string" },
  "bd-path": { type: "string" },
  help: { type: "boolean", short: "h", default: false },
  version: { type: "boolean", default: false },
};

let parsed;
try {
  parsed = parseArgs({ options, allowPositionals: true });
} catch (error) {
  console.error(`beads-cloudflare: ${error.message}\n\n${HELP}`);
  process.exit(2);
}
const { values: flag, positionals } = parsed;
const [command, ...rest] = positionals;

if (flag.version) {
  console.log(CLI_VERSION);
  process.exit(0);
}
if (flag.help || !command) {
  console.log(HELP);
  process.exit(command || flag.help ? 0 : 2);
}

const commands = { setup: setupCommand, join: joinCommand, bootstrap: bootstrapCommand, credentials: credentialsCommand, doctor: doctorCommand, uninstall: uninstallCommand };
if (!commands[command]) {
  console.error(`beads-cloudflare: unknown command "${command}"\n\n${HELP}`);
  process.exit(2);
}

try {
  process.exitCode = await commands[command](flag, rest);
} catch (error) {
  console.error(`\nbeads-cloudflare: FAILED unexpectedly: ${error?.stack ?? error}`);
  console.error(`Please report this with the output above: https://github.com/kombifyio/beads-cloudflare/issues`);
  process.exitCode = 1;
}
