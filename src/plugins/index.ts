import type {
  LogicLensPlugin,
  PluginContext,
  LanguageParser,
  ContractExtractor,
  EmbeddingProvider,
  EmbeddingVector,
  ParseInput,
  ExtractContext
} from "./types.js";
import type { ProviderCallRuntime, ProviderCallStats, ProviderPolicy } from "../providers/openaiProvider.js";

/**
 * Defines a LogicLens plugin. Provides runtime verification of the plugin API version.
 * This is a type helper to define plugins with auto-completion.
 * 
 * @param plugin - The LogicLens plugin definition object.
 * @returns The verified plugin definition.
 * @throws An error if the plugin API version is declared but unsupported.
 */
export function definePlugin(plugin: LogicLensPlugin): LogicLensPlugin {
  if (plugin.pluginApiVersion && plugin.pluginApiVersion !== "1") {
    throw new Error(`Plugin "${plugin.name}" declares unsupported pluginApiVersion "${plugin.pluginApiVersion}". Expected "1".`);
  }
  return plugin;
}

export type {
  LogicLensPlugin,
  PluginContext,
  LanguageParser,
  ContractExtractor,
  EmbeddingProvider,
  EmbeddingVector,
  ParseInput,
  ExtractContext,
  ProviderCallRuntime,
  ProviderCallStats,
  ProviderPolicy
};
