import type { AppConfig } from "../../config/schema.js";
import type { RepoNode } from "../parsing/types.js";
import type { IndexLogger, IndexOptions } from "./types.js";

export type IndexWriteMode = NonNullable<IndexOptions["writeMode"]>;

export type IndexRunContext = {
  cwd: string;
  config: AppConfig;
  logger: IndexLogger;
  writeMode: IndexWriteMode;
  additionalIndexFilesByRepo: ReadonlyMap<string, readonly string[]>;
  llm: {
    apiKey?: string;
    baseUrl?: string;
    summaryLevel: AppConfig["indexing"]["llmSummaryLevel"];
  };
  embedding: {
    enabled: boolean;
  };
};

export type IndexRepoPlan = {
  repo: RepoNode;
  batchId: string;
  indexedAt: string;
};

export type IndexBatchPlan = {
  batchNumber: number;
  batchCount: number;
  batchId: string;
  indexedAt: string;
  repos: RepoNode[];
};

export function createIndexRunContext(input: {
  cwd: string;
  config: AppConfig;
  options: IndexOptions;
  logger: IndexLogger;
  writeMode: IndexWriteMode;
  additionalIndexFilesByRepo: ReadonlyMap<string, readonly string[]>;
}): IndexRunContext {
  const { cwd, config, options: _options, logger, writeMode, additionalIndexFilesByRepo } = input;
  return {
    cwd,
    config,
    logger,
    writeMode,
    additionalIndexFilesByRepo,
    llm: {
      apiKey: config.llm.apiKey ?? process.env.OPENAI_API_KEY,
      baseUrl: config.llm.baseUrl ?? process.env.OPENAI_BASE_URL,
      summaryLevel: config.indexing.llmSummaryLevel
    },
    embedding: {
      enabled: config.embedding.level !== "off" && config.embedding.provider !== "off"
    }
  };
}
