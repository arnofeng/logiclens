import { loadLogicLensPlugins, type LoadedLogicLensPlugin } from "@logiclens/plugin-runtime";
import type { AppConfig } from "../../config/schema.js";
import { parserRegistry, contractExtractorRegistry, frameworkDetectorRegistry } from "../registries/registry.js";
import { adaptFactExtractor, adaptFrameworkDetector, adaptLanguageParser } from "./adapter.js";

const registeredPluginState = {
  languages: new Set<string>(),
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

export function registerLoadedPlugins(loaded: readonly LoadedLogicLensPlugin[]): void {
  clearRegisteredPluginCapabilities();
  for (const { plugin } of loaded) {
    for (const language of plugin.languages ?? []) {
      const parser = adaptLanguageParser(language);
      if (parser) {
        parserRegistry.register(parser);
        registeredPluginState.languages.add(parser.language);
      }
    }
    for (const extractor of plugin.factExtractors ?? []) {
      const adapted = adaptFactExtractor(extractor);
      contractExtractorRegistry.register(adapted);
      registeredPluginState.extractors.add(adapted.name);
    }
    for (const detector of plugin.frameworkDetectors ?? []) {
      const adapted = adaptFrameworkDetector(detector);
      frameworkDetectorRegistry.register(adapted);
      registeredPluginState.detectors.add(adapted.name);
    }
  }
}

export function clearRegisteredPluginCapabilities(): void {
  for (const language of registeredPluginState.languages) parserRegistry.unregisterLanguage(language);
  for (const extractor of registeredPluginState.extractors) contractExtractorRegistry.unregister(extractor);
  for (const detector of registeredPluginState.detectors) frameworkDetectorRegistry.unregister(detector);
  registeredPluginState.languages.clear();
  registeredPluginState.extractors.clear();
  registeredPluginState.detectors.clear();
}
