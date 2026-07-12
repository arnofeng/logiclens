import { createInterface } from "node:readline/promises";
import fs from "node:fs/promises";
import { stdin, stdout } from "node:process";
import path from "node:path";
import { loadConfig } from "../../config/loadConfig.js";
import { BRAND, configFileCandidates } from "../../shared/branding.js";
import {
  globalPluginScope,
  inspectInstalledPlugins,
  installPlugin,
  projectPluginScopes,
  removePlugin,
  resolveProjectPluginScope,
  type InstalledPluginRecord,
  type PluginScope
} from "../../core/plugins/management.js";

export type PluginScopeOptions = { repo?: string; global?: boolean; all?: boolean };

export async function pluginInstallCommand(
  source: string,
  options: PluginScopeOptions & { force?: boolean },
  cwd = process.cwd()
): Promise<void> {
  assertScopeOptions(options, false);
  const scope = await singleScope(options, cwd);
  console.warn("Plugin packages may run npm lifecycle scripts. Install only sources you trust.");
  const record = await installPlugin(source, scope, { cwd, force: options.force });
  console.log(`Installed ${record.name}@${record.version}`);
  console.log(`Scope: ${scopeLabel(record)}`);
  console.log(`Path: ${record.path}`);
  console.log(`Restart ${BRAND.cliName} watch or MCP, then run ${BRAND.cliName} index to activate the plugin.`);
}

export async function pluginListCommand(
  options: PluginScopeOptions & { json?: boolean },
  cwd = process.cwd()
): Promise<InstalledPluginRecord[]> {
  const records = await inspectInstalledPlugins(await selectedScopes(options, cwd));
  printRecords(records, options.json ?? false, false);
  return records;
}

export async function pluginDoctorCommand(
  options: PluginScopeOptions & { json?: boolean },
  cwd = process.cwd()
): Promise<InstalledPluginRecord[]> {
  const records = await inspectInstalledPlugins(await selectedScopes(options, cwd), { loadEntry: true });
  printRecords(records, options.json ?? false, true);
  if (records.some((record) => record.status === "invalid")) process.exitCode = 1;
  return records;
}

export async function pluginRemoveCommand(
  name: string,
  options: PluginScopeOptions & { yes?: boolean },
  cwd = process.cwd()
): Promise<void> {
  assertScopeOptions(options, false);
  const scope = await singleScope(options, cwd);
  if (!options.yes) {
    if (!stdin.isTTY) throw new Error("Refusing to remove a plugin non-interactively without --yes.");
    const prompt = createInterface({ input: stdin, output: stdout });
    try {
      const answer = await prompt.question(`Remove plugin "${name}" from ${scope.kind} scope? [y/N] `);
      if (!/^y(?:es)?$/i.test(answer.trim())) { console.log("Removal cancelled."); return; }
    } finally { prompt.close(); }
  }
  const removedPath = await removePlugin(name, scope);
  console.log(`Removed ${name} from ${removedPath}`);
  console.log(`Restart ${BRAND.cliName} watch or MCP, then re-index the affected repositories.`);
}

async function singleScope(options: PluginScopeOptions, cwd: string): Promise<PluginScope> {
  if (options.global) return globalPluginScope();
  const workspaceRoot = await findPluginWorkspaceRoot(cwd);
  return resolveProjectPluginScope(await loadConfig(workspaceRoot), workspaceRoot, options.repo, cwd);
}

async function selectedScopes(options: PluginScopeOptions, cwd: string): Promise<PluginScope[]> {
  assertScopeOptions(options, true);
  if (options.global) return [globalPluginScope()];
  const workspaceRoot = await findPluginWorkspaceRoot(cwd);
  const config = await loadConfig(workspaceRoot);
  if (options.all) return [...projectPluginScopes(config, workspaceRoot), globalPluginScope()];
  return [resolveProjectPluginScope(config, workspaceRoot, options.repo, cwd)];
}

async function findPluginWorkspaceRoot(cwd: string): Promise<string> {
  let candidate = path.resolve(cwd);
  while (true) {
    for (const file of configFileCandidates(candidate)) {
      if (await fs.stat(file).then((stat) => stat.isFile()).catch(() => false)) return candidate;
    }
    const parent = path.dirname(candidate);
    if (parent === candidate) throw new Error(`No ${BRAND.displayName} workspace found from ${cwd}. Use --global or run ${BRAND.cliName} init first.`);
    candidate = parent;
  }
}

function assertScopeOptions(options: PluginScopeOptions, allowAll: boolean): void {
  if (options.global && options.repo) throw new Error("--global and --repo cannot be used together.");
  if (options.all && !allowAll) throw new Error("--all is not supported by this command.");
  if (options.all && (options.global || options.repo)) throw new Error("--all cannot be combined with --global or --repo.");
}

function printRecords(records: InstalledPluginRecord[], json: boolean, diagnostics: boolean): void {
  if (json) { console.log(JSON.stringify(records, null, 2)); return; }
  if (records.length === 0) { console.log("No plugins installed in the selected scope."); return; }
  const rows = records.map((record) => ({
    name: record.name,
    version: record.version,
    scope: scopeLabel(record),
    source: record.source ?? "-",
    status: record.status,
    ...(diagnostics ? { error: record.error ?? "-" } : {}),
    path: record.path
  }));
  console.table(rows);
}

function scopeLabel(record: InstalledPluginRecord): string {
  return record.scope === "project" ? `project:${record.repo}` : "global";
}
