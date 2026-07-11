import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  discoverLogicLensPlugin,
  loadDiscoveredLogicLensPlugins,
  loadLogicLensPlugins,
  type DiscoveredLogicLensPlugin,
  type LoadedLogicLensPlugin
} from "@logiclens/plugin-runtime";
import type { PluginManifest } from "@logiclens/plugin-sdk";
import type { AppConfig } from "../../config/schema.js";
import { parserRegistry, contractExtractorRegistry, frameworkDetectorRegistry } from "../registries/registry.js";
import { toRepoNode } from "../workspace/repoRegistry.js";
import { adaptFactExtractor, adaptFrameworkDetector, adaptLanguageParser } from "./adapter.js";
import {
  builtinLanguagePluginManifests,
  detectionGlobsForPlugins,
  detectJavaSignals,
  detectActiveLanguages,
  pluginsForActiveLanguages,
  pluginsAvailableToRepo,
  projectPluginDir,
  scanRepoPathSnapshot,
  sourceGlobsForActiveLanguages,
  type AvailablePlugin
} from "./detection.js";
import {
  registerBuiltinParsersForActiveLanguages,
  registerCommonBuiltins,
  registerJavaBuiltinsForSignals,
  resetJavaBuiltinCapabilities
} from "./bootstrap.js";
import { BRAND } from "../../shared/branding.js";
import type { LanguageParser } from "../registries/types.js";

export type PluginBootstrapResult = {
  loadedPlugins: LoadedLogicLensPlugin[];
  additionalIndexFilesByRepo: ReadonlyMap<string, readonly string[]>;
  activePluginSourceGlobsByRepo: ReadonlyMap<string, readonly string[]>;
  availablePluginSourceGlobsByRepo: ReadonlyMap<string, readonly string[]>;
};

const registeredPluginState = {
  parsers: new Set<LanguageParser>(),
  extractors: new Set<string>(),
  detectors: new Set<string>()
};

export async function loadAndRegisterConfiguredPlugins(input: {
  config: AppConfig;
  cwd: string;
  warn?: (message: string) => void;
}): Promise<LoadedLogicLensPlugin[]> {
  const configured = input.config.plugins?.enabled ?? [];
  clearRegisteredPluginCapabilities();
  if (configured.length === 0) return [];
  const loaded = await loadLogicLensPlugins(configured, {
    cwd: input.cwd,
    failFast: input.config.plugins?.failFast,
    onWarning: input.warn
  });
  registerLoadedPlugins(loaded);
  return loaded;
}

export async function autoDetectAndRegisterPlugins(input: {
  config: AppConfig;
  cwd: string;
  repoConfigs: AppConfig["repos"];
  warn?: (message: string) => void;
  log?: (message: string) => void;
}): Promise<PluginBootstrapResult> {
  clearRegisteredPluginCapabilities();
  resetJavaBuiltinCapabilities();
  const repos = input.repoConfigs.map((repo) => toRepoNode(repo, input.cwd));
  const available = await discoverAvailablePlugins({
    cwd: input.cwd,
    repoPaths: repos.map((repo) => repo.path),
    config: input.config,
    warn: input.warn
  });
  const snapshots = await Promise.all(
    repos.map((repo) => {
      const repoPlugins = pluginsAvailableToRepo(available, repo.path);
      const detectionGlobs = detectionGlobsForPlugins(repoPlugins, [...input.config.include, "**/*.xml"]);
      return scanRepoPathSnapshot(repo.path, input.config, detectionGlobs);
    })
  );
  const repoPluginStates = snapshots.map((snapshot) => {
    const plugins = pluginsAvailableToRepo(available, snapshot.repoPath);
    return {
      snapshot,
      plugins,
      activeLanguages: detectActiveLanguages({ plugins, snapshots: [snapshot] })
    };
  });
  const activeLanguages = new Set(repoPluginStates.flatMap((state) => [...state.activeLanguages]));
  const javaSignals = await detectJavaSignals(snapshots);
  if (javaSignals.hasSourceFiles || javaSignals.hasBuildMarkers || javaSignals.hasDubboXml) {
    activeLanguages.add("java");
  }

  registerCommonBuiltins();
  registerJavaBuiltinsForSignals(javaSignals);
  await registerBuiltinParsersForActiveLanguages(activeLanguages, javaSignals);

  const loadable = [...new Set(repoPluginStates.flatMap((state) =>
    pluginsForActiveLanguages(state.plugins, state.activeLanguages)
  ))].filter((plugin) => plugin.entryPath);
  const loaded = await loadDiscoveredLogicLensPlugins(loadable.map(toDiscovered), {
    cwd: input.cwd,
    failFast: input.config.plugins?.failFast,
    onWarning: input.warn
  });
  const genericLegacy = await loadLegacyGenericPlugins(input);
  const allLoaded = [...loaded, ...genericLegacy];
  for (const loadedPlugin of loaded) {
    const availablePlugin = available.find((plugin) => plugin.source === loadedPlugin.source);
    const scopeRepoId = availablePlugin?.sourceKind === "project" && availablePlugin.ownerRepoPath
      ? repos.find((repo) => path.resolve(repo.path) === path.resolve(availablePlugin.ownerRepoPath!))?.id
      : undefined;
    registerLoadedPlugins([loadedPlugin], { clearFirst: false, scopeRepoId });
  }
  registerLoadedPlugins(genericLegacy, { clearFirst: false });

  if (activeLanguages.size > 0) {
    input.log?.(`Detected language plugins: ${[...activeLanguages].sort().join(", ")}`);
  }
  const additionalIndexFilesByRepo = new Map<string, string[]>();
  const loadedSources = new Set(loaded.map((plugin) => plugin.source));
  const loadedAvailable = available.filter((plugin) => loadedSources.has(plugin.source));
  const activePluginSourceGlobsByRepo = new Map<string, string[]>();
  const availablePluginSourceGlobsByRepo = new Map<string, string[]>();
  for (const state of repoPluginStates) {
    const loadedRepoPlugins = pluginsAvailableToRepo(loadedAvailable, state.snapshot.repoPath);
    const sourceGlobs = sourceGlobsForActiveLanguages(loadedRepoPlugins, state.activeLanguages);
    if (sourceGlobs.length > 0) activePluginSourceGlobsByRepo.set(state.snapshot.repoPath, sourceGlobs);
    const availableLanguages = new Set(state.plugins.flatMap((plugin) =>
      (plugin.manifest.languages ?? []).map((language) => language.id)
    ));
    const candidateGlobs = sourceGlobsForActiveLanguages(
      state.plugins.filter((plugin) => plugin.entryPath),
      availableLanguages
    );
    if (candidateGlobs.length > 0) availablePluginSourceGlobsByRepo.set(state.snapshot.repoPath, candidateGlobs);
  }
  for (const file of javaSignals.dubboXmlFiles) {
    const paths = additionalIndexFilesByRepo.get(file.repoPath) ?? [];
    paths.push(file.relativePath);
    additionalIndexFilesByRepo.set(file.repoPath, paths);
  }
  return {
    loadedPlugins: allLoaded,
    additionalIndexFilesByRepo,
    activePluginSourceGlobsByRepo,
    availablePluginSourceGlobsByRepo
  };
}

export function registerLoadedPlugins(
  loaded: readonly LoadedLogicLensPlugin[],
  options: { clearFirst?: boolean; scopeRepoId?: string } = {}
): void {
  if (options.clearFirst ?? true) clearRegisteredPluginCapabilities();
  for (const { plugin } of loaded) {
    for (const language of plugin.languages ?? []) {
      const parser = adaptLanguageParser(language, options.scopeRepoId);
      if (parser) {
        parserRegistry.register(parser);
        registeredPluginState.parsers.add(parser);
      }
    }
    for (const extractor of plugin.factExtractors ?? []) {
      const adapted = adaptFactExtractor(extractor, options.scopeRepoId);
      contractExtractorRegistry.register(adapted);
      registeredPluginState.extractors.add(adapted.name);
    }
    for (const detector of plugin.frameworkDetectors ?? []) {
      const adapted = adaptFrameworkDetector(detector, options.scopeRepoId);
      frameworkDetectorRegistry.register(adapted);
      registeredPluginState.detectors.add(adapted.name);
    }
  }
}

export function clearRegisteredPluginCapabilities(): void {
  for (const parser of registeredPluginState.parsers) parserRegistry.unregister(parser);
  for (const extractor of registeredPluginState.extractors) contractExtractorRegistry.unregister(extractor);
  for (const detector of registeredPluginState.detectors) frameworkDetectorRegistry.unregister(detector);
  registeredPluginState.parsers.clear();
  registeredPluginState.extractors.clear();
  registeredPluginState.detectors.clear();
}

async function discoverAvailablePlugins(input: {
  cwd: string;
  repoPaths: readonly string[];
  config: AppConfig;
  warn?: (message: string) => void;
}): Promise<AvailablePlugin[]> {
  const projectPlugins = (await Promise.all(input.repoPaths.map(async (repoPath) =>
    discoverDirs(await childPluginDirs(projectPluginDir(repoPath)), "project", input.warn, repoPath)
  ))).flat();
  const globalDirs = await childPluginDirs(path.join(os.homedir(), BRAND.configDirName, "plugins"));
  const legacyDirs = input.config.plugins?.enabled.filter(isPathLikeDirectorySpecifier) ?? [];
  const discovered: AvailablePlugin[] = [
    ...projectPlugins,
    ...(await discoverDirs(globalDirs, "global", input.warn)),
    ...(await discoverDirs(legacyDirs.map((specifier) => path.resolve(input.cwd, specifier)), "legacy", input.warn)),
    ...builtinLanguagePluginManifests
  ];
  return dedupeByManifestName(discovered);
}

async function childPluginDirs(parent: string): Promise<string[]> {
  const entries = await fs.readdir(parent, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(parent, entry.name));
}

async function discoverDirs(
  dirs: readonly string[],
  sourceKind: AvailablePlugin["sourceKind"],
  warn?: (message: string) => void,
  ownerRepoPath?: string
): Promise<AvailablePlugin[]> {
  const plugins: AvailablePlugin[] = [];
  for (const dir of dirs) {
    try {
      const discovered = await discoverLogicLensPlugin(dir, `${sourceKind}:${dir}`);
      plugins.push({
        manifest: discovered.manifest,
        source: discovered.source,
        sourceKind,
        baseDir: discovered.baseDir,
        entryPath: discovered.entryPath,
        ownerRepoPath
      });
    } catch (error) {
      warn?.(`Failed to discover LogicLens plugin "${dir}": ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return plugins;
}

function dedupeByManifestName(plugins: readonly AvailablePlugin[]): AvailablePlugin[] {
  const byName = new Map<string, AvailablePlugin>();
  for (const plugin of plugins) {
    const key = plugin.sourceKind === "project"
      ? `${plugin.manifest.name}\0${plugin.ownerRepoPath ?? ""}`
      : plugin.manifest.name;
    if (!byName.has(key)) byName.set(key, plugin);
  }
  return [...byName.values()];
}

function toDiscovered(plugin: AvailablePlugin): DiscoveredLogicLensPlugin {
  return {
    manifest: plugin.manifest as PluginManifest,
    source: plugin.source,
    baseDir: plugin.baseDir ?? "",
    entryPath: plugin.entryPath ?? ""
  };
}

async function loadLegacyGenericPlugins(input: {
  config: AppConfig;
  cwd: string;
  warn?: (message: string) => void;
}): Promise<LoadedLogicLensPlugin[]> {
  const legacyImportSpecifiers = input.config.plugins?.enabled.filter((specifier) => !isPathLikeDirectorySpecifier(specifier)) ?? [];
  if (legacyImportSpecifiers.length === 0) return [];
  const loaded = await loadLogicLensPlugins(legacyImportSpecifiers, {
    cwd: input.cwd,
    failFast: input.config.plugins?.failFast,
    onWarning: input.warn
  });
  return loaded.filter(({ plugin, source }) => {
    const isGeneric = !plugin.manifest.languages || plugin.manifest.languages.length === 0;
    if (!isGeneric) {
      input.warn?.(`Legacy configured language plugin "${source}" was loaded for compatibility but not registered; language plugins are activated by project detection.`);
    }
    return isGeneric;
  });
}

function isPathLikeDirectorySpecifier(specifier: string): boolean {
  if (path.extname(specifier)) return false;
  return specifier.startsWith(".") || specifier.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(specifier);
}
