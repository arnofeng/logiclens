import type { LogicLensConfig } from "../../config/schema.js";
import { embeddingProviderRegistry } from "../../plugins/registry.js";
import { OpenAIEmbeddingProvider } from "./openaiEmbeddingProvider.js";

/**
 * Registers the embedding providers that ship with LogicLens.
 *
 * Currently only the OpenAI-compatible provider is built in, and only when the
 * configuration selects it. A provider already registered under the same name
 * (e.g. by a plugin) takes precedence and is left untouched.
 */
export function registerBuiltinEmbeddingProviders(config: LogicLensConfig): void {
  if (config.embedding.provider !== "openai") return;
  if (embeddingProviderRegistry.resolve("openai")) return;
  embeddingProviderRegistry.register(new OpenAIEmbeddingProvider(
    config.embedding.model,
    config.embedding.apiKey ?? process.env.OPENAI_API_KEY,
    config.embedding.baseUrl ?? process.env.OPENAI_BASE_URL
  ));
}
