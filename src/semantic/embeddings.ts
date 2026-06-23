import OpenAI from "openai";
import {
  createProviderCallRuntime,
  estimatedTokensFromText,
  runProviderCall,
  ProviderCallError,
  type ProviderCallRuntime,
  type ProviderPolicy
} from "../providers/openaiProvider.js";

export type EmbeddingVector = number[];

export type EmbedTextOptions = {
  model?: string;
  apiKey?: string;
  baseURL?: string;
  providerPolicy?: ProviderPolicy;
  providerRuntime?: ProviderCallRuntime;
};

export async function embedText(text: string, model = "text-embedding-3-small", apiKey?: string, baseURL?: string, providerPolicy?: ProviderPolicy): Promise<EmbeddingVector | undefined> {
  return (await embedTexts([text], { model, apiKey, baseURL, providerPolicy }))[0];
}

export async function embedTexts(texts: string[], options: EmbedTextOptions = {}): Promise<(EmbeddingVector | undefined)[]> {
  if (!options.apiKey) return texts.map(() => undefined);
  const client = new OpenAI({ apiKey: options.apiKey, baseURL: options.baseURL });
  const runtime = options.providerRuntime ?? createProviderCallRuntime(options.providerPolicy);
  return embedTextsWithSplit(client, texts.map((text) => text.slice(0, 8000)), options.model ?? "text-embedding-3-small", runtime);
}

async function embedTextsWithSplit(
  client: OpenAI,
  texts: string[],
  model: string,
  providerRuntime: ProviderCallRuntime
): Promise<(EmbeddingVector | undefined)[]> {
  if (texts.length === 0) return [];
  try {
    const response = await runProviderCall({
      label: "embedding.create",
      runtime: providerRuntime,
      estimatedTokens: estimatedTokensFromText(texts),
      fn: (signal) => client.embeddings.create({ model, input: texts }, { signal })
    });
    return texts.map((_, index) => response.data[index]?.embedding);
  } catch (error) {
    if (!shouldSplitEmbeddingBatchError(error)) throw error;
    if (texts.length === 1) return [undefined];
    const middle = Math.ceil(texts.length / 2);
    const left = await embedTextsWithSplit(client, texts.slice(0, middle), model, providerRuntime);
    const right = await embedTextsWithSplit(client, texts.slice(middle), model, providerRuntime);
    return [...left, ...right];
  }
}

function shouldSplitEmbeddingBatchError(error: unknown): boolean {
  if (!(error instanceof ProviderCallError)) return false;
  return error.kind === "permanent-failed" && (error.status === 400 || error.status === 413);
}

export function cosineSimilarity(a: EmbeddingVector, b: EmbeddingVector): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
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
