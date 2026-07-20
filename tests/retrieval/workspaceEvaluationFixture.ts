import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultConfig } from "../../src/config/loadConfig.js";
import type { EvaluationExecutionResult } from "../../src/core/retrieval/evaluation.js";
import type { RetrieveOptions } from "../../src/features/ask/options.js";
import type { RetrievalResult } from "../../src/features/ask/retrieve.js";
import { createClient, type AppClient } from "../../src/interfaces/sdk/client.js";

const fixtureRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "workspace-unified-retrieval");

export const EVALUATION_RETRIEVE_OPTIONS = Object.freeze({
  semantic: false,
  topK: 5,
  graphHops: 1,
  contextBudget: 16_000,
} as const);

export type WorkspaceEvaluationFixture = Readonly<{
  client: AppClient;
  directory: string;
  execute: (question: string, options: RetrieveOptions) => Promise<EvaluationExecutionResult>;
  close: () => Promise<void>;
}>;

export function projectEvaluationResult(result: RetrievalResult): EvaluationExecutionResult {
  return Object.freeze({
    rankedCanonicalIds: Object.freeze(result.loadedEvidence.map(({ candidate }) => candidate.canonicalId)),
    outcome: result.outcome,
    diagnostics: Object.freeze({
      providers: Object.freeze(Object.fromEntries(Object.entries(result.diagnostics.providers)
        .map(([name, provider]) => [name, Object.freeze({ status: provider.status })]))),
      queries: Object.freeze({
        total: result.diagnostics.queries.total,
        byRoute: result.diagnostics.queries.byRoute,
        sourceLoading: result.diagnostics.queries.sourceLoading,
      }),
    }),
  });
}

export async function createWorkspaceEvaluationFixture(): Promise<WorkspaceEvaluationFixture> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-retrieval-eval-"));
  const base = defaultConfig();
  const config = {
    ...base,
    systemName: "workspace-retrieval-evaluation",
    repos: ["api", "catalog", "worker"].map((name) => ({ name, path: path.join(fixtureRoot, name) })),
    include: [...base.include, "**/*.json"],
    graph: { ...base.graph, provider: "kuzu", path: path.join(directory, "graph") },
    retrieval: { lexical: { provider: "auto", scope: "workspace" as const } },
    embedding: { ...base.embedding, provider: "off" as const, level: "off" as const },
    indexing: { ...base.indexing, llmSummaryLevel: "off" as const },
  };
  let client: AppClient | undefined;
  try {
    client = await createClient({ cwd: directory, config, logger: { log() {}, warn() {}, error() {} } });
    await client.index({ changedOnly: false, writeMode: "auto" });
    const execute = async (question: string, options: RetrieveOptions): Promise<EvaluationExecutionResult> => {
      const result = await client!.retrieve(question, options);
      return projectEvaluationResult(result);
    };
    let closed = false;
    return Object.freeze({
      client,
      directory,
      execute,
      close: async () => {
        if (closed) return;
        closed = true;
        try {
          await client?.close();
        } finally {
          await fs.rm(directory, { recursive: true, force: true });
        }
      },
    });
  } catch (error) {
    try {
      await client?.close();
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
    throw error;
  }
}
