import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GraphDB } from "../src/core/graph-model/db.js";
import { defaultConfig } from "../src/config/loadConfig.js";
import { SCHEMA_INDEX_VERSION } from "../src/core/schema/model.js";

const mocks = vi.hoisted(() => ({
  order: [] as string[],
  planIndexRun: vi.fn(),
  createIndexRunContext: vi.fn(),
  prepareRepoIndex: vi.fn(),
  runPerRepoIndex: vi.fn(),
  runDependencyRebuild: vi.fn(),
  autoDetectAndRegisterPlugins: vi.fn()
}));

vi.mock("../src/core/indexing/planning.js", () => ({ planIndexRun: mocks.planIndexRun }));
vi.mock("../src/core/indexing/context.js", () => ({ createIndexRunContext: mocks.createIndexRunContext }));
vi.mock("../src/core/indexing/orchestrator.js", () => ({
  prepareRepoIndex: mocks.prepareRepoIndex,
  runBatchedFullIndex: vi.fn(),
  runFullCopyBulkIndex: vi.fn(),
  runPerRepoIndex: mocks.runPerRepoIndex,
  runDependencyRebuild: mocks.runDependencyRebuild
}));
vi.mock("../src/core/plugins/register.js", () => ({ autoDetectAndRegisterPlugins: mocks.autoDetectAndRegisterPlugins }));

import { runIndexing } from "../src/core/indexing/run.js";

describe("index run final workspace state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.order.length = 0;
  });

  it("refreshes every repo in the ordinary multi-repo route after relation and version commits", async () => {
    const config = { ...defaultConfig(), indexing: { ...defaultConfig().indexing, concurrency: 2 }, repos: [
      { name: "early", path: "/early" },
      { name: "late", path: "/late" }
    ] };
    const lexicalStore = {
      commitVersions: vi.fn(async () => { mocks.order.push("versions"); }),
      initializeGeneration: vi.fn(),
      deleteGeneration: vi.fn(),
      cleanupBatch: vi.fn(),
      pendingHealth: vi.fn(async () => {
        mocks.order.push("health");
        return {
          providerVersion: "provider",
          projectionSchemaVersion: "schema-current",
          tokenizerVersion: "tokenizer-current",
          status: "healthy" as const,
          reasons: [],
          metrics: { documentCount: 19, indexSizeBytes: 100 }
        };
      })
    };
    mocks.planIndexRun.mockResolvedValue({
      runPath: "per-repo", writeMode: "merge", repoConfigs: config.repos,
      initialRepoCount: 0, batchSize: 0, shouldUseCopyBulk: false,
      publicationMode: "full-snapshot"
    });
    mocks.autoDetectAndRegisterPlugins.mockResolvedValue({ additionalIndexFilesByRepo: new Map(), activePluginSourceGlobsByRepo: new Map() });
    mocks.createIndexRunContext.mockResolvedValue({ lexicalStore, workspaceId: "workspace:test", logger: {}, config });
    let activePreparations = 0;
    let maxActivePreparations = 0;
    const lifecycle: string[] = [];
    mocks.prepareRepoIndex.mockImplementation(async ({ repoConfig }: { repoConfig: { name: string; path: string } }) => {
      lifecycle.push(`prepare-start:${repoConfig.name}`);
      activePreparations += 1;
      maxActivePreparations = Math.max(maxActivePreparations, activePreparations);
      await new Promise((resolve) => setTimeout(resolve, 10));
      activePreparations -= 1;
      lifecycle.push(`prepare-end:${repoConfig.name}`);
      const repo = { id: `repo:${repoConfig.name}`, name: repoConfig.name, path: repoConfig.path, remoteUrl: "", branch: "", commitSha: "", language: "typescript", indexedAt: "now" };
      return {
        repoConfig,
        repo,
        batchId: `prepare:${repoConfig.name}`,
        indexedAt: "now",
        scanParse: {
          repo,
          scannedFiles: [],
          parsedFiles: [],
          removedFileIds: [],
          activeFileIds: [],
          filesScanned: 1,
          filesChanged: 1
        }
      };
    });
    let activeWrites = 0;
    let maxActiveWrites = 0;
    mocks.runPerRepoIndex.mockImplementation(async ({ repoConfig }: { repoConfig: { name: string; path: string } }) => {
      lifecycle.push(`write-start:${repoConfig.name}`);
      activeWrites += 1;
      maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
      await new Promise((resolve) => setTimeout(resolve, 5));
      activeWrites -= 1;
      lifecycle.push(`write-end:${repoConfig.name}`);
      return {
        filesScanned: 1,
        filesChanged: 1,
        repos: [{ id: `repo:${repoConfig.name}`, name: repoConfig.name, path: repoConfig.path, remoteUrl: "", branch: "", commitSha: "", language: "typescript", indexedAt: "now" }],
        batchId: `batch:${repoConfig.name}`,
        lexicalProjectionDurationMs: 2,
        lexicalWriteDurationMs: 3
      };
    });
    mocks.runDependencyRebuild.mockImplementation(async () => { mocks.order.push("relations"); return 0; });
    let pendingGeneration = "";
    let pendingLeaseUntil = "";
    const query = vi.fn(async (cypher: string, params: Record<string, unknown> = {}) => {
      mocks.order.push("state-refresh");
      if (cypher.includes("SET s.pendingGeneration=$generation")) {
        pendingGeneration = String(params.generation);
        pendingLeaseUntil = String(params.leaseUntil);
        return [];
      }
      if (cypher.includes("SET s.pendingLeaseUntil=$leaseUntil")) {
        pendingLeaseUntil = String(params.leaseUntil);
        return [];
      }
      if (cypher.includes("RETURN s.activeGeneration") && cypher.includes("s.pendingGeneration")) {
        return [{ activeGeneration: "", pendingGeneration, pendingLeaseUntil }];
      }
      if (cypher.includes("RETURN s.pendingGeneration")) {
        return pendingGeneration ? [{ pendingGeneration, pendingLeaseUntil }] : [];
      }
      if (cypher.includes("g.parentGeneration AS parentGeneration")) {
        return [{ parentGeneration: "", schemaIndexVersion: SCHEMA_INDEX_VERSION, status: "pending" }];
      }
      if (cypher.includes("RETURN s.activeGeneration")) return [];
      return cypher.includes("RETURN g.status") ? [{ status: "pending" }] : [];
    });
    let transactionDepth = 0;
    let statsComputeTransactionDepth = -1;
    let statsInitializeTransactionDepth = -1;
    const db = {
      query,
      recoverIncompleteGraphWriteBatches: vi.fn(async () => []),
      commitGraphWriteBatch: vi.fn(async (input: { batchId: string }) => { lifecycle.push(`batch-commit:${input.batchId}`); }),
      updateGraphWriteBatch: vi.fn(),
      transaction: vi.fn(async (callback: () => Promise<unknown>) => {
        const outermost = transactionDepth === 0;
        transactionDepth += 1;
        if (outermost) lifecycle.push("transaction-start");
        try {
          const result = await callback();
          if (outermost) lifecycle.push("transaction-commit");
          return result;
        } finally {
          transactionDepth -= 1;
        }
      }),
      computePublicGraphStats: vi.fn(async () => {
        statsComputeTransactionDepth = transactionDepth;
        return {
          repos: 0,
          files: 0,
          codeNodes: 0,
          sectionNodes: 0,
          callEdges: 0,
          importEdges: 0,
          entities: 0
        };
      }),
      initializePublicGraphStats: vi.fn(async () => {
        statsInitializeTransactionDepth = transactionDepth;
      }),
      stats: vi.fn().mockResolvedValue({ codeNodes: 0, sectionNodes: 0, callEdges: 0, importEdges: 0, entities: 0 })
    } as unknown as GraphDB;

    const result = await runIndexing(db, config, { cwd: "/workspace", writeMode: "merge" });

    expect(mocks.runPerRepoIndex).toHaveBeenCalledTimes(2);
    expect(maxActivePreparations).toBe(2);
    expect(maxActiveWrites).toBe(2);
    const finalTransactionStart = lifecycle.lastIndexOf("transaction-start");
    expect(finalTransactionStart).toBeGreaterThan(lifecycle.lastIndexOf("prepare-end:early"));
    expect(finalTransactionStart).toBeGreaterThan(lifecycle.lastIndexOf("prepare-end:late"));
    expect(finalTransactionStart).toBeGreaterThan(lifecycle.lastIndexOf("write-end:early"));
    expect(finalTransactionStart).toBeGreaterThan(lifecycle.lastIndexOf("write-end:late"));
    expect(lifecycle.indexOf("batch-commit:batch:early")).toBeGreaterThan(finalTransactionStart);
    expect(lifecycle.indexOf("batch-commit:batch:late")).toBeGreaterThan(finalTransactionStart);
    const finalTransactionCommit = lifecycle.lastIndexOf("transaction-commit");
    expect(lifecycle.indexOf("batch-commit:batch:early")).toBeLessThan(finalTransactionCommit);
    expect(lifecycle.indexOf("batch-commit:batch:late")).toBeLessThan(finalTransactionCommit);
    expect(statsComputeTransactionDepth).toBe(0);
    expect(statsInitializeTransactionDepth).toBeGreaterThan(0);
    expect(lifecycle.at(-1)).toBe("transaction-commit");
    expect(mocks.order.filter((item) => item !== "state-refresh")).toEqual(["relations", "versions", "health"]);
    const stateRefresh = query.mock.calls.find(([, params]) => params && "repoIds" in params);
    expect(stateRefresh?.[1]).toMatchObject({
      repoIds: ["repo:early", "repo:late"],
      lexicalDocumentCount: 19,
      lexicalIndexSizeBytes: 100,
      lexicalProjectionSchemaVersion: "schema-current",
      lexicalTokenizerVersion: "tokenizer-current",
      lexicalIndexStatus: "healthy",
      lexicalProjectionDurationMs: 4,
      lexicalWriteDurationMs: 6
    });
    expect(result.lexicalDocumentCount).toBe(19);
    expect(result.lexicalIndexSizeBytes).toBe(100);
  });

  it("does not roll back an active generation when committed lexical journal cleanup fails", async () => {
    const config = {
      ...defaultConfig(),
      repos: [{ name: "repo", path: "/repo" }]
    };
    const cleanupBatch = vi.fn();
    const warn = vi.fn();
    let failCommittedCleanup = true;
    let exposeCommittedGc = false;
    const commitBatch = vi.fn(async () => {
      if (failCommittedCleanup) throw new Error("journal cleanup failed");
    });
    const lexicalStore = {
      commitVersions: vi.fn(),
      initializeGeneration: vi.fn(),
      deleteGeneration: vi.fn(),
      cleanupBatch,
      commitBatch,
      pendingHealth: vi.fn(async () => ({
        providerVersion: "provider",
        projectionSchemaVersion: "schema-current",
        tokenizerVersion: "tokenizer-current",
        status: "healthy" as const,
        reasons: [],
        metrics: { documentCount: 1, indexSizeBytes: 2 }
      }))
    };
    mocks.autoDetectAndRegisterPlugins.mockResolvedValue({
      additionalIndexFilesByRepo: new Map(),
      activePluginSourceGlobsByRepo: new Map()
    });
    mocks.createIndexRunContext.mockResolvedValue({
      lexicalStore,
      workspaceId: "workspace:cleanup-failure",
      logger: { warn },
      config
    });
    mocks.prepareRepoIndex.mockImplementation(async ({ repoConfig }: { repoConfig: { name: string; path: string } }) => {
      const repo = {
        id: "repo:repo",
        name: repoConfig.name,
        path: repoConfig.path,
        remoteUrl: "",
        branch: "",
        commitSha: "",
        language: "typescript",
        indexedAt: "now"
      };
      return {
        repoConfig,
        repo,
        batchId: "batch:cleanup-failure",
        indexedAt: "now",
        scanParse: {
          repo,
          scannedFiles: [],
          parsedFiles: [],
          removedFileIds: [],
          activeFileIds: [],
          filesScanned: 1,
          filesChanged: 1
        }
      };
    });
    mocks.runPerRepoIndex.mockResolvedValue({
      filesScanned: 1,
      filesChanged: 1,
      repos: [{
        id: "repo:repo",
        name: "repo",
        path: "/repo",
        remoteUrl: "",
        branch: "",
        commitSha: "",
        language: "typescript",
        indexedAt: "now"
      }],
      batchId: "batch:cleanup-failure",
      lexicalProjectionDurationMs: 1,
      lexicalWriteDurationMs: 1
    });
    mocks.runDependencyRebuild.mockResolvedValue(0);

    let activeGeneration = "generation:parent";
    let activeRevision = "generation:parent";
    mocks.planIndexRun.mockImplementation(async () => ({
      runPath: "per-repo",
      writeMode: "merge",
      repoConfigs: config.repos,
      initialRepoCount: 1,
      batchSize: 0,
      shouldUseCopyBulk: false,
      publicationMode: "full-snapshot",
      activeGeneration,
      activeRevision
    }));
    let pendingGeneration = "";
    let pendingLeaseUntil = "";
    let pendingParentGeneration = "";
    let pendingParentRevision = "";
    const pendingGenerations = new Map<string, { parent: string; status: "pending" | "active" | "superseded" }>();
    const query = vi.fn(async (cypher: string, params: Record<string, unknown> = {}) => {
      if (cypher.includes("MATCH (b:GraphWriteBatch)")) {
        return exposeCommittedGc ? [{ batchId: "batch:cleanup-failure" }] : [];
      }
      if (cypher.includes("SET s.pendingGeneration=$generation")) {
        pendingGeneration = String(params.generation);
        pendingLeaseUntil = String(params.leaseUntil);
        pendingParentGeneration = String(params.parentGeneration ?? "");
        pendingParentRevision = String(params.parentRevision ?? "");
        return [];
      }
      if (cypher.includes("SET s.pendingLeaseUntil=$leaseUntil")) {
        pendingLeaseUntil = String(params.leaseUntil);
        return [];
      }
      if (cypher.includes("RETURN s.activeGeneration") && cypher.includes("s.pendingGeneration")) {
        return [{
          activeGeneration,
          activeRevision,
          pendingGeneration,
          pendingRevision: "",
          pendingParentGeneration,
          pendingParentRevision,
          pendingLeaseUntil
        }];
      }
      if (cypher.includes("RETURN s.pendingGeneration")) {
        return pendingGeneration ? [{ pendingGeneration, pendingLeaseUntil }] : [];
      }
      if (cypher.includes("RETURN s.activeGeneration")) {
        return [{ activeGeneration }];
      }
      if (cypher.includes("RETURN g.id AS id")) {
        return pendingGenerations.has(String(params.generation))
          ? [{ id: params.generation }]
          : [];
      }
      if (cypher.includes("MERGE (g:SchemaGeneration")) {
        pendingGenerations.set(String(params.id), {
          parent: String(params.parentGeneration),
          status: "pending"
        });
        return [];
      }
      if (cypher.includes("RETURN g.status")) {
        const generation = pendingGenerations.get(String(params.generation));
        return generation ? [{ status: generation.status }] : [];
      }
      if (cypher.includes("g.parentGeneration AS parentGeneration")) {
        const generation = pendingGenerations.get(String(params.generation));
        return generation
          ? [{ parentGeneration: generation.parent, schemaIndexVersion: SCHEMA_INDEX_VERSION, status: generation.status }]
          : [];
      }
      if (cypher.includes("SET g.status=$status")) {
        const generation = pendingGenerations.get(String(params.generation));
        if (generation) generation.status = "active";
        return [];
      }
      if (cypher.includes("SET s.workspaceId=$workspaceId, s.activeGeneration=$generation")) {
        activeGeneration = String(params.generation);
        activeRevision = String(params.revision);
        pendingGeneration = "";
        pendingParentGeneration = "";
        pendingParentRevision = "";
        pendingLeaseUntil = "";
        return [];
      }
      if (cypher.includes("DELETE g")) {
        pendingGenerations.delete(String(params.generation));
      }
      return [];
    });
    const cleanupGraphWriteBatch = vi.fn();
    const db = {
      query,
      cleanupGraphWriteBatch,
      recoverIncompleteGraphWriteBatches: vi.fn(async () => []),
      commitGraphWriteBatch: vi.fn(),
      updateGraphWriteBatch: vi.fn(),
      deletePublicGraphGeneration: vi.fn(),
      transaction: vi.fn(async (callback: () => Promise<unknown>) => callback()),
      computePublicGraphStats: vi.fn().mockResolvedValue({
        repos: 0,
        files: 0,
        codeNodes: 0,
        sectionNodes: 0,
        callEdges: 0,
        importEdges: 0,
        entities: 0
      }),
      initializePublicGraphStats: vi.fn(),
      stats: vi.fn().mockResolvedValue({
        codeNodes: 0,
        sectionNodes: 0,
        callEdges: 0,
        importEdges: 0,
        entities: 0
      })
    } as unknown as GraphDB;

    await expect(runIndexing(db, config, { cwd: "/workspace", writeMode: "merge", logger: { warn } })).resolves.toMatchObject({
      filesScanned: 1,
      filesChanged: 1
    });

    expect(commitBatch).toHaveBeenCalledWith({
      workspaceId: "workspace:cleanup-failure",
      batchId: "batch:cleanup-failure"
    });
    expect(activeGeneration).not.toBe("generation:parent");
    expect(pendingGenerations.get(activeGeneration)?.status).toBe("active");
    expect(cleanupBatch).not.toHaveBeenCalled();
    expect(cleanupGraphWriteBatch).not.toHaveBeenCalled();
    expect(query.mock.calls.some(([cypher]) => String(cypher).includes("DELETE g"))).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Committed lexical journal cleanup deferred"));

    failCommittedCleanup = false;
    exposeCommittedGc = true;
    commitBatch.mockClear();
    (db.updateGraphWriteBatch as ReturnType<typeof vi.fn>).mockClear();
    await expect(runIndexing(db, config, { cwd: "/workspace", writeMode: "merge", logger: { warn } })).resolves.toBeDefined();
    expect(commitBatch).toHaveBeenCalledWith({
      workspaceId: "workspace:cleanup-failure",
      batchId: "batch:cleanup-failure"
    });
    expect(db.updateGraphWriteBatch).toHaveBeenCalledWith(expect.objectContaining({
      batchId: "batch:cleanup-failure",
      completedStage: "gc-complete"
    }));
    expect(pendingGenerations.get(activeGeneration)?.status).toBe("active");
  });
});
