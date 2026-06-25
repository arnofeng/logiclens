import { createLogicLens } from "../sdk/client.js";
import { importPluginModule, isLocalPluginName } from "../plugins/loader.js";
import { detectPackageManager, installPackage } from "../plugins/packageManager.js";

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
 */
export async function pluginAddCommand(name: string, options: PluginAddOptions = {}, cwd = process.cwd()): Promise<void> {
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
    await installPackage(cwd, spec, pm);
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

  const client = await createLogicLens({ cwd });
  try {
    const result = await client.addPlugin(packageName, { options: pluginOptions });
    console.log(`${result.replaced ? "Updated" : "Added"} plugin "${packageName}" in config.`);
  } finally {
    await client.close();
  }
}

/**
 * Implements `logiclens plugin remove <name>`: removes the plugin entry from
 * config.yaml. The installed package, if any, is left in place.
 *
 * @param name - The plugin name to remove (as stored in config).
 * @param cwd - The workspace directory.
 */
export async function pluginRemoveCommand(name: string, cwd = process.cwd()): Promise<void> {
  const client = await createLogicLens({ cwd });
  try {
    const result = await client.removePlugin(name);
    if (result.removed) console.log(`Removed plugin "${name}" from config.`);
    else console.log(`Plugin "${name}" was not found in config.`);
  } finally {
    await client.close();
  }
}
