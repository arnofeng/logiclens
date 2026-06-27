import { describe, expect, it, vi } from "vitest";
import type { GraphDB } from "../src/core/graph-model/db.js";
import type { RepoNode } from "../src/core/parsing/types.js";
import { runIndexStateCommitPhase } from "../src/core/indexing/stateCommit.js";
import { runSemanticWritePhase, runStaleMarkPhase } from "../src/core/indexing/semanticWrite.js";
import type { LogicLensConfig } from "../src/config/schema.js";

const repo: RepoNode = {
  id: "repo:service-a",
  name: "service-a",
  path: "fixtures/service-a",
  remoteUrl: "",
  branch: "main",
  commitSha: "abc123",
  language: "typescript",
  indexedAt: "now"
};

describe("index state commit phase", () => {
  it("combines LLM and semantic warnings into the index state error field", async () => {
    const upsertIndexState = vi.fn();
    const db = { upsertIndexState } as unknown as GraphDB;

    await runIndexStateCommitPhase({
      db,
      repo,
      batchId: "batch:1",
      indexedAt: "2026-06-22T00:00:00.000Z",
      filesScanned: 4,
      filesChanged: 2,
      filesStale: 1,
      status: "succeeded",
      summaryFailures: { failedCount: 1, errors: ["src/a.ts: timeout"] },
      semanticWarning: "Semantic index used fallback storage for 1 operation(s)."
    });

    expect(upsertIndexState).toHaveBeenCalledWith(expect.objectContaining({
      repoId: repo.id,
      repoName: repo.name,
      status: "succeeded",
      filesScanned: 4,
      filesChanged: 2,
      filesStale: 1,
      error: expect.stringContaining("Failed to generate 1 LLM summaries")
    }));
    expect(upsertIndexState.mock.calls[0]![0].error).toContain("Semantic index used fallback storage");
  });

  it("records hard failures without warning rollup text", async () => {
    const upsertIndexState = vi.fn();
    const db = { upsertIndexState } as unknown as GraphDB;

    await runIndexStateCommitPhase({
      db,
      repo,
      batchId: "batch:failed",
      indexedAt: "2026-06-22T00:00:00.000Z",
      filesScanned: 0,
      filesChanged: 0,
      filesStale: 0,
      status: "failed",
      summaryFailures: { failedCount: 1, errors: ["ignored warning"] },
      semanticWarning: "ignored semantic warning",
      error: new Error("graph write failed")
    });

    expect(upsertIndexState).toHaveBeenCalledWith(expect.objectContaining({
      status: "failed",
      error: "graph write failed"
    }));
  });

  it("records graph-write atomicity and journal status", async () => {
    const upsertIndexState = vi.fn();
    const db = { upsertIndexState } as unknown as GraphDB;

    await runIndexStateCommitPhase({
      db,
      repo,
      batchId: "batch:state",
      indexedAt: "2026-06-22T00:00:00.000Z",
      filesScanned: 1,
      filesChanged: 1,
      filesStale: 0,
      status: "succeeded",
      graphWriteAtomicity: "journaled-recoverable",
      graphWriteStatus: "committed"
    });

    expect(upsertIndexState).toHaveBeenCalledWith(expect.objectContaining({
      graphWriteAtomicity: "journaled-recoverable",
      graphWriteStatus: "committed"
    }));
  });
});

describe("semantic write and stale mark phases", () => {
  it("skips semantic indexing when embeddings are disabled", async () => {
    const result = await runSemanticWritePhase({
      cwd: process.cwd(),
      repos: [repo],
      parsedFiles: [],
      config: {} as LogicLensConfig,
      enabled: false,
      label: repo.name,
      repoName: repo.name,
      batchId: "batch:1",
      createProgressBar: () => {
        throw new Error("progress should not be created");
      },
      warn: () => {}
    });

    expect(result).toEqual({ indexed: false, fallbackEvents: 0 });
  });

  it("delegates stale marking to the graph layer with repo phase scope", async () => {
    const markRepoArtifactsStale = vi.fn().mockResolvedValue(3);
    const db = { markRepoArtifactsStale } as unknown as GraphDB;

    const count = await runStaleMarkPhase({
      db,
      repo,
      activeFileIds: ["file:1", "file:2"],
      batchId: "batch:stale",
      indexedAt: "2026-06-22T00:00:00.000Z"
    });

    expect(count).toBe(3);
    expect(markRepoArtifactsStale).toHaveBeenCalledWith({
      repoId: repo.id,
      activeFileIds: ["file:1", "file:2"],
      batchId: "batch:stale",
      indexedAt: "2026-06-22T00:00:00.000Z"
    });
  });
});
