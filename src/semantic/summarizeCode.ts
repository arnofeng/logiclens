import OpenAI from "openai";
import type { CodeSymbol } from "../parsers/types.js";
import {
  estimatedTokensFromText,
  runProviderCall,
  type ProviderCallRuntime,
  type ProviderPolicy
} from "../providers/openaiProvider.js";

export type CodeSemanticSummary = {
  summary: string;
  responsibilities: string[];
  inputs: string[];
  outputs: string[];
  sideEffects: string[];
  domainTerms: string[];
  operations: Array<{
    verb: "CREATE" | "READ" | "UPDATE" | "DELETE" | "PUBLISH" | "CONSUME" | "VALIDATE" | "TRANSFORM" | "CONFIGURE" | "CALL";
    entity: string;
    confidence: number;
  }>;
};

export function buildSummarizePrompt(input: { repoName: string; filePath: string; language: string; kind: string; name: string; signature?: string; source: string }): string {
  return `You are analyzing code for a multi-repository semantic dependency and impact graph.

Return strict JSON only.

Repository: ${input.repoName}
File: ${input.filePath}
Language: ${input.language}
Kind: ${input.kind}
Name: ${input.name}
Signature: ${input.signature ?? ""}

Source:
\`\`\`${input.language}
${input.source}
\`\`\`

Extract:
{
  "summary": "one or two sentences explaining what this code does",
  "responsibilities": ["..."],
  "inputs": ["..."],
  "outputs": ["..."],
  "sideEffects": ["database write, network call, event publish, etc"],
  "domainTerms": ["Order", "Payment", "User"],
  "operations": [{"verb": "CREATE|READ|UPDATE|DELETE|PUBLISH|CONSUME|VALIDATE|TRANSFORM|CONFIGURE|CALL", "entity": "Order", "confidence": 0.0}]
}`;
}

export async function summarizeCode(symbol: CodeSymbol, context: { repoName: string; filePath: string; language: string; model: string; maxSourceChars: number; apiKey?: string; baseUrl?: string; providerPolicy?: ProviderPolicy; providerRuntime?: ProviderCallRuntime }): Promise<CodeSemanticSummary | undefined> {
  if (!context.apiKey) return undefined;
  const client = new OpenAI({ apiKey: context.apiKey, baseURL: context.baseUrl });
  const prompt = buildSummarizePrompt({
    repoName: context.repoName,
    filePath: context.filePath,
    language: context.language,
    kind: symbol.kind,
    name: symbol.name,
    signature: symbol.signature,
    source: symbol.source.slice(0, context.maxSourceChars)
  });
  const response = await runProviderCall({
    label: "llm.summarizeCode",
    runtime: context.providerRuntime,
    policy: context.providerPolicy,
    estimatedTokens: estimatedTokensFromText(prompt),
    fn: (signal) => client.chat.completions.create({
      model: context.model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0
    }, { signal })
  });
  const text = response.choices[0]?.message?.content ?? "";
  try {
    return JSON.parse(text) as CodeSemanticSummary;
  } catch {
    return { summary: text.slice(0, 500), responsibilities: [], inputs: [], outputs: [], sideEffects: [], domainTerms: [], operations: [] };
  }
}
