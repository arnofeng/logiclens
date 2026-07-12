#!/usr/bin/env node
import { Command, Option } from "commander";
import { writeErrorLog } from "./shared/logger.js";
import { addRepoCommand } from "./interfaces/cli/addRepo.js";
import { addReposCommand } from "./interfaces/cli/addRepos.js";
import { askCommand } from "./interfaces/cli/ask.js";
import { contractsCommand } from "./interfaces/cli/contracts.js";
import { depsCommand, type DepsCommandOptions } from "./interfaces/cli/deps.js";
import { explainDepsCommand } from "./interfaces/cli/explainDeps.js";
import { impactCommand } from "./interfaces/cli/impact.js";
import { indexCommand } from "./interfaces/cli/index.js";
import { initCommand } from "./interfaces/cli/init.js";
import { uninitCommand } from "./interfaces/cli/uninit.js";
import { qualityCommand } from "./interfaces/cli/quality.js";
import { rebuildRelationsCommand } from "./interfaces/cli/rebuildRelations.js";
import { statsCommand } from "./interfaces/cli/stats.js";
import { traceCommand } from "./interfaces/cli/trace.js";
import { mcpCommand } from "./interfaces/cli/mcp.js";
import { frameworksCommand } from "./interfaces/cli/frameworks.js";
import { watchCommand } from "./interfaces/cli/watch.js";
import { installCommand } from "./interfaces/cli/install.js";
import { uninstallCommand } from "./interfaces/cli/uninstall.js";
import { pluginDoctorCommand, pluginInstallCommand, pluginListCommand, pluginRemoveCommand } from "./interfaces/cli/plugin.js";
import { appVersion } from "./shared/version.js";
import { BRAND } from "./shared/branding.js";

const program = new Command();
const configDisplayPath = `${BRAND.configDirName}/${BRAND.configFileName}`;

program.name(BRAND.cliName).description(`${BRAND.displayName} cross-repository semantic dependency graph CLI`).version(appVersion);

program.command("init").description(`Create ${BRAND.configDirName} config and graph directories`).action(() => initCommand());
program.command("uninit").description(`Remove ${BRAND.configDirName} config, graph, and semantic-index, and stop running MCP server`).action(() => uninitCommand());
program.command("add-repo").argument("<path>").option("--name <name>").description(`Add a repository to ${configDisplayPath}`).action((repoPath: string, options: { name?: string }) => addRepoCommand(repoPath, options));
program.command("add-repos").argument("<directory>").option("--index", "Index discovered repositories after adding them").option("--changed-only").option("--max-files <number>", "Maximum files to index per repository", (value) => Number(value)).option("--batch-size <number>", "Number of repositories to index per batch for large full imports", (value) => Number(value)).option("--write-mode <mode>", "Graph write mode: auto, merge, bulk, or bulk-upsert", "auto").description(`Add first-level Git repositories from a directory to ${configDisplayPath}`).action((directory: string, options: { index?: boolean; changedOnly?: boolean; maxFiles?: number; batchSize?: number; writeMode?: "auto" | "merge" | "bulk" | "bulk-upsert" }) => addReposCommand(directory, options));
program.command("index").option("--repo <name>").option("--changed-only").option("--max-files <number>", "Maximum files to index", (value) => Number(value)).option("--batch-size <number>", "Number of repositories to index per batch for large full imports", (value) => Number(value)).option("--write-mode <mode>", "Graph write mode: auto, merge, bulk, or bulk-upsert", "auto").description("Index configured repositories").action((options: { repo?: string; changedOnly?: boolean; maxFiles?: number; batchSize?: number; writeMode?: "auto" | "merge" | "bulk" | "bulk-upsert" }) => indexCommand(options));
program.command("stats").description("Print graph statistics").action(() => statsCommand());
program
  .command("deps")
  .option("--strength <strong|weak>", "Filter dependencies by strength: strong or weak")
  .option("--type <type>", "Filter dependencies by type: package, import, api, event, shared-contract")
  .option("--limit <number>", "Maximum dependencies to list", (value) => Number(value))
  .option("--repo <name>", "Filter dependencies involving a specific repository")
  .option("--target <name>", "Filter dependencies targeting a specific repository")
  .addOption(
    new Option("--direction <outgoing|incoming>", "Direction: outgoing (repo as consumer) or incoming (repo as producer)")
      .choices(["outgoing", "incoming"])
  )
  .description("List structured cross-repo dependencies")
  .action((options: DepsCommandOptions) => depsCommand(options));
program
  .command("explain-deps")
  .argument("<sourceRepo>")
  .argument("<targetRepo>")
  .option("--kind <kind>", "Filter by SEMANTIC_REL kind")
  .description("Explain semantic relations between two repos")
  .action((sourceRepo: string, targetRepo: string, options: { kind?: string }) =>
    explainDepsCommand(sourceRepo, targetRepo, options)
  );
program.command("contracts").option("--kind <kind>", "Filter by contract kind: package, api, event, dto, schema, enum, or config").option("--limit <number>", "Maximum contracts to list", (value) => Number(value)).option("--repo <name>", "Filter contracts involving a specific repository").addOption(new Option("--direction <outgoing|incoming>", "Direction: outgoing (repo as producer) or incoming (repo as consumer)").choices(["outgoing", "incoming"])).description("List contracts and producer/consumer counts").action((options: { kind?: string; limit?: number; repo?: string; direction?: string }) => contractsCommand(options));
program
  .command("trace")
  .argument("<target>", "Contract identifier, e.g. \"http POST /orders\", \"event OrderCreated\", \"schema CreateOrderRequest\"")
  .argument("[rest...]", "Extra tokens joined onto target, so `trace http \"POST /orders\"` also works")
  .option("--max-hops <number>", "Max hops per direction (default 3)", (value) => Number(value))
  .option("--direction <direction>", "Trace direction: outgoing, incoming, or both (default)")
  .option("--json", "Output the structured trace graph as JSON")
  .description("Multi-hop semantic trace of a contract spec across repos")
  .action((target: string, rest: string[], options: { maxHops?: number; direction?: string; json?: boolean }) =>
    traceCommand(target, rest, { maxHops: options.maxHops, direction: options.direction as any, json: options.json })
  );
program.command("ask").argument("<question>").description("Answer a natural-language question from the graph").action((question: string) => askCommand(question));
program.command("impact")
  .argument("<symbolOrEntity>")
  .option("--change <change>", "Proposed change, e.g. \"field-removed:couponCode\"")
  .option("--max-hops <number>", "Max semantic impact hops (default 3)", (value) => Number(value))
  .option("--legacy", "Show legacy symbol/call graph impact context")
  .option("--verbose", "Show verbose output, including legacy context when semantic impact matches")
  .description("Run impact analysis for a symbol, entity, or contract change")
  .action((symbolOrEntity: string, options: { change?: string; maxHops?: number; legacy?: boolean; verbose?: boolean }) =>
    impactCommand(symbolOrEntity, {
      change: options.change,
      maxHops: options.maxHops,
      legacy: options.legacy,
      verbose: options.verbose
    })
  );
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
program.command("frameworks").description("List detected frameworks and enabled contract extractors for each repository").action(() => frameworksCommand());
const plugin = program.command("plugin").description(`Install, inspect, diagnose, and remove ${BRAND.displayName} plugins`);
plugin.command("install")
  .argument("<source>", "npm package specifier, local directory, or .tgz archive")
  .option("--global", "Install for the current user")
  .option("--force", "Replace an existing plugin with the same name")
  .description("Install and validate a plugin")
  .action((source: string, options: { global?: boolean; force?: boolean }) => pluginInstallCommand(source, options));
plugin.command("list")
  .option("--global", "List user-level plugins")
  .option("--all", "List workspace and user-level plugins")
  .option("--json", "Output JSON")
  .description("List installed plugins")
  .action(async (options: { global?: boolean; all?: boolean; json?: boolean }) => { await pluginListCommand(options); });
plugin.command("doctor")
  .option("--global", "Diagnose user-level plugins")
  .option("--all", "Diagnose workspace and user-level plugins")
  .option("--json", "Output JSON")
  .description("Validate installed plugins and report errors")
  .action(async (options: { global?: boolean; all?: boolean; json?: boolean }) => { await pluginDoctorCommand(options); });
plugin.command("remove")
  .argument("<name>", "Plugin manifest name")
  .option("--global", "Remove from the user-level plugin directory")
  .option("--yes", "Skip the confirmation prompt")
  .description("Remove an installed plugin")
  .action((name: string, options: { global?: boolean; yes?: boolean }) => pluginRemoveCommand(name, options));
program
  .command("mcp")
  .option("-p, --path <path>", "Workspace root path")
  .description("Start the Model Context Protocol (MCP) server over stdio")
  .action((options: { path?: string }) => mcpCommand(options.path));
program.command("watch").option("--debounce-ms <number>", "Debounce time in milliseconds for file events", (value) => Number(value)).option("--repo <name>", "Limit watching to a specific repository").description(`Start the ${BRAND.displayName} file watcher to automatically index repository changes`).action((options: { debounceMs?: number; repo?: string }) => watchCommand(options));
program
  .command("install")
  .description(`Install ${BRAND.cliName} MCP server into one or more agents (Claude Code, Cursor, Codex CLI, opencode, Hermes Agent, Gemini CLI, Antigravity IDE)`)
  .option("-t, --target <ids>", 'Target agent(s): comma-separated ids, or "auto"|"all"|"none". Default: prompt')
  .option("-l, --location <where>", 'Install location: "global" or "local". Default: prompt')
  .option("-y, --yes", "Non-interactive: defaults to --location=global --target=auto, auto-allow on")
  .option("--no-permissions", "Skip writing the auto-allow permissions list (Claude Code only)")
  .option("--print-config <id>", "Print MCP config snippet for the named agent and exit (no file writes)")
  .action((options: any) => installCommand(options));
program
  .command("uninstall")
  .description(`Remove ${BRAND.cliName} from your agents (Claude Code, Cursor, Codex CLI, opencode, Hermes Agent, Gemini CLI, Antigravity IDE)`)
  .option("-t, --target <ids>", 'Target agent(s): comma-separated ids, or "all". Default: all')
  .option("-l, --location <where>", 'Uninstall location: "global" or "local". Default: prompt')
  .option("-y, --yes", "Non-interactive: defaults to --location=global --target=all")
  .action((options: any) => uninstallCommand(options));

async function main(): Promise<void> {
  await program.parseAsync();
}

main().catch(async (error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  await writeErrorLog("cli-uncaught", error);
  process.exitCode = 1;
});
