import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../src/config/loadConfig.js";
import type { GraphDB } from "../src/core/graph-model/db.js";
import { SCHEMA_INDEX_VERSION } from "../src/core/schema/model.js";

const mocks = vi.hoisted(() => ({
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
  beforeEach(() => vi.clearAllMocks());

  it("publishes all graph batches inside the final generation transaction", async () => {
    const config = {
      ...defaultConfig(),
      indexing: { ...defaultConfig().indexing, concurrency: 2 },
      repos: [{ name: "early", path: "/early" }, { name: "late", path: "/late" }]
    };
    const lifecycle: string[] = [];
    mocks.planIndexRun.mockResolvedValue({
      runPath: "per-repo",
      writeMode: "merge",
      repoConfigs: config.repos,
      initialRepoCount: 0,
      batchSize: 0,
      shouldUseCopyBulk: false,
      publicationMode: "full-snapshot"
    });
    mocks.autoDetectAndRegisterPlugins.mockResolvedValue({
      additionalIndexFilesByRepo: new Map(),
      activePluginSourceGlobsByRepo: new Map()
    });
    mocks.createIndexRunContext.mockResolvedValue({
      workspaceId: "workspace:test",
      logger: {},
      config,
      pendingIndexStateCommits: new Map()
    });
    mocks.prepareRepoIndex.mockImplementation(async ({ repoConfig }: { repoConfig: { name: string; path: string } }) => {
      lifecycle.push(`prepare:${repoConfig.name}`);
      const repo = { id: `repo:${repoConfig.name}`, name: repoConfig.name, path: repoConfig.path, remoteUrl: "", branch: "", commitSha: "", language: "typescript", indexedAt: "now" };
      return {
        repoConfig,
        repo,
        batchId: `prepare:${repoConfig.name}`,
        indexedAt: "now",
        scanParse: { repo, scannedFiles: [], parsedFiles: [], removedFileIds: [], activeFileIds: [], filesScanned: 1, filesChanged: 1 }
      };
    });
    mocks.runPerRepoIndex.mockImplementation(async ({ repoConfig }: { repoConfig: { name: string; path: string } }) => {
      lifecycle.push(`write:${repoConfig.name}`);
      return {
        filesScanned: 1,
        filesChanged: 1,
        repos: [{ id: `repo:${repoConfig.name}`, name: repoConfig.name, path: repoConfig.path, remoteUrl: "", branch: "", commitSha: "", language: "typescript", indexedAt: "now" }],
        batchId: `batch:${repoConfig.name}`
      };
    });
    mocks.runDependencyRebuild.mockImplementation(async () => { lifecycle.push("relations"); return 0; });

    let pendingGeneration = "";
    let pendingLeaseUntil = "";
    const query = vi.fn(async (cypher: string, params: Record<string, unknown> = {}) => {
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
    const db = {
      query,
      recoverIncompleteGraphWriteBatches: vi.fn(async () => []),
      commitGraphWriteBatch: vi.fn(async ({ batchId }: { batchId: string }) => lifecycle.push(`commit:${batchId}:${transactionDepth}`)),
      updateGraphWriteBatch: vi.fn(),
      transaction: vi.fn(async (callback: () => Promise<unknown>) => {
        transactionDepth += 1;
        lifecycle.push("transaction-start");
        try { return await callback(); } finally { lifecycle.push("transaction-end"); transactionDepth -= 1; }
      }),
      computePublicGraphStats: vi.fn(async () => ({ repos: 2, files: 0, codeNodes: 0, sectionNodes: 0, callEdges: 0, importEdges: 0, entities: 0 })),
      initializePublicGraphStats: vi.fn(),
      stats: vi.fn()
    } as unknown as GraphDB;

    const result = await runIndexing(db, config, { cwd: "/workspace", writeMode: "merge" });

    expect(result).toMatchObject({ filesScanned: 2, filesChanged: 2 });
    expect(lifecycle.indexOf("relations")).toBeLessThan(lifecycle.lastIndexOf("transaction-start"));
    expect(lifecycle).toContain("commit:batch:early:1");
    expect(lifecycle).toContain("commit:batch:late:1");
    expect(lifecycle.at(-1)).toBe("transaction-end");
  });
});
