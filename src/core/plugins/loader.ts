import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { loadConfig } from "../../config/loadConfig.js";
import type { LogicLensConfig } from "../../config/schema.js";
import { embeddingProviderRegistry, parserRegistry } from "./registry.js";
import { pluginStoreDir } from "./packageManager.js";
import { registerBuiltinEmbeddingProviders } from "../../adapters/embeddings/builtinProviders.js";
import type { LoadedPlugin, LogicLensPlugin, PluginContext } from "./types.js";

const loadedPluginKeys = new Set<string>();
const loadedPluginRecords = new Map<string, LoadedPlugin>();

/**
 * The output structure describing the results of loading LogicLens plugins.
 */
export type PluginLoadResult = {
  /** The list of successfully loaded plugins with metadata */
  loaded: LoadedPlugin[];
  /** The number of language parsers registered by the loaded plugins */
  parserCount: number;
  /** The number of embedding providers registered by the loaded plugins */
  embeddingProviderCount: number;
};

/**
 * Returns whether a plugin name refers to a local filesystem path (rather than
 * an npm package): a relative path, an absolute POSIX path, or a Windows drive path.
 */
export function isLocalPluginName(name: string): boolean {
  return name.startsWith(".") || name.startsWith("/") || /^[A-Za-z]:[\\/]/.test(name);
}

async function resolvePluginImport(name: string, cwd: string): Promise<{ importId: string; resolvedPath: string }> {
  if (isLocalPluginName(name)) {
    let resolved = path.resolve(cwd, name);
    const stat = await fs.stat(resolved).catch(() => undefined);
    if (stat?.isDirectory()) resolved = path.join(resolved, "index.js");
    return { importId: pathToFileURL(resolved).href, resolvedPath: resolved };
  }
  // Bare npm specifier. Resolve from LogicLens's private plugin store first
  // (where `plugin add` installs packages), then the workspace node_modules,
  // so packages are found even when logiclens is installed globally. Fall back
  // to the bare specifier (resolved relative to logiclens) as a last resort.
  const anchors = [
    path.join(pluginStoreDir(cwd), "package.json"),
    path.join(cwd, "package.json")
  ];
  for (const anchor of anchors) {
    try {
      const resolved = createRequire(anchor).resolve(name);
      return { importId: pathToFileURL(resolved).href, resolvedPath: resolved };
    } catch {
      // Try the next anchor.
    }
  }
  return { importId: name, resolvedPath: name };
}

function findPlugin(moduleExports: Record<string, unknown>, moduleName: string): LogicLensPlugin {
  const candidates = [
    moduleExports.default,
    moduleExports.plugin,
    ...Object.values(moduleExports)
  ];
  const plugin = candidates.find((candidate): candidate is LogicLensPlugin => {
    return Boolean(candidate)
      && typeof candidate === "object"
      && typeof (candidate as LogicLensPlugin).name === "string"
      && typeof (candidate as LogicLensPlugin).version === "string"
      && typeof (candidate as LogicLensPlugin).setup === "function";
  });
  if (!plugin) throw new Error(`Plugin "${moduleName}" does not export a LogicLensPlugin object.`);
  return plugin;
}

/**
 * Resolves, imports, and validates a plugin module without running its `setup`.
 *
 * Used by `logiclens plugin add` to verify that a freshly installed package
 * actually exports a usable LogicLensPlugin (correct shape + supported API
 * version) before it is written into the configuration file.
 *
 * @param name - The plugin module name: an npm package or a local path.
 * @param cwd - The workspace directory used to resolve the module.
 * @returns The validated plugin and the resolved filesystem path / specifier.
 */
export async function importPluginModule(name: string, cwd = process.cwd()): Promise<{ plugin: LogicLensPlugin; resolvedPath: string }> {
  const resolved = await resolvePluginImport(name, cwd);
  const moduleExports = await import(resolved.importId) as Record<string, unknown>;
  const plugin = findPlugin(moduleExports, name);
  if (plugin.pluginApiVersion && plugin.pluginApiVersion !== "1") {
    throw new Error(`Plugin "${plugin.name}" declares unsupported pluginApiVersion "${plugin.pluginApiVersion}". Expected "1".`);
  }
  return { plugin, resolvedPath: resolved.resolvedPath };
}

export type LoadPluginsInput = {
  cwd?: string;
  config?: LogicLensConfig;
  inlinePlugins?: LogicLensPlugin[];
  loadConfiguredPlugins?: boolean;
};

export async function loadPlugins(input: LoadPluginsInput = {}): Promise<PluginLoadResult> {
  const cwd = input.cwd ?? process.cwd();
  const config = input.config ?? await loadConfig(cwd);
  const loaded: LoadedPlugin[] = [];
  const parserStartCount = parserRegistry.parsers().length;
  const embeddingStartCount = embeddingProviderRegistry.providers().length;

  // 1. Load config plugins (unless disabled)
  if (input.loadConfiguredPlugins !== false) {
    for (const pluginConfig of config.plugins) {
      const started = Date.now();
      let resolvedPath = pluginConfig.name;
      try {
        const resolved = await resolvePluginImport(pluginConfig.name, cwd);
        resolvedPath = resolved.resolvedPath;
        const moduleExports = await import(resolved.importId) as Record<string, unknown>;
        const plugin = findPlugin(moduleExports, pluginConfig.name);
        
        if (plugin.pluginApiVersion && plugin.pluginApiVersion !== "1") {
          throw new Error(`Plugin "${plugin.name}" declares unsupported pluginApiVersion "${plugin.pluginApiVersion}". Expected "1".`);
        }
        
        const loadKey = `${plugin.name}@${plugin.version}:${JSON.stringify(pluginConfig.options ?? null)}`;
        if (loadedPluginKeys.has(loadKey)) {
          const record = loadedPluginRecords.get(loadKey);
          if (record) loaded.push(record);
          continue;
        }
        
        const context: PluginContext = {
          cwd,
          config,
          registerParser: (parser) => parserRegistry.register(parser),
          registerEmbeddingProvider: (provider) => embeddingProviderRegistry.register(provider)
        };
        await plugin.setup(context, pluginConfig.options);
        loadedPluginKeys.add(loadKey);
        const record = {
          name: plugin.name,
          version: plugin.version,
          moduleName: pluginConfig.name,
          resolvedPath,
          setupMs: Date.now() - started
        };
        loadedPluginRecords.set(loadKey, record);
        loaded.push(record);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to load plugin "${pluginConfig.name}" from "${resolvedPath}": ${message}`);
      }
    }
  }

  // 2. Load inline plugins
  if (input.inlinePlugins) {
    for (const plugin of input.inlinePlugins) {
      const started = Date.now();
      try {
        if (plugin.pluginApiVersion && plugin.pluginApiVersion !== "1") {
          throw new Error(`Plugin "${plugin.name}" declares unsupported pluginApiVersion "${plugin.pluginApiVersion}". Expected "1".`);
        }

        const loadKey = `${plugin.name}@${plugin.version}:${JSON.stringify(null)}`;
        if (loadedPluginKeys.has(loadKey)) {
          const record = loadedPluginRecords.get(loadKey);
          if (record) loaded.push(record);
          continue;
        }

        const context: PluginContext = {
          cwd,
          config,
          registerParser: (parser) => parserRegistry.register(parser),
          registerEmbeddingProvider: (provider) => embeddingProviderRegistry.register(provider)
        };
        await plugin.setup(context, undefined);
        loadedPluginKeys.add(loadKey);
        const record = {
          name: plugin.name,
          version: plugin.version,
          moduleName: plugin.name,
          resolvedPath: "inline",
          setupMs: Date.now() - started
        };
        loadedPluginRecords.set(loadKey, record);
        loaded.push(record);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to load inline plugin "${plugin.name}": ${message}`);
      }
    }
  }

  // 3. Register built-in providers (after plugins, so plugin overrides win)
  registerBuiltinEmbeddingProviders(config);

  return {
    loaded,
    parserCount: parserRegistry.parsers().length - parserStartCount,
    embeddingProviderCount: embeddingProviderRegistry.providers().length - embeddingStartCount
  };
}

/**
 * Loads all plugins configured in the LogicLens configuration file (`.logiclens/config.yaml`).
 */
export async function loadConfiguredPlugins(input: {
  cwd?: string;
  config?: LogicLensConfig;
} = {}): Promise<PluginLoadResult> {
  return loadPlugins({
    cwd: input.cwd,
    config: input.config,
    loadConfiguredPlugins: true
  });
}

