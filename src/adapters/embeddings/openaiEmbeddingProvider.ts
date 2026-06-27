import OpenAI from "openai";
import {
  createProviderCallRuntime,
  estimatedTokensFromText,
  runProviderCall,
  ProviderCallError,
  type ProviderCallRuntime
} from "../../shared/providerPolicy.js";
import type { EmbeddingProvider, EmbeddingVector } from "../../core/plugins/types.js";

const MAX_INPUT_CHARS = 8000;

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly name: string;
  private readonly client: OpenAI | undefined;

  constructor(
    private readonly model: string = "text-embedding-3-small",
    apiKey?: string,
    baseURL?: string,
    name = "openai"
  ) {
    this.name = name;
    this.client = apiKey ? new OpenAI({ apiKey, baseURL }) : undefined;
  }

  async embedText(text: string, runtime?: ProviderCallRuntime): Promise<EmbeddingVector | undefined> {
    return (await this.embedTexts([text], runtime))[0];
  }

  async embedTexts(texts: string[], runtime?: ProviderCallRuntime): Promise<(EmbeddingVector | undefined)[]> {
    if (!this.client) return texts.map(() => undefined);
    const providerRuntime = runtime ?? createProviderCallRuntime();
    return embedTextsWithSplit(this.client, texts.map((text) => text.slice(0, MAX_INPUT_CHARS)), this.model, providerRuntime);
  }
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
