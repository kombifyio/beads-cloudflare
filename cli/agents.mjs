// Wires coding agents in a repository: an instruction block in CLAUDE.md / AGENTS.md and an MCP server entry
// (.mcp.json for Claude Code, .codex/config.toml for Codex). Every write is idempotent and keeps what the files already hold.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { agentInstructions, mcpCommand, parseAgents, upsertMarkedBlock, withClaudeMcp, withCodexMcp } from "./lib.mjs";

const NPX = "npx --yes beads-cloudflare";

function update(path, change, dryRun) {
  const before = existsSync(path) ? readFileSync(path, "utf8") : "";
  const after = change(before);
  if (after.problem) return { problem: after.problem };
  if (after.text === before) return { changed: false };
  if (!dryRun) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, after.text);
  }
  return { changed: true };
}

const markdown = (result) => (typeof result === "string" ? { text: result } : result);

/** The writes for one agent: [label, path, change]. */
function plan(agent, dir, base, version) {
  const entry = mcpCommand(version, base);
  const block = agentInstructions();
  if (agent === "claude") {
    return [
      ["instructions", join(dir, "CLAUDE.md"), (text) => markdown(upsertMarkedBlock(text, block))],
      ["MCP server", join(dir, ".mcp.json"), (text) => {
        const merged = withClaudeMcp(text, entry);
        return merged.problem ? merged : { text: `${JSON.stringify(merged.document, null, 2)}\n` };
      }],
    ];
  }
  return [
    ["instructions", join(dir, "AGENTS.md"), (text) => markdown(upsertMarkedBlock(text, block))],
    ["MCP server", join(dir, ".codex", "config.toml"), (text) => ({ text: withCodexMcp(text, entry) })],
  ];
}

/**
 * Writes the agent files. `choice` is the parsed --agents list; without it a terminal user is asked, and anyone else gets
 * the one command that does it later.
 */
export async function wireAgents(report, { dir, base, version, choice, ask, dryRun }) {
  let agents = choice;
  if (agents === undefined && ask) {
    const { createInterface } = await import("node:readline/promises");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = (await rl.question("Set up coding agents here to use this tracker? claude, codex, both or none [none]: ")).trim().toLowerCase();
      const parsed = parseAgents(answer === "both" ? "claude,codex" : answer || "none");
      if (parsed.problem) report.info(`note: ${parsed.problem}; no agent was set up (later: ${NPX} agents claude,codex)`);
      agents = parsed.problem ? [] : parsed.agents;
    } finally {
      rl.close();
    }
  }
  if (agents === undefined) {
    report.note(`Wire coding agents later (instructions and MCP server): ${NPX} agents claude,codex`);
    return;
  }
  if (!agents.length) return;
  for (const agent of agents) {
    for (const [label, path, change] of plan(agent, dir, base, version)) {
      const result = update(path, change, dryRun);
      if (result.problem) report.info(`note: ${agent} ${label}: ${result.problem}`);
      else if (dryRun && result.changed) report.would(`write the ${agent} ${label} into ${path}`);
      else report.ok(`${agent} ${label}`, result.changed ? `wrote ${path}` : `already in ${path}`);
    }
  }
  if (agents.includes("codex")) report.note("Codex reads .codex/config.toml in trusted projects only; trust this project in Codex, or copy the [mcp_servers.beads] table to ~/.codex/config.toml.");
}

/** `beads-cloudflare agents claude,codex`: the same wiring for a repository that already joined a store. */
export async function agentsCommand(flag, positional, { findRepoConfig, Report, version }) {
  const report = new Report(flag["dry-run"], `${NPX} agents ${positional[0] ?? "claude,codex"}`);
  const parsed = parseAgents(positional[0] ?? flag.agents ?? "claude,codex");
  if (parsed.problem) {
    report.fail("agents", parsed.problem, `${NPX} agents claude,codex`);
    return report.finish("agents");
  }
  const found = findRepoConfig(process.cwd());
  if (!found?.config?.base) {
    report.fail("repository", "no .beads/cloudflare.json in this directory or above", `join a store first: ${NPX} join <store url>`);
    return report.finish("agents");
  }
  report.heading(`Agents in ${found.dir}`);
  await wireAgents(report, { dir: found.dir, base: found.config.base.replace(/\/+$/, ""), version, choice: parsed.agents, ask: false, dryRun: flag["dry-run"] });
  return report.finish("agents", "beads-cloudflare: agents are set up. Restart them to load the MCP server.");
}
