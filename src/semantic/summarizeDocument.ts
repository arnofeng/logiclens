import OpenAI from "openai";
import type { DocSection } from "../parsers/types.js";
import {
  estimatedTokensFromText,
  runProviderCall,
  type ProviderCallRuntime,
  type ProviderPolicy
} from "../providers/openaiProvider.js";

export type DocumentSectionSummary = {
  summary: string;
  domainTerms: string[];
};

export function buildSummarizeDocumentPrompt(input: { repoName: string; filePath: string; heading: string; text: string }): string {
  return `You are analyzing documentation for a multi-repository semantic dependency and impact graph.

Return strict JSON only.

Repository: ${input.repoName}
File: ${input.filePath}
Section: ${input.heading}

Markdown section text:
${input.text}

Extract:
{
  "summary": "one or two sentences explaining what this documentation section describes",
  "domainTerms": ["Order", "Payment", "OrderCreatedEvent"]
}`;
}

export async function summarizeDocumentSection(section: DocSection, context: { repoName: string; filePath: string; model: string; maxSourceChars: number; apiKey?: string; baseUrl?: string; providerPolicy?: ProviderPolicy; providerRuntime?: ProviderCallRuntime }): Promise<DocumentSectionSummary | undefined> {
  if (!context.apiKey) return undefined;
  const client = new OpenAI({ apiKey: context.apiKey, baseURL: context.baseUrl });
  const prompt = buildSummarizeDocumentPrompt({
    repoName: context.repoName,
    filePath: context.filePath,
    heading: section.heading,
    text: section.text.slice(0, context.maxSourceChars)
  });
  const response = await runProviderCall({
    label: "llm.summarizeDocument",
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
    return JSON.parse(text) as DocumentSectionSummary;
  } catch {
    return { summary: text.slice(0, 500), domainTerms: [] };
  }
}
