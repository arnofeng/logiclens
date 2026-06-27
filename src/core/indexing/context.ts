import type { LogicLensConfig } from "../../config/schema.js";
import type { RepoNode } from "../parsing/types.js";
import type { IndexLogger, IndexOptions } from "./types.js";

export type IndexWriteMode = NonNullable<IndexOptions["writeMode"]>;

export type IndexRunContext = {
  cwd: string;
  config: LogicLensConfig;
  logger: IndexLogger;
  writeMode: IndexWriteMode;
  llm: {
    apiKey?: string;
    baseUrl?: string;
    summaryLevel: LogicLensConfig["indexing"]["llmSummaryLevel"];
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
  config: LogicLensConfig;
  options: IndexOptions;
  logger: IndexLogger;
  writeMode: IndexWriteMode;
}): IndexRunContext {
  const { cwd, config, options, logger, writeMode } = input;
  return {
    cwd,
    config,
    logger,
    writeMode,
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
