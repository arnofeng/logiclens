import { describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { configSchema } from "../src/config/schema.js";
import type { KuzuGraphDB } from "../src/core/graph-model/db.js";
import { runFactBuildPhase } from "../src/core/indexing/graphWrite.js";
import { resolveFullCopyLexicalReconcile, runFullCopyBulkIndex, sumCounts } from "../src/core/indexing/orchestrator.js";
import { planIndexRun } from "../src/core/indexing/planning.js";
import { runLlmSummaryPhase } from "../src/core/indexing/summaries.js";
import { createIndexRunContext, type IndexRunContext } from "../src/core/indexing/context.js";
import type { RepoNode } from "../src/core/parsing/types.js";
import type { WorkspaceLexicalStore } from "../src/core/retrieval/provider.js";
import { LEXICAL_PROJECTION_SCHEMA_VERSION } from "../src/core/retrieval/types.js";
import { SCHEMA_INDEX_VERSION } from "../src/core/schema/model.js";
import { registerGraphProvider } from "../src/core/graph-model/factory.js";
import { deriveWorkspaceId } from "../src/core/workspace/identity.js";
import { KuzuWorkspaceLexicalStore } from "../src/adapters/graph-db/kuzu/KuzuWorkspaceLexicalStore.js";
import { createWorkspaceEvaluationFixture } from "./retrieval/workspaceEvaluationFixture.js";

const repo: RepoNode = {
  id: "repo:phase-service",
  name: "phase-service",
  path: "fixtures/phase-service",
  remoteUrl: "",
  branch: "main",
  commitSha: "abc123",
  language: "typescript",
  indexedAt: "2026-06-22T00:00:00.000Z"
};

function configWithRepos(count: number) {
  return configSchema.parse({
    repos: Array.from({ length: count }, (_, index) => ({
      name: `service-${index + 1}`,
      path: `fixtures/service-${index + 1}`
    }))
  });
}

function dbWithRepoCount(count: number): KuzuGraphDB {
  return {
    query: vi.fn(async (cypher: string) => cypher.includes("SchemaGenerationState")
      ? count > 0
        ? [{
          activeGeneration: "generation:active",
          activeRevision: "revision:active",
          schemaIndexVersion: SCHEMA_INDEX_VERSION,
          lexicalProjectionVersion: LEXICAL_PROJECTION_SCHEMA_VERSION
        }]
        : []
      : [{ count }]),
    repoCount: vi.fn().mockResolvedValue(count)
  } as unknown as KuzuGraphDB;
}

function schemaReadyStore(): WorkspaceLexicalStore {
  return { ensureSchema: vi.fn().mockResolvedValue(undefined) } as unknown as WorkspaceLexicalStore;
}

describe("indexing phase coverage", () => {
  it.each([
    { documentCount: 0, reasons: [] as string[], expected: { reconcile: false, reason: "empty-workspace" } },
    { documentCount: 4, reasons: [] as string[], expected: { reconcile: true, reason: "active-documents" } },
    { documentCount: 0, reasons: ["lexical_stats_version_mismatch"], expected: { reconcile: true, reason: "unreliable-stats" } },
    { documentCount: Number.NaN, reasons: [] as string[], expected: { reconcile: true, reason: "invalid-document-count" } }
  ])("guards full-copy lexical reconciliation for count=$documentCount reasons=$reasons", async ({ documentCount, reasons, expected }) => {
    const base = configSchema.parse({});
    const pendingHealth = vi.fn().mockResolvedValue({
      providerVersion: "0.11.3",
      projectionSchemaVersion: "1",
      tokenizerVersion: "1",
      status: reasons.length > 0 ? "unhealthy" : "healthy",
      reasons,
      metrics: { documentCount, indexSizeBytes: 0 }
    });
    const ctx = {
      config: { ...base, graph: { ...base.graph, provider: "kuzu" } },
      workspaceId: "workspace:test",
      schemaGeneration: "generation:test",
      lexicalStore: { pendingHealth }
    } as unknown as IndexRunContext;

    await expect(resolveFullCopyLexicalReconcile(ctx)).resolves.toEqual(expected);
    expect(pendingHealth).toHaveBeenCalledWith({ workspaceId: "workspace:test", generation: "generation:test" });
  });

  it("keeps reconciliation enabled when the initial health check fails or the provider is not Kuzu", async () => {
    const base = configSchema.parse({});
    const failedHealth = vi.fn().mockRejectedValue(new Error("health unavailable"));
    const kuzu = {
      config: { ...base, graph: { ...base.graph, provider: "kuzu" } },
      workspaceId: "workspace:test",
      schemaGeneration: "generation:test",
      lexicalStore: { pendingHealth: failedHealth }
    } as unknown as IndexRunContext;
    expect(await resolveFullCopyLexicalReconcile(kuzu)).toEqual({ reconcile: true, reason: "health-check-failed" });

    const neo4jHealth = vi.fn();
    const neo4j = {
      config: { ...base, graph: { ...base.graph, provider: "neo4j" } },
      workspaceId: "workspace:test",
      schemaGeneration: "generation:test",
      lexicalStore: { pendingHealth: neo4jHealth }
    } as unknown as IndexRunContext;
    expect(await resolveFullCopyLexicalReconcile(neo4j)).toEqual({ reconcile: true, reason: "non-kuzu-provider" });
    expect(neo4jHealth).not.toHaveBeenCalled();
  });

  it("reports provider-derived performance and capacity metrics for full and changed-only indexing", async () => {
    const health = vi.spyOn(KuzuWorkspaceLexicalStore.prototype, "pendingHealth");
    const fixture = await createWorkspaceEvaluationFixture({ copyWorkspace: true });
    try {
      const full = fixture.fullIndexResult;
      await fs.appendFile(
        path.join(fixture.reposDirectory, "api", "src", "contracts", "orders.ts"),
        "\n// indexing phase changed-only marker\n",
        "utf8",
      );
      const changedOnly = await fixture.client.index({ changedOnly: true, writeMode: "merge" });
      const healthSnapshots = await Promise.all(health.mock.results
        .filter(({ type }) => type === "return")
        .map(({ value }) => value));

      for (const result of [full, changedOnly]) {
        expect(result).toEqual(expect.objectContaining({
          durationMs: expect.any(Number),
          lexicalDocumentCount: expect.any(Number),
          lexicalIndexSizeBytes: expect.any(Number),
          lexicalProjectionDurationMs: expect.any(Number),
          lexicalWriteDurationMs: expect.any(Number),
          lexicalIndexStatus: "healthy",
        }));
        for (const duration of [result.durationMs, result.lexicalProjectionDurationMs, result.lexicalWriteDurationMs]) {
          expect(Number.isFinite(duration) && duration >= 0).toBe(true);
        }
        expect(Number.isSafeInteger(result.lexicalDocumentCount) && result.lexicalDocumentCount >= 0).toBe(true);
        expect(Number.isSafeInteger(result.lexicalIndexSizeBytes) && result.lexicalIndexSizeBytes >= 0).toBe(true);
        expect(healthSnapshots.some((snapshot) =>
          snapshot.metrics.documentCount === result.lexicalDocumentCount
          && snapshot.metrics.indexSizeBytes === result.lexicalIndexSizeBytes
        )).toBe(true);
      }
      expect(changedOnly.filesChanged).toBeGreaterThan(0);
      expect(Object.keys(full)).toEqual(Object.keys(changedOnly));
    } finally {
      health.mockRestore();
      await fixture.close();
    }
  }, 45_000);

  it("binds one lexical store to the current db and derives workspace identity only from systemName", async () => {
    const db = dbWithRepoCount(0);
    const store = schemaReadyStore();
    const bindLexical = vi.fn(() => store);
    registerGraphProvider("index-context-auto", {
      factory: { open: vi.fn() },
      capabilities: { nativeFullText: { scope: "workspace", updateConsistency: "synchronous", supportsFieldBoost: false, supportsPrefix: false } },
      bindLexical
    });
    const config = configSchema.parse({ systemName: "  ＬＯＧＩＣ Café  ", graph: { provider: "index-context-auto" } });
    const ctx = await createIndexRunContext({
      db, cwd: "C:/one", config, options: {}, logger: {}, writeMode: "auto",
      additionalIndexFilesByRepo: new Map(), activePluginSourceGlobsByRepo: new Map()
    });
    expect(ctx.workspaceId).toBe(deriveWorkspaceId("  ＬＯＧＩＣ Café  "));
    expect(ctx.lexicalStore).toBe(store);
    expect(bindLexical).toHaveBeenCalledTimes(1);
    expect(bindLexical).toHaveBeenCalledWith(db);
    expect(store.ensureSchema).toHaveBeenCalledOnce();
  });

  it("keeps workspace identity stable across cwd and indexing entry modes", async () => {
    const db = dbWithRepoCount(0);
    registerGraphProvider("index-context-paths", {
      factory: { open: vi.fn() },
      capabilities: { nativeFullText: { scope: "workspace", updateConsistency: "synchronous", supportsFieldBoost: false, supportsPrefix: false } },
      bindLexical: () => schemaReadyStore()
    });
    const base = configSchema.parse({ systemName: "Cafe\u0301", graph: { provider: "index-context-paths" } });
    const contexts = await Promise.all([
      ["C:/batched", "auto", {}],
      ["D:/full-copy", "bulk", {}],
      ["E:/per-repo", "merge", { repo: "service-a" }],
      ["F:/changed", "auto", { changedOnly: true }]
    ].map(async ([cwd, writeMode, options]) => createIndexRunContext({
      db, cwd: cwd as string, config: base, options: options as {}, logger: {}, writeMode: writeMode as IndexRunContext["writeMode"],
      additionalIndexFilesByRepo: new Map(), activePluginSourceGlobsByRepo: new Map()
    })));
    expect(new Set(contexts.map((ctx) => ctx.workspaceId))).toEqual(new Set([deriveWorkspaceId("CAFÉ")]));
  });

  it("uses an explicit lexical provider registration with the indexing db", async () => {
    const db = dbWithRepoCount(0);
    const bindLexical = vi.fn(() => schemaReadyStore());
    registerGraphProvider("index-context-graph", { factory: { open: vi.fn() }, capabilities: {} });
    registerGraphProvider("index-context-explicit", {
      factory: { open: vi.fn() },
      capabilities: { nativeFullText: { scope: "workspace", updateConsistency: "transactional", supportsFieldBoost: true, supportsPrefix: true } },
      bindLexical
    });
    const config = configSchema.parse({ graph: { provider: "index-context-graph" }, retrieval: { lexical: { provider: "index-context-explicit", scope: "workspace" } } });
    await createIndexRunContext({ db, cwd: process.cwd(), config, options: {}, logger: {}, writeMode: "auto", additionalIndexFilesByRepo: new Map(), activePluginSourceGlobsByRepo: new Map() });
    expect(bindLexical).toHaveBeenCalledWith(db);
  });
  it("plans automatic batched full indexing for large repo sets", async () => {
    const planning = await planIndexRun({
      db: dbWithRepoCount(0),
      config: configWithRepos(11),
      options: { writeMode: "auto" }
    });

    expect(planning.runPath).toBe("batched-full");
    expect(planning.batchSize).toBe(10);
    expect(planning.shouldUseCopyBulk).toBe(true);
  });

  it("keeps repo planning scoped to explicitly requested repos", async () => {
    const planning = await planIndexRun({
      db: dbWithRepoCount(3),
      config: configWithRepos(3),
      options: { repo: "service-2", writeMode: "merge" }
    });

    expect(planning.runPath).toBe("per-repo");
    expect(planning.repoConfigs.map((repoConfig) => repoConfig.name)).toEqual(["service-2"]);
  });

  it("refuses legacy public data without a generation state and requires a clean full reindex", async () => {
    const db = {
      query: vi.fn(async (cypher: string) => cypher.includes("SchemaGenerationState") ? [] : [{ count: 1 }]),
      repoCount: vi.fn()
    } as unknown as KuzuGraphDB;
    await expect(planIndexRun({
      db,
      config: configWithRepos(1),
      options: { writeMode: "auto" }
    })).rejects.toThrow(/clean generated graph\/internal\/lexical artifacts/u);
    expect(db.repoCount).not.toHaveBeenCalled();
  });

  it("refuses an old lexical projection revision before changed-only planning", async () => {
    const db = {
      query: vi.fn(async (cypher: string) => cypher.includes("SchemaGenerationState") ? [{
        activeGeneration: "generation:active",
        activeRevision: "revision:active",
        schemaIndexVersion: SCHEMA_INDEX_VERSION,
        lexicalProjectionVersion: "1"
      }] : []),
      repoCount: vi.fn()
    } as unknown as KuzuGraphDB;
    await expect(planIndexRun({
      db,
      config: configWithRepos(1),
      options: { changedOnly: true, writeMode: "merge" }
    })).rejects.toThrow(/Lexical projection version 1.*clean generated graph\/internal\/lexical artifacts/iu);
    expect(db.repoCount).not.toHaveBeenCalled();
  });

  it("skips LLM summary work when summaries are disabled", async () => {
    const createProgressBar = vi.fn();
    const result = await runLlmSummaryPhase({
      parsedFiles: [],
      repos: [repo],
      config: configSchema.parse({ indexing: { llmSummaryLevel: "off" } }),
      llmSummaryLevel: "off",
      label: repo.name,
      batchId: "batch:summary",
      createProgressBar,
      errorLogger: () => {}
    });

    expect(result.parsedFiles).toEqual([]);
    expect(result.failuresByRepo.size).toBe(0);
    expect(createProgressBar).not.toHaveBeenCalled();
  });

  it("builds graph facts through the fact-build phase boundary", async () => {
    const progressEvents: Array<{ current: number; total: number; label?: string }> = [];
    const createProgressBar = vi.fn(() => ({
      tick: vi.fn(),
      update: vi.fn(),
      complete: vi.fn(),
      reporter: () => (event: { current: number; total: number; label?: string }) => progressEvents.push(event)
    }));
    const result = await runFactBuildPhase({
      batchId: "batch:facts",
      workspaceId: "workspace:indexing-phase",
      generation: "generation:indexing-phase",
      systemName: "indexing-phase",
      indexedAt: "2026-06-22T00:00:00.000Z",
      repos: [repo],
      parsedFiles: [],
      config: configSchema.parse({}),
      createProgressBar
    });

    expect(createProgressBar).toHaveBeenCalledWith("Contract extraction", 1);
    expect(progressEvents.length).toBeGreaterThan(0);
    expect(result.facts.batchId).toBe("batch:facts");
    expect(result.counts).toMatchObject({
      files: 0,
      code: 0,
      sections: 0,
      imports: 0,
      calls: 0
    });
  });

  it("reports resolve-call and framework progress when applicable", async () => {
    const progressEvents: Record<string, Array<{ current: number; total: number; label?: string }>> = {};
    const createProgressBar = vi.fn((label: string) => ({
      tick: vi.fn(),
      update: vi.fn(),
      complete: vi.fn(),
      reporter: () => (event: { current: number; total: number; label?: string }) => {
        const events = progressEvents[label] ?? [];
        events.push(event);
        progressEvents[label] = events;
      }
    }));
    const repoB = { ...repo, id: "repo:phase-service-b", name: "phase-service-b" };
    const parsed = {
      repoId: repo.id,
      fileId: "file:phase-service:src/app.ts",
      path: "src/app.ts",
      language: "typescript",
      hash: "h1",
      loc: 1,
      imports: [],
      symbols: [],
      calls: []
    } as any;
    const parsedB = {
      ...parsed,
      repoId: repoB.id,
      fileId: "file:phase-service-b:src/app.ts",
      hash: "h2"
    } as any;

    await runFactBuildPhase({
      batchId: "batch:facts-progress",
      workspaceId: "workspace:indexing-phase",
      generation: "generation:indexing-phase",
      systemName: "indexing-phase",
      indexedAt: "2026-06-22T00:00:00.000Z",
      repos: [repo, repoB],
      parsedFiles: [parsed, parsedB],
      config: configSchema.parse({}),
      createProgressBar
    });

    expect(createProgressBar).toHaveBeenCalledWith("Resolve calls", 1);
    expect(createProgressBar).toHaveBeenCalledWith("Framework detection", 2);
    expect(progressEvents["Resolve calls"]?.at(-1)).toMatchObject({ current: 8, total: 8 });
    expect(progressEvents["Framework detection"]?.at(-1)).toMatchObject({ current: 2, total: 2 });
  });

  it("aggregates scan/parse counts without depending on command state", () => {
    const counts = sumCounts([
      { filesScanned: 2, filesChanged: 1 } as any,
      { filesScanned: 3, filesChanged: 2 } as any
    ]);

    expect(counts).toEqual({ filesScanned: 5, filesChanged: 3 });
  });

  it("leaves failed state publication to the workspace generation coordinator", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "test-full-bulk-fail-"));
    try {
      const config = configSchema.parse({
        repos: [{ name: "empty-service", path: dir }],
        indexing: { llmSummaryLevel: "off" },
        embedding: { level: "off" }
      });
      const upsertIndexState = vi.fn();
      const db = {
        recoverIncompleteGraphWriteBatches: vi.fn().mockResolvedValue([]),
        beginGraphWriteBatch: vi.fn().mockResolvedValue(undefined),
        repoCount: vi.fn().mockResolvedValue(0),
        query: vi.fn().mockRejectedValue(new Error("bulk write failed")),
        failGraphWriteBatch: vi.fn().mockResolvedValue(undefined),
        cleanupGraphWriteBatch: vi.fn().mockResolvedValue(undefined),
        upsertIndexState
      } as unknown as KuzuGraphDB;
      const ctx: IndexRunContext = {
        cwd: process.cwd(),
        config,
        logger: { createProgressBar: () => ({ tick: () => {}, update: () => {}, complete: () => {}, reporter: () => () => {} }) },
        writeMode: "bulk",
        workspaceId: "workspace:test",
        schemaGeneration: "generation:test",
        pendingIndexStateCommits: new Map(),
        lexicalStore: { cleanupBatch: vi.fn().mockResolvedValue(undefined) } as unknown as WorkspaceLexicalStore,
        additionalIndexFilesByRepo: new Map(),
        activePluginSourceGlobsByRepo: new Map(),
        llm: { summaryLevel: "off" },
        embedding: { enabled: false }
      };

      await expect(runFullCopyBulkIndex({
        db,
        ctx,
        planning: {
          runPath: "full-copy-bulk",
          writeMode: "bulk",
          repoConfigs: config.repos,
          batchSize: 0,
          shouldUseCopyBulk: true,
          initialRepoCount: 0,
          publicationMode: "full-snapshot"
        },
        options: { writeMode: "bulk" }
      })).rejects.toThrow("bulk write failed");

      expect(upsertIndexState).not.toHaveBeenCalled();
      expect(db.failGraphWriteBatch).toHaveBeenCalledWith(expect.objectContaining({
        batchId: expect.any(String),
        awaitingCleanup: true
      }));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
