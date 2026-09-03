import type { AppConfig } from "../../config/schema.js";
import type { RepoNode } from "../parsing/types.js";
import type { GraphDB } from "../graph-model/db.js";
import { deriveWorkspaceId } from "../workspace/identity.js";
import type { IndexLogger, IndexOptions } from "./types.js";
import type { IncrementalIndexMutationSet } from "./incrementalMutation.js";

export type IndexWriteMode = NonNullable<IndexOptions["writeMode"]>;

export type IndexRunContext = {
  cwd: string;
  config: AppConfig;
  logger: IndexLogger;
  writeMode: IndexWriteMode;
  workspaceId: string;
  activeGeneration?: string;
  activeRevision?: string;
  schemaGeneration?: string;
  targetGeneration?: string;
  publicationMode?: "full-snapshot" | "incremental";
  incrementalMutationSet?: IncrementalIndexMutationSet;
  onGraphBatchStaged?: (batchId: string) => void;
  pendingIndexStateCommits: Map<string, () => Promise<void>>;
  additionalIndexFilesByRepo: ReadonlyMap<string, readonly string[]>;
  activePluginSourceGlobsByRepo: ReadonlyMap<string, readonly string[]>;
  llm: {
    apiKey?: string;
    baseUrl?: string;
    summaryLevel: AppConfig["indexing"]["llmSummaryLevel"];
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

export async function createIndexRunContext(input: {
  db: GraphDB;
  cwd: string;
  config: AppConfig;
  options: IndexOptions;
  logger: IndexLogger;
  writeMode: IndexWriteMode;
  additionalIndexFilesByRepo: ReadonlyMap<string, readonly string[]>;
  activePluginSourceGlobsByRepo: ReadonlyMap<string, readonly string[]>;
}): Promise<IndexRunContext> {
  const { cwd, config, options: _options, logger, writeMode, additionalIndexFilesByRepo, activePluginSourceGlobsByRepo } = input;
  const workspaceId = deriveWorkspaceId(config.systemName);
  return {
    cwd,
    config,
    logger,
    writeMode,
    workspaceId,
    pendingIndexStateCommits: new Map(),
    additionalIndexFilesByRepo,
    activePluginSourceGlobsByRepo,
    llm: {
      apiKey: config.llm.apiKey ?? process.env.OPENAI_API_KEY,
      baseUrl: config.llm.baseUrl ?? process.env.OPENAI_BASE_URL,
      summaryLevel: config.indexing.llmSummaryLevel
    }
  };
}
