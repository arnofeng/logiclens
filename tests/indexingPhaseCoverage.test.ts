import { describe, expect, it, vi } from "vitest";
import { configSchema } from "../src/config/schema.js";
import type { GraphDB } from "../src/core/graph-model/db.js";
import { createIndexRunContext } from "../src/core/indexing/context.js";
import { runFactBuildPhase } from "../src/core/indexing/graphWrite.js";
import { sumCounts } from "../src/core/indexing/orchestrator.js";
import { planIndexRun } from "../src/core/indexing/planning.js";
import { runLlmSummaryPhase } from "../src/core/indexing/summaries.js";
import type { RepoNode } from "../src/core/parsing/types.js";
import { SCHEMA_INDEX_VERSION } from "../src/core/schema/model.js";
import { deriveWorkspaceId } from "../src/core/workspace/identity.js";

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

function dbWithRepoCount(count: number): GraphDB {
  return {
    query: vi.fn(async (cypher: string) => cypher.includes("SchemaGenerationState")
      ? count > 0
        ? [{ activeGeneration: "generation:active", activeRevision: "revision:active", schemaIndexVersion: SCHEMA_INDEX_VERSION }]
        : []
      : [{ count }]),
    repoCount: vi.fn().mockResolvedValue(count)
  } as unknown as GraphDB;
}

describe("indexing phase coverage", () => {
  it("derives workspace identity without binding a search provider", async () => {
    const config = configSchema.parse({ systemName: "  ＬＯＧＩＣ Café  " });
    const ctx = await createIndexRunContext({
      db: dbWithRepoCount(0),
      cwd: "C:/workspace",
      config,
      options: {},
      logger: {},
      writeMode: "auto",
      additionalIndexFilesByRepo: new Map(),
      activePluginSourceGlobsByRepo: new Map()
    });
    expect(ctx.workspaceId).toBe(deriveWorkspaceId("  ＬＯＧＩＣ Café  "));
    expect(Object.keys(ctx)).not.toContain("lexicalStore");
    expect(Object.keys(ctx)).not.toContain("embedding");
  });

  it("plans automatic batched full indexing for large repo sets", async () => {
    const planning = await planIndexRun({
      db: dbWithRepoCount(0),
      config: configWithRepos(11),
      options: { writeMode: "auto" }
    });
    expect(planning).toMatchObject({ runPath: "batched-full", batchSize: 10, shouldUseCopyBulk: true });
  });

  it("keeps repo planning scoped to explicitly requested repos", async () => {
    const planning = await planIndexRun({
      db: dbWithRepoCount(3),
      config: configWithRepos(3),
      options: { repo: "service-2", writeMode: "merge" }
    });
    expect(planning.runPath).toBe("per-repo");
    expect(planning.repoConfigs.map((item) => item.name)).toEqual(["service-2"]);
  });

  it("refuses legacy public data without generation state", async () => {
    const db = {
      query: vi.fn(async (cypher: string) => cypher.includes("SchemaGenerationState") ? [] : [{ count: 1 }]),
      repoCount: vi.fn()
    } as unknown as GraphDB;
    await expect(planIndexRun({ db, config: configWithRepos(1), options: { writeMode: "auto" } }))
      .rejects.toThrow(/remove the configured Kuzu graph directory.*fresh RepoHelix Neo4j database/iu);
    expect(db.repoCount).not.toHaveBeenCalled();
  });

  it("refuses a v9 database before graph indexing", async () => {
    const db = {
      query: vi.fn(async (cypher: string) => cypher.includes("SchemaGenerationState")
        ? [{ activeGeneration: "generation:active", activeRevision: "revision:active", schemaIndexVersion: "9" }]
        : []),
      repoCount: vi.fn()
    } as unknown as GraphDB;
    await expect(planIndexRun({ db, config: configWithRepos(1), options: { changedOnly: true, writeMode: "merge" } }))
      .rejects.toThrow(`Schema index version 9 is incompatible with changed-only/watch indexing`);
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
      tick: vi.fn(), update: vi.fn(), complete: vi.fn(),
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
    expect(result.counts).toMatchObject({ files: 0, code: 0, sections: 0, imports: 0, calls: 0 });
  });

  it("aggregates scan and parse counts", () => {
    expect(sumCounts([
      { filesScanned: 2, filesChanged: 1 } as never,
      { filesScanned: 3, filesChanged: 2 } as never
    ])).toEqual({ filesScanned: 5, filesChanged: 3 });
  });
});
