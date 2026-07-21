import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { KuzuWorkspaceLexicalStore } from "../src/adapters/graph-db/kuzu/KuzuWorkspaceLexicalStore.js";
import { defaultConfig } from "../src/config/loadConfig.js";
import {
  LEXICAL_PROJECTION_SCHEMA_VERSION,
  TOKENIZER_VERSION,
} from "../src/core/retrieval/types.js";
import { deriveWorkspaceId } from "../src/core/workspace/identity.js";
import { parseRenderRef } from "../src/core/retrieval/renderRef.js";
import type { RetrievalResult } from "../src/features/ask/retrieve.js";
import { NO_RELIABLE_EVIDENCE } from "../src/features/ask/answer.js";
import { createClient, type AppClient } from "../src/interfaces/sdk/client.js";
import { FileWatcher } from "../src/features/watch/watcher.js";

const sourceFixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "workspace-unified-retrieval",
);
const OFFLINE_ENVIRONMENT_VARIABLES = [
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "AZURE_OPENAI_API_KEY",
  "AZURE_OPENAI_ENDPOINT",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "COHERE_API_KEY",
  "VOYAGE_API_KEY",
] as const;
const RETRIEVE_OPTIONS = Object.freeze({
  semantic: false,
  topK: 10,
  graphHops: 1,
  contextBudget: 16_000,
} as const);

type OfflineEnvironment = Readonly<{
  restore: () => void;
  fetchSpy: ReturnType<typeof vi.spyOn>;
}>;

async function createIsolatedWorkspace(): Promise<{
  directory: string;
  reposDirectory: string;
}> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-workspace-e2e-"));
  const reposDirectory = path.join(directory, "repos");
  await fs.cp(sourceFixture, reposDirectory, { recursive: true });
  return { directory, reposDirectory };
}

function withOfflineEnvironment(): OfflineEnvironment {
  const original = new Map<string, string | undefined>();
  for (const name of OFFLINE_ENVIRONMENT_VARIABLES) {
    original.set(name, process.env[name]);
    delete process.env[name];
  }
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(
    new Error("workspace retrieval E2E must remain offline"),
  );
  return {
    fetchSpy,
    restore: () => {
      fetchSpy.mockRestore();
      for (const [name, value] of original) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    },
  };
}

function canonicalRanking(result: RetrievalResult): string[] {
  return result.loadedEvidence.map(({ candidate }) => candidate.canonicalId);
}

function assertSafeEvidence(result: RetrievalResult, workspaceId: string): void {
  expect(result.loadedEvidence.length).toBeGreaterThan(0);
  expect(new Set(result.selectedCandidates.map(({ canonicalId }) => canonicalId)).size)
    .toBe(result.selectedCandidates.length);
  expect(new Set(result.loadedEvidence.map(({ document }) => document.id)).size)
    .toBe(result.loadedEvidence.length);
  for (const evidence of result.loadedEvidence) {
    expect(evidence.document.workspaceId).toBe(workspaceId);
    expect(evidence.document.repoId).toMatch(/^repo:(api|catalog|worker)$/u);
    expect(evidence.document.path).toBeTruthy();
    expect(evidence.document.renderRef).toBeTruthy();
    expect(evidence.document.active).toBe(true);
    const parsed = parseRenderRef(evidence.document.renderRef, workspaceId);
    expect(parsed.repoId).toBe(evidence.document.repoId);
    expect(parsed.path).toBe(evidence.document.path);
    expect(parsed.canonicalId).toBe(evidence.candidate.canonicalId);
  }
  expect(result.diagnostics.sourceLoading.rejectionCounts.inactive_document ?? 0).toBe(0);
  expect(result.diagnostics.sourceLoading.rejectionCounts.cross_workspace ?? 0).toBe(0);
  expect(result.diagnostics.sourceLoading.rejectionCounts.unlocatable ?? 0).toBe(0);
}

async function waitForWatchIdle(client: AppClient, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const status = client.getWatchStatus();
    const watcher = (client as unknown as { watcher?: FileWatcher }).watcher;
    const syncRunning = Boolean(
      (watcher as unknown as { syncPromise?: Promise<void> } | undefined)?.syncPromise,
    );
    if (
      status.pendingFiles.length === 0
      && !status.indexQueue.running
      && status.indexQueue.pendingJobs.length === 0
      && !syncRunning
    ) return;
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for watch synchronization: ${JSON.stringify({
        pendingFiles: status.pendingFiles,
        pausedRepos: status.pausedRepos,
        indexQueue: status.indexQueue,
        syncRunning,
      })}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("local workspace unified retrieval release", () => {
  it("survives the complete offline Kuzu workspace lifecycle with deterministic retrieval", async () => {
    const { directory, reposDirectory } = await createIsolatedWorkspace();
    const offline = withOfflineEnvironment();
    const searchSpy = vi.spyOn(KuzuWorkspaceLexicalStore.prototype, "search");
    const healthSpy = vi.spyOn(KuzuWorkspaceLexicalStore.prototype, "health");
    const base = defaultConfig();
    const systemName = "workspace-unified-retrieval-e2e";
    const workspaceId = deriveWorkspaceId(systemName);
    const config = {
      ...base,
      systemName,
      repos: ["api", "catalog", "worker"].map((name) => ({
        name,
        path: path.join(reposDirectory, name),
      })),
      include: [...base.include, "**/*.json"],
      graph: { ...base.graph, provider: "kuzu", path: path.join(directory, "graph.kuzu") },
      retrieval: { lexical: { provider: "auto", scope: "workspace" as const } },
      embedding: { ...base.embedding, provider: "off" as const, level: "off" as const },
      llm: { ...base.llm, apiKey: undefined, baseUrl: undefined },
      indexing: {
        ...base.indexing,
        concurrency: 1,
        llmSummaryLevel: "off" as const,
      },
    };
    let client: AppClient | undefined;

    const retrieveOnce = async (question: string): Promise<RetrievalResult> => {
      const searchesBefore = searchSpy.mock.calls.length;
      const result = await client!.retrieve(question, RETRIEVE_OPTIONS);
      expect(searchSpy.mock.calls.length - searchesBefore, question).toBe(1);
      expect(result.diagnostics.providers.lexical.status).toBe("succeeded");
      expect(result.diagnostics.routes.lexical).toMatchObject({
        status: "succeeded",
        queryCount: 1,
      });
      expect(result.diagnostics.providers.semantic.status).toBe("disabled");
      assertSafeEvidence(result, workspaceId);
      return result;
    };

    try {
      client = await createClient({
        cwd: directory,
        config,
        logger: { log() {}, warn() {}, error() {} },
      });

      const initialStatus = await client.getLexicalProviderStatus({ refresh: true });
      expect(initialStatus.status).toBe("unavailable");
      expect(initialStatus.reasonCodes.length).toBeGreaterThan(0);
      expect(JSON.stringify(initialStatus)).not.toContain(directory);
      expect(JSON.stringify(initialStatus)).not.toMatch(/CatalogException|BinderException|RuntimeException/u);

      const fullIndex = await client.index({ changedOnly: false, writeMode: "auto" });
      expect(fullIndex.filesScanned).toBeGreaterThan(0);
      expect(fullIndex.filesChanged).toBeGreaterThan(0);
      expect(fullIndex.lexicalDocumentCount).toBeGreaterThan(0);
      expect(fullIndex.lexicalIndexSizeBytes).toBeGreaterThan(0);
      expect(fullIndex.lexicalIndexStatus).toBe("healthy");
      expect(fullIndex.lexicalProjectionSchemaVersion).toBe(LEXICAL_PROJECTION_SCHEMA_VERSION);
      expect(fullIndex.lexicalTokenizerVersion).toBe(TOKENIZER_VERSION);

      const healthAfterIndex = healthSpy.mock.calls.length;
      const readyAfterIndex = await client.getLexicalProviderStatus();
      expect(healthSpy.mock.calls.length - healthAfterIndex).toBe(1);
      expect(readyAfterIndex).toMatchObject({
        effectiveProvider: "kuzu",
        status: "ready",
        projectionSchemaVersion: LEXICAL_PROJECTION_SCHEMA_VERSION,
        tokenizerVersion: TOKENIZER_VERSION,
        indexStatus: "healthy",
      });
      const cachedHealthCount = healthSpy.mock.calls.length;

      const representativeQuestions = [
        "Which HTTP endpoint serves /orders?",
        "库存契约中的稳定标识是什么？",
        "哪个 worker 消费 orders.created 事件？",
        "Where is CreateOrderRequest declared?",
      ];
      const representativeRepos = new Set<string>();
      for (const question of representativeQuestions) {
        const result = await retrieveOnce(question);
        for (const { document } of result.loadedEvidence) representativeRepos.add(document.repoId);
      }
      expect(representativeRepos).toEqual(new Set(["repo:api", "repo:catalog", "repo:worker"]));
      expect(healthSpy.mock.calls.length).toBe(cachedHealthCount);

      await retrieveOnce("orders.created worker API event");

      const controlQuestion = "Where is CreateOrderRequest declared?";
      const controlFirst = canonicalRanking(await retrieveOnce(controlQuestion));
      const controlSecond = canonicalRanking(await retrieveOnce(controlQuestion));
      const controlThird = canonicalRanking(await retrieveOnce(controlQuestion));
      expect(controlSecond).toEqual(controlFirst);
      expect(controlThird).toEqual(controlFirst);

      let searchesBefore = searchSpy.mock.calls.length;
      const answer = await client.ask(controlQuestion, RETRIEVE_OPTIONS);
      expect(searchSpy.mock.calls.length - searchesBefore).toBe(1);
      expect(answer).not.toBe(NO_RELIABLE_EVIDENCE);
      expect(answer).toContain("[C1]");
      expect(answer).toMatch(/repo:(api|catalog|worker)\/[A-Za-z0-9_./-]+/u);
      expect(answer).not.toMatch(/searchableText|sourceHash|batchId|\btokens\b/u);

      const refusalQuestion = "Which service owns the payment ledger?";
      searchesBefore = searchSpy.mock.calls.length;
      const refusal = await client.retrieve(refusalQuestion, RETRIEVE_OPTIONS);
      expect(searchSpy.mock.calls.length - searchesBefore).toBe(1);
      expect(refusal.loadedEvidence).toEqual([]);
      expect(refusal.selectedCandidates).toEqual([]);
      expect(refusal.outcome).toBe("no_results");
      searchesBefore = searchSpy.mock.calls.length;
      const refusalAnswer = await client.ask(refusalQuestion, RETRIEVE_OPTIONS);
      expect(searchSpy.mock.calls.length - searchesBefore).toBe(1);
      expect(refusalAnswer).toBe(NO_RELIABLE_EVIDENCE);

      const changedMarker = "ChangedOnlyCatalogProjectionMarker";
      const changedRelativePath = "src/CatalogItemDTO.ts";
      const changedPath = path.join(reposDirectory, "catalog", changedRelativePath);
      await fs.appendFile(
        changedPath,
        `\nexport function ${changedMarker}(item: CatalogItemSchema): string {\n  return item.catalog_item_id;\n}\n`,
        "utf8",
      );
      const changedIndex = await client.index({ changedOnly: true, writeMode: "merge" });
      expect(changedIndex.filesChanged).toBeGreaterThan(0);
      expect(changedIndex.lexicalIndexStatus).toBe("healthy");
      const healthAfterChangedIndex = healthSpy.mock.calls.length;
      expect(await client.getLexicalProviderStatus()).toMatchObject({ status: "ready", indexStatus: "healthy" });
      expect(healthSpy.mock.calls.length - healthAfterChangedIndex).toBe(1);
      const changedResult = await retrieveOnce(changedMarker);
      const changedEvidence = changedResult.loadedEvidence.filter(
        ({ document }) => document.qualifiedName === changedMarker,
      );
      expect(changedEvidence).toHaveLength(1);
      expect(changedEvidence[0]!.document).toMatchObject({
        repoId: "repo:catalog",
        path: changedRelativePath,
        active: true,
      });
      expect(changedEvidence[0]!.document.sourceHash).toMatch(/^[a-f0-9]+$/u);
      expect(await fs.readFile(changedPath, "utf8")).toContain(changedMarker);
      expect(canonicalRanking(await retrieveOnce(controlQuestion))).toEqual(controlFirst);

      const watchMarker = "WatchedWorkerProjectionMarker";
      const watchRelativePath = "src/handlers/e2eWatched.ts";
      const watchPath = path.join(reposDirectory, "worker", watchRelativePath);
      expect(await client.watch({ debounceMs: 20, syncConcurrency: 1, catchUp: "off" })).toBe(true);
      await fs.writeFile(
        watchPath,
        `export function ${watchMarker}(eventName: string): boolean {\n  return eventName === "orders.created";\n}\n`,
        "utf8",
      );
      const watcher = (client as unknown as { watcher?: FileWatcher }).watcher;
      expect(watcher).toBeDefined();
      await watcher!.ingestEventForTests("worker", watchRelativePath);
      await waitForWatchIdle(client);
      const watchStatus = client.getWatchStatus();
      expect(watchStatus.degraded).toBe(false);
      expect(watchStatus.pausedRepos).toEqual([]);
      const healthAfterWatchIndex = healthSpy.mock.calls.length;
      expect(await client.getLexicalProviderStatus()).toMatchObject({ status: "ready", indexStatus: "healthy" });
      expect(healthSpy.mock.calls.length - healthAfterWatchIndex).toBe(1);
      const watchResult = await retrieveOnce(watchMarker);
      expect(watchResult.loadedEvidence).toEqual(expect.arrayContaining([
        expect.objectContaining({
          document: expect.objectContaining({
            qualifiedName: watchMarker,
            repoId: "repo:worker",
            path: watchRelativePath,
            active: true,
          }),
        }),
      ]));
      expect(canonicalRanking(await retrieveOnce("库存契约中的稳定标识是什么？")).length)
        .toBeGreaterThan(0);
      client.unwatch();
      expect(client.isWatching()).toBe(false);

      const beforeCloseControl = canonicalRanking(await retrieveOnce(controlQuestion));
      const beforeCloseChanged = canonicalRanking(await retrieveOnce(changedMarker));
      const beforeCloseWatch = canonicalRanking(await retrieveOnce(watchMarker));
      await client.close();
      client = undefined;

      client = await createClient({
        cwd: directory,
        config,
        logger: { log() {}, warn() {}, error() {} },
      });
      expect(await client.getLexicalProviderStatus({ refresh: true })).toMatchObject({
        status: "ready",
        indexStatus: "healthy",
      });
      expect(canonicalRanking(await retrieveOnce(controlQuestion))).toEqual(beforeCloseControl);
      expect(canonicalRanking(await retrieveOnce(changedMarker))).toEqual(beforeCloseChanged);
      expect(canonicalRanking(await retrieveOnce(watchMarker))).toEqual(beforeCloseWatch);

      const rebuild = await client.index({ changedOnly: false, writeMode: "auto" });
      expect(rebuild.filesScanned).toBeGreaterThan(0);
      expect(rebuild.filesChanged).toBeGreaterThan(0);
      expect(rebuild.lexicalIndexStatus).toBe("healthy");
      expect(rebuild.lexicalDocumentCount).toBeGreaterThan(0);
      expect(rebuild.lexicalIndexSizeBytes).toBeGreaterThan(0);
      const healthAfterRebuild = healthSpy.mock.calls.length;
      expect(await client.getLexicalProviderStatus()).toMatchObject({ status: "ready", indexStatus: "healthy" });
      expect(healthSpy.mock.calls.length - healthAfterRebuild).toBe(1);
      const afterRebuildControl = canonicalRanking(await retrieveOnce(controlQuestion));
      expect(afterRebuildControl).toEqual(beforeCloseControl);
      expect(canonicalRanking(await retrieveOnce(controlQuestion))).toEqual(afterRebuildControl);
      expect(canonicalRanking(await retrieveOnce(changedMarker))).toEqual(beforeCloseChanged);
      expect(canonicalRanking(await retrieveOnce(watchMarker))).toEqual(beforeCloseWatch);
      expect(offline.fetchSpy).not.toHaveBeenCalled();
    } finally {
      const networkCallCount = offline.fetchSpy.mock.calls.length;
      try {
        client?.unwatch();
        await client?.close();
      } finally {
        healthSpy.mockRestore();
        searchSpy.mockRestore();
        offline.restore();
        try {
          await fs.rm(directory, { recursive: true, force: true });
        } finally {
          expect(networkCallCount).toBe(0);
        }
      }
    }
  }, 120_000);
});
