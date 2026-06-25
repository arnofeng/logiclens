import type { LlmSummaryLevel, LogicLensConfig } from "../config/schema.js";
import type { ParsedDocument, ParsedFile, ParsedGraphFile, RepoNode } from "../parsers/types.js";
import { summarizeCode } from "../semantic/summarizeCode.js";
import { summarizeDocumentSection } from "../semantic/summarizeDocument.js";
import { summarizeParsedGraphFile } from "../semantic/summarizeFile.js";
import { summarizeReposAndSystem } from "../semantic/summarizeGraph.js";
import { ProgressBar } from "../utils/progress.js";
import { createProviderCallRuntime, formatProviderStats, ProviderCallError, type ProviderCallRuntime } from "../resilience/providerPolicy.js";
import { runIndexPhase } from "./phases.js";

type SummaryProgress = {
  start(label: string): void;
  complete(label: string): void;
  done(): void;
};

type ProgressBarLike = {
  update(current: number, label?: string, total?: number, stepMs?: number): void;
  complete(): void;
};

type SummaryTask = {
  repoId: string;
  label: string;
  fn: () => Promise<void>;
};

export type SummaryFailureState = {
  failedCount: number;
  errors: string[];
  providerWarning?: string;
};

export type LlmSummaryPhaseResult = {
  parsedFiles: ParsedGraphFile[];
  failuresByRepo: Map<string, SummaryFailureState>;
  warning?: string;
};

function errorMessage(error: unknown): string {
  if (error instanceof ProviderCallError) return `${error.kind}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

async function runConcurrent<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>
): Promise<void> {
  const limit = Math.max(1, concurrency);
  let cursor = 0;
  async function run(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor++;
      if (index >= items.length) break;
      const item = items[index]!;
      await worker(item, index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => run()));
}

function createSummaryProgress(
  repoName: string,
  enabled: boolean,
  totalCount = 1,
  createBar: (label: string, total: number) => ProgressBarLike = (label, total) => new ProgressBar(label, total)
): SummaryProgress | undefined {
  if (!enabled) return undefined;
  const bar = createBar(`LLM summaries ${repoName}`, totalCount);
  let current = 0;
  const startTimes = new Map<string, number>();
  return {
    start(label) {
      startTimes.set(label, Date.now());
      bar.update(current, label, totalCount);
    },
    complete(label) {
      current += 1;
      const startTime = startTimes.get(label);
      const stepMs = startTime ? Date.now() - startTime : undefined;
      bar.update(current, label, totalCount, stepMs);
    },
    done() {
      if (totalCount > 0) bar.complete();
    }
  };
}

export async function summarizeGraphWithProgress(
  input: Parameters<typeof summarizeReposAndSystem>[0],
  label: string,
  createBar?: (label: string, total: number) => ProgressBarLike
): ReturnType<typeof summarizeReposAndSystem> {
  const progress = createSummaryProgress(label, input.options.semantic && Boolean(input.options.apiKey), 1, createBar);
  progress?.start("repo/system summaries");
  try {
    return await summarizeReposAndSystem(input);
  } finally {
    progress?.complete("repo/system summaries");
    progress?.done();
  }
}

export function canUseLlm(level: LlmSummaryLevel, apiKey?: string): boolean {
  return level !== "off" && Boolean(apiKey);
}

export function shouldSummarizeGraphWithLlm(level: LlmSummaryLevel): boolean {
  return level === "repo" || level === "file" || level === "node";
}

function isParsedDocument(file: ParsedGraphFile): file is ParsedDocument {
  return file.language === "markdown";
}

function isParsedCodeFile(file: ParsedGraphFile): file is ParsedFile {
  return !isParsedDocument(file);
}

function assignFileSummary(parsedFile: ParsedGraphFile, summary: string | undefined): void {
  if (!summary) return;
  if (isParsedDocument(parsedFile)) {
    for (const section of parsedFile.sections) section.summary = summary;
    return;
  }
  for (const symbol of parsedFile.symbols) {
    if (!symbol.summary) {
      symbol.summary = summary;
    }
  }
}

function buildSummaryTasks(inputs: {
  parsedFiles: ParsedGraphFile[];
  repoResolver: (repoId: string) => RepoNode | undefined;
  config: LogicLensConfig;
  openAiApiKey?: string;
  openAiBaseUrl?: string;
  llmSummaryLevel: LlmSummaryLevel;
  providerRuntime?: ProviderCallRuntime;
}): SummaryTask[] {
  const { parsedFiles, repoResolver, config, openAiApiKey, openAiBaseUrl, llmSummaryLevel, providerRuntime } = inputs;
  const tasks: SummaryTask[] = [];

  for (const parsedFile of parsedFiles) {
    const repo = repoResolver(parsedFile.repoId);
    if (!repo) continue;

    if (llmSummaryLevel === "file") {
      tasks.push({
        repoId: parsedFile.repoId,
        label: parsedFile.path,
        fn: async () => {
          const summary = await summarizeParsedGraphFile(parsedFile, {
            repoName: repo.name,
            model: config.llm.model,
            maxSourceChars: config.llm.maxSourceCharsPerNode,
            apiKey: openAiApiKey,
            baseUrl: openAiBaseUrl,
            providerRuntime,
            providerPolicy: { retry: config.llm.retry, budget: config.llm.budget, rateLimit: config.llm.rateLimit }
          });
          assignFileSummary(parsedFile, summary?.summary);
        }
      });
    } else if (llmSummaryLevel === "node") {
      if (isParsedDocument(parsedFile)) {
        for (const section of parsedFile.sections) {
          tasks.push({
            repoId: parsedFile.repoId,
            label: `${parsedFile.path}#${section.heading}`,
            fn: async () => {
              const summary = await summarizeDocumentSection(section, {
                repoName: repo.name,
                filePath: parsedFile.path,
                model: config.llm.model,
                maxSourceChars: config.llm.maxSourceCharsPerNode,
                apiKey: openAiApiKey,
                baseUrl: openAiBaseUrl,
                providerRuntime,
                providerPolicy: { retry: config.llm.retry, budget: config.llm.budget, rateLimit: config.llm.rateLimit }
              });
              section.summary = summary?.summary;
            }
          });
        }
      } else if (isParsedCodeFile(parsedFile)) {
        for (const symbol of parsedFile.symbols) {
          if (symbol.summary) continue;
          tasks.push({
            repoId: parsedFile.repoId,
            label: `${parsedFile.path}#${symbol.qualifiedName || symbol.name}`,
            fn: async () => {
              const summary = await summarizeCode(symbol, {
                repoName: repo.name,
                filePath: parsedFile.path,
                language: parsedFile.language,
                model: config.llm.model,
                maxSourceChars: config.llm.maxSourceCharsPerNode,
                apiKey: openAiApiKey,
                baseUrl: openAiBaseUrl,
                providerRuntime,
                providerPolicy: { retry: config.llm.retry, budget: config.llm.budget, rateLimit: config.llm.rateLimit }
              });
              if (summary?.summary) {
                symbol.summary = summary.summary;
              }
            }
          });
        }
      }
    }
  }

  return tasks;
}

function formatSummaryWarning(failuresByRepo: Map<string, SummaryFailureState>): string | undefined {
  const totals = [...failuresByRepo.values()].reduce((state, failure) => {
    state.failedCount += failure.failedCount;
    state.errors.push(...failure.errors);
    return state;
  }, { failedCount: 0, errors: [] as string[] });
  const providerWarnings = [...new Set([...failuresByRepo.values()].map((failure) => failure.providerWarning).filter(Boolean))];
  if (totals.failedCount === 0) return providerWarnings.length > 0 ? providerWarnings.join("\n\n") : undefined;
  const failureWarning = `Failed to generate ${totals.failedCount} LLM summaries. First few errors:\n${totals.errors.slice(0, 3).join("\n")}`;
  return [failureWarning, ...providerWarnings].join("\n\n");
}

export async function runLlmSummaryPhase(input: {
  parsedFiles: ParsedGraphFile[];
  repos: RepoNode[];
  config: LogicLensConfig;
  openAiApiKey?: string;
  openAiBaseUrl?: string;
  llmSummaryLevel: LlmSummaryLevel;
  label: string;
  batchId?: string;
  createProgressBar: (label: string, total: number) => ProgressBarLike;
  errorLogger: (...args: any[]) => void;
}): Promise<LlmSummaryPhaseResult> {
  const { parsedFiles, repos, config, openAiApiKey, openAiBaseUrl, llmSummaryLevel, label, batchId, createProgressBar, errorLogger } = input;
  const result = await runIndexPhase({ phase: "llm-summary", batchId }, async () => {
    const failuresByRepo = new Map<string, SummaryFailureState>();
    if (!canUseLlm(llmSummaryLevel, openAiApiKey) || parsedFiles.length === 0) {
      return { parsedFiles, failuresByRepo };
    }

    // Summary generation enriches parsed objects in place, but individual LLM
    // failures are warnings so graph writes and state commits can still finish.
    const providerRuntime = createProviderCallRuntime({
      retry: config.llm.retry,
      budget: config.llm.budget,
      rateLimit: config.llm.rateLimit
    });
    const tasks = buildSummaryTasks({
      parsedFiles,
      repoResolver: (repoId) => repos.find((repo) => repo.id === repoId),
      config,
      openAiApiKey,
      openAiBaseUrl,
      llmSummaryLevel,
      providerRuntime
    });
    const summaryProgress = createSummaryProgress(label, true, tasks.length, createProgressBar);

    if (tasks.length > 0) {
      await runConcurrent(tasks, config.indexing.concurrency, async (task) => {
        summaryProgress?.start(task.label);
        try {
          await task.fn();
        } catch (error) {
          errorLogger(`Failed to summarize ${task.label}:`, error);
          let failState = failuresByRepo.get(task.repoId);
          if (!failState) {
            failState = { failedCount: 0, errors: [] };
            failuresByRepo.set(task.repoId, failState);
          }
          failState.failedCount++;
          failState.errors.push(`${task.label}: ${errorMessage(error)}`);
        } finally {
          summaryProgress?.complete(task.label);
        }
      });
      summaryProgress?.done();
    }

    const providerWarning = formatProviderStats("LLM summary", providerRuntime.stats);
    if (providerWarning) {
      for (const repo of repos) {
        const failState = failuresByRepo.get(repo.id) ?? { failedCount: 0, errors: [] };
        failState.providerWarning = providerWarning;
        failuresByRepo.set(repo.id, failState);
      }
    }

    return {
      parsedFiles,
      failuresByRepo,
      warning: formatSummaryWarning(failuresByRepo)
    };
  });

  return result.result;
}
