import OpenAI from "openai";
import type { ParsedDocument, ParsedFile, ParsedGraphFile } from "../parsers/types.js";
import {
  estimatedTokensFromText,
  runProviderCall,
  type ProviderCallRuntime,
  type ProviderPolicy
} from "../shared/providerPolicy.js";

export type FileSemanticSummary = {
  summary: string;
  domainTerms: string[];
};

function isParsedDocument(file: ParsedGraphFile): file is ParsedDocument {
  return file.language === "markdown";
}

function sourcePreview(file: ParsedFile, maxSourceChars: number): string {
  const chunks = file.symbols.map((symbol) => [
    `${symbol.kind} ${symbol.qualifiedName || symbol.name}`,
    symbol.signature,
    symbol.source
  ].filter(Boolean).join("\n"));
  return chunks.join("\n\n").slice(0, maxSourceChars);
}

function markdownPreview(file: ParsedDocument, maxSourceChars: number): string {
  return file.sections.map((section) => [
    `${"#".repeat(section.level)} ${section.heading}`,
    section.text
  ].join("\n")).join("\n\n").slice(0, maxSourceChars);
}

export function buildSummarizeFilePrompt(input: { repoName: string; file: ParsedGraphFile; maxSourceChars: number }): string {
  if (isParsedDocument(input.file)) {
    return `You are summarizing one documentation file for a cross-repository semantic dependency and impact graph.

Return strict JSON only.

Repository: ${input.repoName}
File: ${input.file.path}
Language: markdown
Headings: ${input.file.sections.map((section) => section.heading).join(", ")}

Document text:
${markdownPreview(input.file, input.maxSourceChars)}

Extract:
{
  "summary": "one concise paragraph explaining what this file documents",
  "domainTerms": ["Order", "Payment", "OrderCreatedEvent"]
}`;
  }

  return `You are summarizing one source file for a cross-repository semantic dependency and impact graph.

Return strict JSON only.

Repository: ${input.repoName}
File: ${input.file.path}
Language: ${input.file.language}
Imports: ${input.file.imports.map((item) => item.module).join(", ")}
Symbols: ${input.file.symbols.map((symbol) => `${symbol.kind} ${symbol.qualifiedName || symbol.name}`).join(", ")}

Source excerpts:
\`\`\`${input.file.language}
${sourcePreview(input.file, input.maxSourceChars)}
\`\`\`

Extract:
{
  "summary": "one concise paragraph explaining this file's role and important behavior",
  "domainTerms": ["Order", "Payment", "User"]
}`;
}

export async function summarizeParsedGraphFile(file: ParsedGraphFile, context: { repoName: string; model: string; maxSourceChars: number; apiKey?: string; baseUrl?: string; providerPolicy?: ProviderPolicy; providerRuntime?: ProviderCallRuntime }): Promise<FileSemanticSummary | undefined> {
  if (!context.apiKey) return undefined;
  const client = new OpenAI({ apiKey: context.apiKey, baseURL: context.baseUrl });
  const prompt = buildSummarizeFilePrompt({
    repoName: context.repoName,
    file,
    maxSourceChars: context.maxSourceChars
  });
  const response = await runProviderCall({
    label: "llm.summarizeFile",
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
    return JSON.parse(text) as FileSemanticSummary;
  } catch {
    return { summary: text.slice(0, 500), domainTerms: [] };
  }
}
