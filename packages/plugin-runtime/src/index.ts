import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  LOGICLENS_PLUGIN_API_VERSION,
  type LogicLensPlugin,
  type PluginCapability
} from "@logiclens/plugin-sdk";

export type PluginRuntimeOptions = {
  cwd?: string;
  failFast?: boolean;
  onWarning?: (message: string) => void;
};

export type LoadedLogicLensPlugin = {
  plugin: LogicLensPlugin;
  source: string;
};

const SUPPORTED_API_MAJOR = majorOf(LOGICLENS_PLUGIN_API_VERSION);

export async function loadLogicLensPlugins(
  pluginSpecifiers: readonly string[],
  options: PluginRuntimeOptions = {}
): Promise<LoadedLogicLensPlugin[]> {
  const loaded: LoadedLogicLensPlugin[] = [];
  for (const specifier of pluginSpecifiers) {
    try {
      const plugin = await importPlugin(specifier, options.cwd ?? process.cwd());
      validatePlugin(plugin, specifier);
      loaded.push({ plugin, source: specifier });
    } catch (error) {
      const message = `Failed to load LogicLens plugin "${specifier}": ${error instanceof Error ? error.message : String(error)}`;
      if (options.failFast) throw new Error(message);
      options.onWarning?.(message);
    }
  }
  return loaded;
}

export function validatePlugin(plugin: unknown, source = "<plugin>"): asserts plugin is LogicLensPlugin {
  if (!plugin || typeof plugin !== "object") {
    throw new Error(`${source} did not export a plugin object.`);
  }
  const candidate = plugin as Partial<LogicLensPlugin>;
  const manifest = candidate.manifest;
  if (!manifest || typeof manifest !== "object") {
    throw new Error(`${source} is missing manifest.`);
  }
  if (!manifest.name || !manifest.version || !manifest.logiclensPluginApiVersion) {
    throw new Error(`${source} manifest must include name, version, and logiclensPluginApiVersion.`);
  }
  if (!Array.isArray(manifest.capabilities)) {
    throw new Error(`${source} manifest capabilities must be an array.`);
  }
  for (const capability of manifest.capabilities) {
    if (!isKnownCapability(capability)) {
      throw new Error(`${source} declares unknown capability "${String(capability)}".`);
    }
  }
  if (majorOf(manifest.logiclensPluginApiVersion) !== SUPPORTED_API_MAJOR) {
    throw new Error(
      `${source} requires plugin API ${manifest.logiclensPluginApiVersion}, ` +
      `but this runtime supports ${LOGICLENS_PLUGIN_API_VERSION}.`
    );
  }
  requireCapabilityPayload(candidate, "language", candidate.languages, source);
  requireCapabilityPayload(candidate, "fact-extractor", candidate.factExtractors, source);
  requireCapabilityPayload(candidate, "framework-detector", candidate.frameworkDetectors, source);
  requireCapabilityPayload(candidate, "resolver", candidate.resolvers, source);
}

async function importPlugin(specifier: string, cwd: string): Promise<LogicLensPlugin> {
  const moduleSpecifier = isPathSpecifier(specifier)
    ? pathToFileURL(path.resolve(cwd, specifier)).href
    : specifier;
  const moduleValue = await import(moduleSpecifier) as { default?: unknown; plugin?: unknown };
  return (moduleValue.default ?? moduleValue.plugin ?? moduleValue) as LogicLensPlugin;
}

function isPathSpecifier(specifier: string): boolean {
  return specifier.startsWith(".") || specifier.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(specifier);
}

function majorOf(version: string): number {
  const major = Number(version.split(".")[0]);
  return Number.isFinite(major) ? major : -1;
}

function isKnownCapability(value: unknown): value is PluginCapability {
  return value === "language" ||
    value === "fact-extractor" ||
    value === "framework-detector" ||
    value === "resolver";
}

function requireCapabilityPayload(
  plugin: Partial<LogicLensPlugin>,
  capability: PluginCapability,
  value: unknown,
  source: string
): void {
  if (!plugin.manifest?.capabilities.includes(capability)) return;
  if (!Array.isArray(value)) {
    throw new Error(`${source} declares "${capability}" but does not provide a matching array.`);
  }
}
