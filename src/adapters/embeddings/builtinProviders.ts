import type { AppConfig } from "../../config/schema.js";
import { embeddingProviderRegistry } from "../../core/registries/registry.js";
import { OpenAIEmbeddingProvider } from "./openaiEmbeddingProvider.js";

/**
 * Registers the embedding providers that ship with the package.
 *
 * Currently only the OpenAI-compatible provider is built in, and only when the
 * configuration selects it.
 */
export function registerBuiltinEmbeddingProviders(config: AppConfig): void {
  if (config.embedding.provider !== "openai") return;
  if (embeddingProviderRegistry.resolve("openai")) return;
  embeddingProviderRegistry.register(new OpenAIEmbeddingProvider(
    config.embedding.model,
    config.embedding.apiKey ?? process.env.OPENAI_API_KEY,
    config.embedding.baseUrl ?? process.env.OPENAI_BASE_URL
  ));
}
