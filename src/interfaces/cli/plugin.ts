import { loadConfig, writeConfig, defaultConfig } from "../../config/loadConfig.js";
import type { LogicLensConfig } from "../../config/schema.js";
import { importPluginModule, isLocalPluginName } from "../plugins/loader.js";
import { detectPackageManager, installPackage } from "../plugins/packageManager.js";

async function loadConfigOrDefault(cwd: string): Promise<LogicLensConfig> {
  try {
    return await loadConfig(cwd);
  } catch {
    return defaultConfig();
  }
}

/**
 * Options accepted by `logiclens plugin add`.
 */
export type PluginAddOptions = {
  /** JSON string of options to store with the plugin entry */
  options?: string;
  /** Whether to install the package (commander sets false for --no-install) */
  install?: boolean;
  /** Skip importing and validating the plugin after installing */
  skipVerify?: boolean;
};

/**
 * Injectable dependencies for `pluginAddCommand`, used to stub the package
 * install step in tests so the spawn path is not exercised.
 */
export type PluginAddDeps = {
  installPackage: typeof installPackage;
};

/**
 * Splits an npm package spec into the install spec and the bare package name
 * stored in configuration. Handles scoped packages and version/tag suffixes:
 * `pkg@1.2.3` -> { spec: "pkg@1.2.3", packageName: "pkg" }, and
 * `@scope/pkg@1.2.3` -> { spec, packageName: "@scope/pkg" }.
 */
export function parseNpmSpec(name: string): { spec: string; packageName: string } {
  const lastAt = name.lastIndexOf("@");
  const packageName = lastAt > 0 ? name.slice(0, lastAt) : name;
  return { spec: name, packageName };
}

/**
 * Implements `logiclens plugin add <name>`: optionally installs the plugin
 * package, verifies it exports a valid plugin, and records it in config.yaml.
 *
 * @param name - The plugin to add: an npm package (optionally `@version`) or a local path.
 * @param options - Command options.
 * @param cwd - The workspace directory.
 * @param deps - Injectable dependencies (the package installer); defaults to the real one.
 */
export async function pluginAddCommand(
  name: string,
  options: PluginAddOptions = {},
  cwd = process.cwd(),
  deps: PluginAddDeps = { installPackage }
): Promise<void> {
  const local = isLocalPluginName(name);
  const { spec, packageName } = local ? { spec: name, packageName: name } : parseNpmSpec(name);

  let pluginOptions: unknown;
  if (options.options !== undefined) {
    try {
      pluginOptions = JSON.parse(options.options);
    } catch (error) {
      throw new Error(`Invalid --options JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (!local && options.install !== false) {
    const pm = await detectPackageManager(cwd);
    console.log(`Installing ${spec} with ${pm}...`);
    await deps.installPackage(cwd, spec, pm);
  }

  if (!options.skipVerify) {
    try {
      const { plugin } = await importPluginModule(packageName, cwd);
      console.log(`Verified plugin ${plugin.name}@${plugin.version}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Plugin "${packageName}" failed verification and was not added to config: ${message}`);
    }
  }

  const config = await loadConfigOrDefault(cwd);
  const replaced = config.plugins.some((plugin) => plugin.name === packageName);
  const plugins = config.plugins.filter((plugin) => plugin.name !== packageName);
  const entry: { name: string; options?: unknown } = { name: packageName };
  if (pluginOptions !== undefined) entry.options = pluginOptions;
  plugins.push(entry);
  await writeConfig({ ...config, plugins }, cwd);
  console.log(`${replaced ? "Updated" : "Added"} plugin "${packageName}" in config.`);
}

/**
 * Implements `logiclens plugin remove <name>`: removes the plugin entry from
 * config.yaml. The installed package, if any, is left in place.
 *
 * @param name - The plugin name to remove (as stored in config).
 * @param cwd - The workspace directory.
 */
export async function pluginRemoveCommand(name: string, cwd = process.cwd()): Promise<void> {
  const config = await loadConfigOrDefault(cwd);
  const plugins = config.plugins.filter((plugin) => plugin.name !== name);
  const removed = plugins.length < config.plugins.length;
  if (removed) {
    await writeConfig({ ...config, plugins }, cwd);
    console.log(`Removed plugin "${name}" from config.`);
  } else {
    console.log(`Plugin "${name}" was not found in config.`);
  }
}
