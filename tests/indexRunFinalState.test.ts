import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GraphDB } from "../src/core/graph-model/db.js";
import { defaultConfig } from "../src/config/loadConfig.js";

const mocks = vi.hoisted(() => ({
  order: [] as string[],
  planIndexRun: vi.fn(),
  createIndexRunContext: vi.fn(),
  runPerRepoIndex: vi.fn(),
  runDependencyRebuild: vi.fn(),
  autoDetectAndRegisterPlugins: vi.fn()
}));

vi.mock("../src/core/indexing/planning.js", () => ({ planIndexRun: mocks.planIndexRun }));
vi.mock("../src/core/indexing/context.js", () => ({ createIndexRunContext: mocks.createIndexRunContext }));
vi.mock("../src/core/indexing/orchestrator.js", () => ({
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
    const config = { ...defaultConfig(), indexing: { ...defaultConfig().indexing, concurrency: 1 }, repos: [
      { name: "early", path: "/early" },
      { name: "late", path: "/late" }
    ] };
    const lexicalStore = {
      commitVersions: vi.fn(async () => { mocks.order.push("versions"); }),
      health: vi.fn(async () => {
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
      initialRepoCount: 0, batchSize: 0, shouldUseCopyBulk: false
    });
    mocks.autoDetectAndRegisterPlugins.mockResolvedValue({ additionalIndexFilesByRepo: new Map(), activePluginSourceGlobsByRepo: new Map() });
    mocks.createIndexRunContext.mockResolvedValue({ lexicalStore, workspaceId: "workspace:test", logger: {}, config });
    mocks.runPerRepoIndex.mockImplementation(async ({ repoConfig }: { repoConfig: { name: string; path: string } }) => ({
      filesScanned: 1,
      filesChanged: 1,
      repos: [{ id: `repo:${repoConfig.name}`, name: repoConfig.name, path: repoConfig.path, remoteUrl: "", branch: "", commitSha: "", language: "typescript", indexedAt: "now" }],
      batchId: `batch:${repoConfig.name}`,
      lexicalProjectionDurationMs: 2,
      lexicalWriteDurationMs: 3
    }));
    mocks.runDependencyRebuild.mockImplementation(async () => { mocks.order.push("relations"); return 0; });
    const query = vi.fn(async (_cypher: string, _params?: Record<string, unknown>) => { mocks.order.push("state-refresh"); return []; });
    const db = {
      query,
      stats: vi.fn().mockResolvedValue({ codeNodes: 0, sectionNodes: 0, callEdges: 0, importEdges: 0, entities: 0 })
    } as unknown as GraphDB;

    const result = await runIndexing(db, config, { cwd: "/workspace", writeMode: "merge" });

    expect(mocks.runPerRepoIndex).toHaveBeenCalledTimes(2);
    expect(mocks.order).toEqual(["relations", "versions", "health", "state-refresh"]);
    expect(query.mock.calls[0]![1]).toMatchObject({
      repoIds: ["repo:early", "repo:late"],
      lexicalDocumentCount: 19,
      lexicalProjectionSchemaVersion: "schema-current",
      lexicalTokenizerVersion: "tokenizer-current",
      lexicalIndexStatus: "healthy",
      lexicalProjectionDurationMs: 4,
      lexicalWriteDurationMs: 6
    });
    expect(result.lexicalDocumentCount).toBe(19);
  });
});
