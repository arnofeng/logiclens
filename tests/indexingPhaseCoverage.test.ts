import { describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { configSchema } from "../src/config/schema.js";
import type { KuzuGraphDB } from "../src/graph/db.js";
import { runFactBuildPhase } from "../src/indexing/graphWrite.js";
import { runFullCopyBulkIndex, sumCounts } from "../src/indexing/orchestrator.js";
import { planIndexRun } from "../src/indexing/planning.js";
import { runLlmSummaryPhase } from "../src/indexing/summaries.js";
import type { IndexRunContext } from "../src/indexing/context.js";
import type { RepoNode } from "../src/parsers/types.js";

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
    query: vi.fn().mockResolvedValue([{ count }]),
    repoCount: vi.fn().mockResolvedValue(count)
  } as unknown as KuzuGraphDB;
}

describe("indexing phase coverage", () => {
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
    const result = await runFactBuildPhase({
      batchId: "batch:facts",
      indexedAt: "2026-06-22T00:00:00.000Z",
      repos: [repo],
      parsedFiles: [],
      config: configSchema.parse({})
    });

    expect(result.facts.batchId).toBe("batch:facts");
    expect(result.counts).toMatchObject({
      files: 0,
      code: 0,
      sections: 0,
      imports: 0,
      calls: 0
    });
  });

  it("aggregates scan/parse counts without depending on command state", () => {
    const counts = sumCounts([
      { filesScanned: 2, filesChanged: 1 } as any,
      { filesScanned: 3, filesChanged: 2 } as any
    ]);

    expect(counts).toEqual({ filesScanned: 5, filesChanged: 3 });
  });

  it("records failed index state when full copy bulk graph write fails", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-full-bulk-fail-"));
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
        llm: { summaryLevel: "off" },
        embedding: { enabled: false, model: "text-embedding-3-small" }
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
          initialRepoCount: 0
        },
        options: { writeMode: "bulk" }
      })).rejects.toThrow("bulk write failed");

      expect(upsertIndexState).toHaveBeenCalledWith(expect.objectContaining({
        repoName: "empty-service",
        status: "failed",
        graphWriteAtomicity: "journaled-recoverable",
        graphWriteStatus: "failed",
        error: expect.stringContaining("bulk write failed")
      }));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
