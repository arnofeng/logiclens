import type { EmbeddingProvider, EmbeddingVector } from "../registries/types.js";
import { embeddingProviderRegistry, type EmbeddingProviderRegistry } from "../registries/registry.js";

export type { EmbeddingVector };
export type { EmbeddingProvider };

export class NullEmbeddingProvider implements EmbeddingProvider {
  readonly name = "off";

  async embedTexts(texts: string[]): Promise<(EmbeddingVector | undefined)[]> {
    return texts.map(() => undefined);
  }

  async embedText(_text: string): Promise<EmbeddingVector | undefined> {
    return undefined;
  }
}

export function resolveEmbeddingProvider(
  providerName: string,
  registry: EmbeddingProviderRegistry = embeddingProviderRegistry
): EmbeddingProvider {
  if (providerName === "off") return new NullEmbeddingProvider();
  const provider = registry.resolve(providerName);
  if (!provider) {
    const available = registry.names();
    const hint = available.length > 0
      ? ` Available providers: ${available.join(", ")}.`
      : " No embedding providers are registered. Configure a built-in embedding provider.";
    throw new Error(`Embedding provider "${providerName}" is not registered.${hint}`);
  }
  return provider;
}

let hasWarnedDimensionMismatch = false;

export function cosineSimilarity(a: EmbeddingVector, b: EmbeddingVector): number {
  if (a.length === 0 || b.length === 0) return 0;
  if (a.length !== b.length) {
    if (!hasWarnedDimensionMismatch) {
      console.warn(`[WARNING] Cosine similarity dimension mismatch: vector A has length ${a.length} but vector B has length ${b.length}. returning 0 similarity. This may be due to mixed embedding models.`);
      hasWarnedDimensionMismatch = true;
    }
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  return normA === 0 || normB === 0 ? 0 : dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
