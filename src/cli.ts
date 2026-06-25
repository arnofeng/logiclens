#!/usr/bin/env node
import fs from "node:fs/promises";
import { Command } from "commander";
import { configPath } from "./config/loadConfig.js";
import { writeErrorLog } from "./utils/logger.js";
import { addRepoCommand } from "./commands/addRepo.js";
import { addReposCommand } from "./commands/addRepos.js";
import { askCommand } from "./commands/ask.js";
import { contractsCommand } from "./commands/contracts.js";
import { depsCommand } from "./commands/deps.js";
import { impactCommand } from "./commands/impact.js";
import { indexCommand } from "./commands/index.js";
import { initCommand } from "./commands/init.js";
import { uninitCommand } from "./commands/uninit.js";
import { queryCommand } from "./commands/query.js";
import { qualityCommand } from "./commands/quality.js";
import { rebuildRelationsCommand } from "./commands/rebuildRelations.js";
import { statsCommand } from "./commands/stats.js";
import { traceCommand } from "./commands/trace.js";
import { pluginsCommand } from "./commands/plugins.js";
import { pluginAddCommand, pluginRemoveCommand, type PluginAddOptions } from "./commands/plugin.js";
import { mcpCommand } from "./commands/mcp.js";
import { frameworksCommand } from "./commands/frameworks.js";
import { watchCommand } from "./commands/watch.js";
import { installCommand } from "./commands/install.js";
import { uninstallCommand } from "./commands/uninstall.js";
import { loadConfiguredPlugins } from "./plugins/loader.js";
import { logicLensVersion } from "./version.js";

const program = new Command();

program.name("logiclens").description("LogicLens cross-repository semantic dependency graph CLI").version(logicLensVersion);

program.command("init").description("Create .logiclens config, graph, and cache directories").action(() => initCommand());
program.command("uninit").description("Remove .logiclens config, graph, cache, and semantic-index, and stop running MCP server").action(() => uninitCommand());
program.command("add-repo").argument("<path>").option("--name <name>").description("Add a repository to .logiclens/config.yaml").action((repoPath: string, options: { name?: string }) => addRepoCommand(repoPath, options));
program.command("add-repos").argument("<directory>").option("--index", "Index discovered repositories after adding them").option("--changed-only").option("--max-files <number>", "Maximum files to index per repository", (value) => Number(value)).option("--batch-size <number>", "Number of repositories to index per batch for large full imports", (value) => Number(value)).option("--write-mode <mode>", "Graph write mode: auto, merge, bulk, or bulk-upsert", "auto").description("Add first-level Git repositories from a directory to .logiclens/config.yaml").action((directory: string, options: { index?: boolean; changedOnly?: boolean; maxFiles?: number; batchSize?: number; writeMode?: "auto" | "merge" | "bulk" | "bulk-upsert" }) => addReposCommand(directory, options));
program.command("index").option("--repo <name>").option("--changed-only").option("--max-files <number>", "Maximum files to index", (value) => Number(value)).option("--batch-size <number>", "Number of repositories to index per batch for large full imports", (value) => Number(value)).option("--write-mode <mode>", "Graph write mode: auto, merge, bulk, or bulk-upsert", "auto").description("Index configured repositories").action((options: { repo?: string; changedOnly?: boolean; maxFiles?: number; batchSize?: number; writeMode?: "auto" | "merge" | "bulk" | "bulk-upsert" }) => indexCommand(options));
program.command("stats").description("Print graph statistics").action(() => statsCommand());
program
  .command("deps")
  .option("--strength <strong|weak>", "Filter dependencies by strength: strong or weak")
  .option("--type <type>", "Filter dependencies by type: package, import, api, event, shared-contract")
  .option("--limit <number>", "Maximum dependencies to list", (value) => Number(value))
  .description("List structured cross-repo dependencies")
  .action((options: { strength?: "strong" | "weak"; type?: string; limit?: number }) => depsCommand(options));
program.command("contracts").option("--kind <kind>", "Filter by contract kind: package, api, event, dto, schema, enum, or config").option("--limit <number>", "Maximum contracts to list", (value) => Number(value)).description("List contracts and producer/consumer counts").action((options: { kind?: string; limit?: number }) => contractsCommand(options));
program.command("trace").argument("<contractOrEntity>").description("Trace contract kind:value or entity name").action((target: string) => traceCommand(target));
program.command("query").argument("<cypher>").description("Run a raw Kuzu Cypher query").action((cypher: string) => queryCommand(cypher));
program.command("ask").argument("<question>").description("Answer a natural-language question from the graph").action((question: string) => askCommand(question));
program.command("impact").argument("<symbolOrEntity>").description("Run impact analysis for a symbol or entity").action((symbolOrEntity: string) => impactCommand(symbolOrEntity));
program
  .command("quality")
  .argument("[action]", "Action to perform: 'contracts' to audit contract quality, or empty to audit relation quality")
  .option("--min-confidence <number>", "Minimum accepted confidence", (value) => Number(value))
  .option("--limit <number>", "Maximum audit rows", (value) => Number(value))
  .option("--reject-evidence <id>")
  .option("--reason <text>")
  .option("--alias <alias>")
  .option("--target-repo <name>")
  .description("Audit and govern relation quality / contract quality")
  .action((action: string | undefined, options: { minConfidence?: number; limit?: number; rejectEvidence?: string; reason?: string; alias?: string; targetRepo?: string }) => qualityCommand(action, options));
program.command("rebuild-relations").option("--repo <name>").option("--full").description("Rebuild repo-to-repo dependency edges from indexed contract evidence").action((options: { repo?: string; full?: boolean }) => rebuildRelationsCommand(options));
const plugin = program.command("plugin").description("Manage LogicLens plugins");
plugin
  .command("add")
  .argument("<name>", "Plugin to add: an npm package (optionally @version) or a local path")
  .option("--options <json>", "JSON options object stored with the plugin entry")
  .option("--no-install", "Only write config; skip installing the package")
  .option("--skip-verify", "Skip importing and validating the plugin after install")
  .description("Install a plugin package and register it in .logiclens/config.yaml")
  .action((name: string, options: PluginAddOptions) => pluginAddCommand(name, options));
plugin
  .command("remove")
  .alias("rm")
  .argument("<name>", "Plugin name to remove (as stored in config)")
  .description("Remove a plugin entry from .logiclens/config.yaml")
  .action((name: string) => pluginRemoveCommand(name));
plugin
  .command("list")
  .description("List configured LogicLens plugins and registered extension hooks")
  .action(() => pluginsCommand());
program.command("frameworks").description("List detected frameworks and enabled contract extractors for each repository").action(() => frameworksCommand());
program
  .command("mcp")
  .option("-p, --path <path>", "Workspace root path")
  .description("Start the Model Context Protocol (MCP) server over stdio")
  .action((options: { path?: string }) => mcpCommand(options.path));
program.command("watch").option("--debounce-ms <number>", "Debounce time in milliseconds for file events", (value) => Number(value)).option("--repo <name>", "Limit watching to a specific repository").description("Start the LogicLens file watcher to automatically index repository changes").action((options: { debounceMs?: number; repo?: string }) => watchCommand(options));
program
  .command("install")
  .description("Install logiclens MCP server into one or more agents (Claude Code, Cursor, Codex CLI, opencode, Hermes Agent, Gemini CLI, Antigravity IDE)")
  .option("-t, --target <ids>", 'Target agent(s): comma-separated ids, or "auto"|"all"|"none". Default: prompt')
  .option("-l, --location <where>", 'Install location: "global" or "local". Default: prompt')
  .option("-y, --yes", "Non-interactive: defaults to --location=global --target=auto, auto-allow on")
  .option("--no-permissions", "Skip writing the auto-allow permissions list (Claude Code only)")
  .option("--print-config <id>", "Print MCP config snippet for the named agent and exit (no file writes)")
  .action((options: any) => installCommand(options));
program
  .command("uninstall")
  .description("Remove logiclens from your agents (Claude Code, Cursor, Codex CLI, opencode, Hermes Agent, Gemini CLI, Antigravity IDE)")
  .option("-t, --target <ids>", 'Target agent(s): comma-separated ids, or "all". Default: all')
  .option("-l, --location <where>", 'Uninstall location: "global" or "local". Default: prompt')
  .option("-y, --yes", "Non-interactive: defaults to --location=global --target=all")
  .action((options: any) => uninstallCommand(options));

async function main(): Promise<void> {
  try {
    await fs.access(configPath());
    await loadConfiguredPlugins({ program });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await program.parseAsync();
}

main().catch(async (error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  await writeErrorLog("cli-uncaught", error);
  process.exitCode = 1;
});
