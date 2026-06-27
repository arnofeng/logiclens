import OpenAI from "openai";
import type { CrossRepoExtraction } from "../contracts/extraction/crossRepoContracts.js";
import type { ParsedDocument, ParsedFile, ParsedGraphFile, RepoNode } from "../parsing/types.js";
import {
  createProviderCallRuntime,
  estimatedTokensFromText,
  runProviderCall,
  ProviderCallError,
  type ProviderCallRuntime,
  type ProviderPolicy
} from "../../shared/providerPolicy.js";

export type GraphSummaryOptions = {
  semantic: boolean;
  model: string;
  maxSourceChars: number;
  apiKey?: string;
  baseUrl?: string;
  providerPolicy?: ProviderPolicy;
  providerRuntime?: ProviderCallRuntime;
};

export type RepoSummaryInput = {
  repo: RepoNode;
  codeNames: string[];
  sectionHeadings: string[];
  entityNames: string[];
  contractKeys: string[];
  dependencyLines: string[];
};

function isParsedDocument(file: ParsedGraphFile): file is ParsedDocument {
  return file.language === "markdown";
}

function isParsedFile(file: ParsedGraphFile): file is ParsedFile {
  return file.language !== "markdown";
}

function uniq(values: string[], limit: number): string[] {
  return [...new Set(values.filter(Boolean))].slice(0, limit);
}

function localRepoSummary(input: RepoSummaryInput): string {
  const parts = [
    `${input.repo.name} contains ${input.codeNames.length} indexed code symbols and ${input.sectionHeadings.length} documentation sections.`,
    input.codeNames.length ? `Key code: ${uniq(input.codeNames, 8).join(", ")}.` : "",
    input.sectionHeadings.length ? `Docs: ${uniq(input.sectionHeadings, 5).join(", ")}.` : "",
    input.contractKeys.length ? `Contracts: ${uniq(input.contractKeys, 8).join(", ")}.` : "",
    input.dependencyLines.length ? `Cross-repo relations: ${uniq(input.dependencyLines, 8).join("; ")}.` : ""
  ];
  return parts.filter(Boolean).join(" ");
}

function localSystemSummary(repoSummaries: Array<{ repo: RepoNode; summary: string }>, crossRepo: CrossRepoExtraction): string {
  const dependencyLines = crossRepo.repoDependencies.map((edge) => `${edge.fromRepoId} -> ${edge.toRepoId} (${edge.dependencyType})`);
  return [
    `System contains ${repoSummaries.length} indexed repositories.`,
    repoSummaries.map((item) => `${item.repo.name}: ${item.summary}`).join(" "),
    dependencyLines.length ? `Cross-repo dependencies: ${uniq(dependencyLines, 12).join("; ")}.` : "No cross-repo dependencies were detected."
  ].join(" ");
}

export function buildRepoSummaryInputs(repos: RepoNode[], parsedFiles: ParsedGraphFile[], crossRepo: CrossRepoExtraction): RepoSummaryInput[] {
  return repos.map((repo) => {
    const repoFiles = parsedFiles.filter((file) => file.repoId === repo.id);
    const codeNames = repoFiles.filter(isParsedFile).flatMap((file) => file.symbols.map((symbol) => symbol.qualifiedName || symbol.name));
    const sectionHeadings = repoFiles.filter(isParsedDocument).flatMap((file) => file.sections.map((section) => section.heading));
    const contractIds = new Set(crossRepo.repoContracts.filter((edge) => edge.repoId === repo.id).map((edge) => edge.contractId));
    const contractKeys = crossRepo.contracts.filter((contract) => contractIds.has(contract.id)).map((contract) => `${contract.kind}:${contract.key}`);
    const dependencyLines = crossRepo.repoDependencies
      .filter((edge) => edge.fromRepoId === repo.id || edge.toRepoId === repo.id)
      .map((edge) => `${edge.fromRepoId} -> ${edge.toRepoId} (${edge.dependencyType})`);
    return { repo, codeNames, sectionHeadings, entityNames: [], contractKeys, dependencyLines };
  });
}

export function buildRepoSummaryPrompt(input: RepoSummaryInput): string {
  return `You are summarizing one repository for a cross-repository code graph.

Return one concise paragraph. Mention repository role, important code/documentation signals, contracts, and cross-repository dependencies.

Repository: ${input.repo.name}
Code symbols: ${uniq(input.codeNames, 30).join(", ")}
Documentation sections: ${uniq(input.sectionHeadings, 20).join(", ")}
Contracts: ${uniq(input.contractKeys, 30).join(", ")}
Cross-repo relations: ${uniq(input.dependencyLines, 30).join("; ")}`;
}

export function buildSystemSummaryPrompt(repoSummaries: Array<{ repo: RepoNode; summary: string }>, crossRepo: CrossRepoExtraction): string {
  return `You are summarizing a cross-repository system from a code graph.

Return one concise paragraph. Mention repository roles, major dependencies, and likely core business flow.

Repositories:
${repoSummaries.map((item) => `- ${item.repo.name}: ${item.summary}`).join("\n")}

Cross-repo dependencies:
${crossRepo.repoDependencies.map((edge) => `- ${edge.fromRepoId} -> ${edge.toRepoId}: ${edge.dependencyType}`).join("\n")}`;
}

async function summarizeWithOpenAI(prompt: string, options: GraphSummaryOptions): Promise<string | undefined> {
  if (!options.semantic || !options.apiKey) return undefined;
  const client = new OpenAI({ apiKey: options.apiKey, baseURL: options.baseUrl });
  const content = prompt.slice(0, options.maxSourceChars);
  try {
    const response = await runProviderCall({
      label: "llm.summarizeGraph",
      runtime: options.providerRuntime,
      policy: options.providerPolicy,
      estimatedTokens: estimatedTokensFromText(content),
      fn: (signal) => client.chat.completions.create({
        model: options.model,
        messages: [{ role: "user", content }],
        temperature: 0
      }, { signal })
    });
    return response.choices[0]?.message?.content?.trim().slice(0, 4000);
  } catch (error) {
    if (error instanceof ProviderCallError) return undefined;
    throw error;
  }
}

export async function summarizeReposAndSystem(input: {
  repos: RepoNode[];
  parsedFiles: ParsedGraphFile[];
  crossRepo: CrossRepoExtraction;
  options: GraphSummaryOptions;
}): Promise<{ repoSummaries: Array<{ repoId: string; summary: string }>; systemSummary: string }> {
  const repoInputs = buildRepoSummaryInputs(input.repos, input.parsedFiles, input.crossRepo);
  const options = {
    ...input.options,
    providerRuntime: input.options.providerRuntime ?? createProviderCallRuntime(input.options.providerPolicy)
  };
  const repoSummaries: Array<{ repo: RepoNode; summary: string }> = [];
  for (const repoInput of repoInputs) {
    const fallback = localRepoSummary(repoInput);
    const llmSummary = await summarizeWithOpenAI(buildRepoSummaryPrompt(repoInput), options);
    repoSummaries.push({ repo: repoInput.repo, summary: llmSummary || fallback });
  }
  const localSystem = localSystemSummary(repoSummaries, input.crossRepo);
  const llmSystem = await summarizeWithOpenAI(buildSystemSummaryPrompt(repoSummaries, input.crossRepo), options);
  return {
    repoSummaries: repoSummaries.map((item) => ({ repoId: item.repo.id, summary: item.summary })),
    systemSummary: llmSystem || localSystem
  };
}
