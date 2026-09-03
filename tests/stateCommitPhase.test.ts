import { describe, expect, it, vi } from "vitest";
import type { GraphDB } from "../src/core/graph-model/db.js";
import type { RepoNode } from "../src/core/parsing/types.js";
import { runIndexStateCommitPhase } from "../src/core/indexing/stateCommit.js";
import { runStaleMarkPhase } from "../src/core/indexing/semanticWrite.js";

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
  it("records LLM summary warnings in the index state error field", async () => {
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
      summaryFailures: { failedCount: 1, errors: ["src/a.ts: timeout"] }
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

describe("stale mark phase", () => {
  it("delegates stale marking to the graph layer with repo phase scope", async () => {
    const markRepoArtifactsStale = vi.fn().mockResolvedValue(3);
    const db = { markRepoArtifactsStale } as unknown as GraphDB;

    const count = await runStaleMarkPhase({
      db,
      repo,
      activeFileIds: ["file:1", "file:2"],
      batchId: "batch:stale",
      indexedAt: "2026-06-22T00:00:00.000Z",
      scope: { workspaceId: "workspace:test", generation: "generation:test" }
    });

    expect(count).toBe(3);
    expect(markRepoArtifactsStale).toHaveBeenCalledWith(
      {
        repoId: repo.id,
        activeFileIds: ["file:1", "file:2"],
        batchId: "batch:stale",
        indexedAt: "2026-06-22T00:00:00.000Z"
      },
      { workspaceId: "workspace:test", generation: "generation:test" }
    );
  });
});
