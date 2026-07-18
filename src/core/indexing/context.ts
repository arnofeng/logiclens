import type { AppConfig } from "../../config/schema.js";
import type { RepoNode } from "../parsing/types.js";
import type { GraphDB } from "../graph-model/db.js";
import { resolveWorkspaceLexicalStore, type WorkspaceLexicalStore } from "../retrieval/provider.js";
import { deriveWorkspaceId } from "../workspace/identity.js";
import type { IndexLogger, IndexOptions } from "./types.js";

export type IndexWriteMode = NonNullable<IndexOptions["writeMode"]>;

export type IndexRunContext = {
  cwd: string;
  config: AppConfig;
  logger: IndexLogger;
  writeMode: IndexWriteMode;
  workspaceId: string;
  lexicalStore: WorkspaceLexicalStore;
  additionalIndexFilesByRepo: ReadonlyMap<string, readonly string[]>;
  activePluginSourceGlobsByRepo: ReadonlyMap<string, readonly string[]>;
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
  const { db, cwd, config, options: _options, logger, writeMode, additionalIndexFilesByRepo, activePluginSourceGlobsByRepo } = input;
  const workspaceId = deriveWorkspaceId(config.systemName);
  const lexicalStore = await resolveWorkspaceLexicalStore({
    db,
    graphProvider: config.graph.provider,
    lexicalProvider: config.retrieval.lexical.provider,
    scope: config.retrieval.lexical.scope
  });
  return {
    cwd,
    config,
    logger,
    writeMode,
    workspaceId,
    lexicalStore,
    additionalIndexFilesByRepo,
    activePluginSourceGlobsByRepo,
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
