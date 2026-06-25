import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type { Command } from "commander";
import { loadConfig } from "../config/loadConfig.js";
import type { LogicLensConfig } from "../config/schema.js";
import { cliCommandRegistry, contractExtractorRegistry, embeddingProviderRegistry, frameworkDetectorRegistry, parserRegistry } from "./registry.js";
import { registerBuiltinEmbeddingProviders } from "../semantic/builtinProviders.js";
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
  /** The number of contract extractors registered by the loaded plugins */
  extractorCount: number;
  /** The number of custom CLI command hooks registered by the loaded plugins */
  cliCommandCount: number;
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
  // Bare npm specifier: resolve from the workspace cwd first so packages installed
  // into the workspace node_modules are found even when logiclens is installed
  // globally. Fall back to the bare specifier (resolved relative to logiclens).
  try {
    const requireFromCwd = createRequire(path.join(cwd, "package.json"));
    const resolved = requireFromCwd.resolve(name);
    return { importId: pathToFileURL(resolved).href, resolvedPath: resolved };
  } catch {
    return { importId: name, resolvedPath: name };
  }
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
  program?: Command;
  inlinePlugins?: LogicLensPlugin[];
  loadConfiguredPlugins?: boolean;
};

export async function loadPlugins(input: LoadPluginsInput = {}): Promise<PluginLoadResult> {
  const cwd = input.cwd ?? process.cwd();
  const config = input.config ?? await loadConfig(cwd);
  const loaded: LoadedPlugin[] = [];
  const parserStartCount = parserRegistry.parsers().length;
  const extractorStartCount = contractExtractorRegistry.extractors().length;
  const cliStartCount = cliCommandRegistry.count();
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
          registerContractExtractor: (extractor) => contractExtractorRegistry.register(extractor),
          registerCliCommand: (registerFn) => cliCommandRegistry.register(registerFn),
          registerFrameworkDetector: (detector) => frameworkDetectorRegistry.register(detector),
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
          registerContractExtractor: (extractor) => contractExtractorRegistry.register(extractor),
          registerCliCommand: (registerFn) => cliCommandRegistry.register(registerFn),
          registerFrameworkDetector: (detector) => frameworkDetectorRegistry.register(detector),
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

  if (input.program) cliCommandRegistry.apply(input.program);

  return {
    loaded,
    parserCount: parserRegistry.parsers().length - parserStartCount,
    extractorCount: contractExtractorRegistry.extractors().length - extractorStartCount,
    cliCommandCount: cliCommandRegistry.count() - cliStartCount,
    embeddingProviderCount: embeddingProviderRegistry.providers().length - embeddingStartCount
  };
}

/**
 * Loads all plugins configured in the LogicLens configuration file (`.logiclens/config.yaml`).
 * 
 * @param input - Input options including working directory, parsed configuration, and commander instance.
 * @returns A promise that resolves to the plugin load result summary.
 */
export async function loadConfiguredPlugins(input: {
  cwd?: string;
  config?: LogicLensConfig;
  program?: Command;
} = {}): Promise<PluginLoadResult> {
  return loadPlugins({
    cwd: input.cwd,
    config: input.config,
    program: input.program,
    loadConfiguredPlugins: true
  });
}

/**
 * Attempts to load configured plugins for the CLI. If loading fails,
 * throws the error to be handled by the CLI runner.
 * 
 * @param cwd - The working directory to resolve configuration and plugins.
 * @param program - Optional Command instance to register custom CLI commands.
 * @returns A promise resolving to the plugin load result or undefined.
 */
export async function tryLoadConfiguredPluginsForCli(cwd = process.cwd(), program?: Command): Promise<PluginLoadResult | undefined> {
  try {
    return await loadConfiguredPlugins({ cwd, program });
  } catch (error) {
    throw error;
  }
}
