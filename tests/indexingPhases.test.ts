import { describe, expect, it, vi } from "vitest";
import { IndexPhaseError, runIndexPhase } from "../src/core/indexing/phases.js";
import { runLexicalProjectionPhase } from "../src/core/indexing/lexicalProjection.js";
import { runLexicalWritePhase } from "../src/core/indexing/lexicalWrite.js";
import type { GraphFactsBatch } from "../src/core/graph-model/facts.js";
import type { RepoNode } from "../src/core/parsing/types.js";
import { WorkspaceLexicalStoreError, type WorkspaceLexicalStore } from "../src/core/retrieval/provider.js";
import type { LexicalDocument, LexicalIndexHealth } from "../src/core/retrieval/types.js";

const repo: RepoNode = {
  id: "repo:a",
  name: "service-a",
  path: "fixtures/service-a",
  remoteUrl: "",
  branch: "main",
  commitSha: "abc",
  language: "typescript",
  indexedAt: "2026-07-18T00:00:00.000Z"
};

function facts(overrides: Partial<GraphFactsBatch> = {}): GraphFactsBatch {
  return {
    batchId: "batch:lexical",
    indexedAt: "2026-07-18T00:00:00.000Z",
    repos: [repo], parsedFiles: [], files: [], code: [], sections: [], entities: [], operations: [], workflows: [],
    contracts: [], evidence: [], contains: [], imports: [], calls: [], mentions: [], sectionDescribesRepos: [],
    sectionDocumentsCode: [], sectionReferencesFile: [], repoContracts: [], packageUsages: [], contractEntities: [],
    operationRepos: [], workflowOperations: [], repoDependencies: [], contractSpecs: [], contractSpecEdges: [],
    semanticRelations: [], crossRepo: { imports: [], calls: [] },
    ...overrides
  } as GraphFactsBatch;
}

const health: LexicalIndexHealth = {
  providerVersion: "test-1",
  projectionSchemaVersion: "1",
  tokenizerVersion: "1",
  status: "unhealthy",
  reasons: ["index_populating"],
  metrics: { documentCount: 1, indexSizeBytes: 10 }
};

function fakeStore() {
  return {
    ensureSchema: vi.fn().mockResolvedValue(undefined),
    commitVersions: vi.fn().mockResolvedValue(undefined),
    upsertDocuments: vi.fn().mockResolvedValue(undefined),
    reconcileRepoDocuments: vi.fn().mockResolvedValue(undefined),
    reconcileRepoFileDocuments: vi.fn().mockResolvedValue(undefined),
    cleanupBatch: vi.fn().mockResolvedValue(undefined),
    search: vi.fn().mockResolvedValue([]),
    loadDocuments: vi.fn().mockResolvedValue([]),
    health: vi.fn().mockResolvedValue(health)
  };
}

describe("indexing phases", () => {
  it("returns a phase result with duration for successful work", async () => {
    const result = await runIndexPhase({ phase: "scan", repoName: "service-a" }, () => {
      return { files: 3 };
    });

    expect(result.phase).toBe("scan");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.result).toEqual({ files: 3 });
  });

  it("wraps failures in IndexPhaseError with phase context", async () => {
    await expect(
      runIndexPhase({ phase: "parse", repoName: "service-a", filePath: "src/OrderService.ts" }, () => {
        throw new Error("syntax exploded");
      })
    ).rejects.toThrow(IndexPhaseError);

    await expect(
      runIndexPhase({ phase: "parse", repoName: "service-a", filePath: "src/OrderService.ts" }, () => {
        throw new Error("syntax exploded");
      })
    ).rejects.toThrow(/phase=parse/);
  });

  it("preserves repo, file, writer mode, and batch scope on failures", async () => {
    try {
      await runIndexPhase({
        phase: "graph-write",
        repoName: "service-b",
        batchId: "batch:1",
        filePath: "src/PaymentService.ts",
        writerMode: "bulk-upsert"
      }, async () => {
        throw new Error("write failed");
      });
      throw new Error("expected phase failure");
    } catch (error) {
      expect(error).toBeInstanceOf(IndexPhaseError);
      const phaseError = error as IndexPhaseError;
      expect(phaseError.scope).toEqual({
        phase: "graph-write",
        repoName: "service-b",
        batchId: "batch:1",
        filePath: "src/PaymentService.ts",
        writerMode: "bulk-upsert"
      });
      expect(phaseError.message).toContain("phase=graph-write");
      expect(phaseError.message).toContain("repo=service-b");
      expect(phaseError.message).toContain("batchId=batch:1");
      expect(phaseError.message).toContain("file=src/PaymentService.ts");
      expect(phaseError.message).toContain("writerMode=bulk-upsert");
    }
  });

  it("projects deterministic workspace-scoped documents with phase metadata", async () => {
    const first = await runLexicalProjectionPhase({ facts: facts(), workspaceId: "workspace:a", repoName: repo.name, repoId: repo.id });
    const second = await runLexicalProjectionPhase({ facts: facts(), workspaceId: "workspace:a", repoName: repo.name, repoId: repo.id });
    expect(first.phase).toBe("lexical-projection");
    expect(first.durationMs).toBeGreaterThanOrEqual(0);
    expect(first.documentCount).toBe(1);
    expect(first.documents[0]?.workspaceId).toBe("workspace:a");
    expect(JSON.stringify(first.documents)).toBe(JSON.stringify(second.documents));
  });

  it("returns an empty lexical projection while retaining phase metadata", async () => {
    const result = await runLexicalProjectionPhase({ facts: facts({ repos: [] }), workspaceId: "workspace:a" });
    expect(result).toMatchObject({ phase: "lexical-projection", documentCount: 0, documents: [] });
  });

  it("wraps lexical projection errors and preserves the cause", async () => {
    const invalid = facts({ files: [{ id: "file:a", repoId: repo.id, path: "../escape.ts" } as GraphFactsBatch["files"][number]] });
    await expect(runLexicalProjectionPhase({ facts: invalid, workspaceId: "workspace:a" })).rejects.toMatchObject({
      name: "IndexPhaseError",
      scope: { phase: "lexical-projection", batchId: "batch:lexical" },
      cause: expect.any(Error)
    });
  });

  it("writes lexical documents without repeating schema DDL inside the journal boundary", async () => {
    const store = fakeStore();
    const calls: string[] = [];
    for (const method of ["upsertDocuments", "reconcileRepoDocuments", "health"] as const) {
      (store[method] as ReturnType<typeof vi.fn>).mockImplementation(async () => { calls.push(method); return method === "health" ? health : undefined; });
    }
    const projected = await runLexicalProjectionPhase({ facts: facts(), workspaceId: "workspace:a" });
    const result = await runLexicalWritePhase({ store, workspaceId: "workspace:a", batchId: "batch:lexical", repos: [repo], documents: projected.documents });
    expect(calls).toEqual(["upsertDocuments", "reconcileRepoDocuments", "health"]);
    expect(store.ensureSchema).not.toHaveBeenCalled();
    expect(result).toMatchObject({ documentCount: 1, reconciledRepoIds: [repo.id], indexStatus: "unhealthy", indexReasons: ["index_populating"] });
    expect(store.commitVersions).not.toHaveBeenCalled();
  });

  it("reports the provider's actual projection and tokenizer versions", async () => {
    const store = fakeStore();
    store.health.mockResolvedValueOnce({
      ...health,
      projectionSchemaVersion: "old-projection",
      tokenizerVersion: "old-tokenizer",
      reasons: ["projection_schema_version_mismatch", "tokenizer_version_mismatch"]
    });
    const projected = await runLexicalProjectionPhase({ facts: facts(), workspaceId: "workspace:a" });
    const result = await runLexicalWritePhase({ store, workspaceId: "workspace:a", batchId: "batch:lexical", repos: [repo], documents: projected.documents });
    expect(result.projectionSchemaVersion).toBe("old-projection");
    expect(result.tokenizerVersion).toBe("old-tokenizer");
  });

  it("reconciles every repo once with only its active sorted document ids", async () => {
    const store = fakeStore();
    const repoB = { ...repo, id: "repo:b", name: "service-b" };
    const documents = [
      { id: "z", workspaceId: "workspace:a", repoId: repo.id, batchId: "batch:lexical", active: true },
      { id: "a", workspaceId: "workspace:a", repoId: repo.id, batchId: "batch:lexical", active: true },
      { id: "inactive", workspaceId: "workspace:a", repoId: repo.id, batchId: "batch:lexical", active: false },
      { id: "other", workspaceId: "workspace:a", repoId: repoB.id, batchId: "batch:lexical", active: true }
    ] as LexicalDocument[];
    await runLexicalWritePhase({ store, workspaceId: "workspace:a", batchId: "batch:lexical", repos: [repoB, repo, repo], documents });
    expect(store.reconcileRepoDocuments.mock.calls.map((call: unknown[]) => call[0])).toEqual([
      { workspaceId: "workspace:a", repoId: repo.id, batchId: "batch:lexical", activeDocumentIds: ["a", "z"] },
      { workspaceId: "workspace:a", repoId: repoB.id, batchId: "batch:lexical", activeDocumentIds: ["other"] }
    ]);
  });

  it("reconciles an empty projection and stops after the first provider failure", async () => {
    const store = fakeStore();
    await runLexicalWritePhase({ store, workspaceId: "workspace:a", batchId: "batch:lexical", repos: [repo], documents: [] });
    expect(store.upsertDocuments).not.toHaveBeenCalled();
    expect(store.reconcileRepoDocuments).toHaveBeenCalledWith({ workspaceId: "workspace:a", repoId: repo.id, batchId: "batch:lexical", activeDocumentIds: [] });

    const providerError = new WorkspaceLexicalStoreError("reconcile_failed", { operation: "reconcileRepoDocuments", workspaceId: "workspace:a" });
    store.reconcileRepoDocuments.mockRejectedValueOnce(providerError);
    await expect(runLexicalWritePhase({ store, workspaceId: "workspace:a", batchId: "batch:lexical", repos: [repo], documents: [] })).rejects.toMatchObject({ cause: providerError });
    expect(store.health).toHaveBeenCalledTimes(1);
  });

  it.each(["upsertDocuments", "reconcileRepoDocuments", "health"] as const)(
    "wraps a %s failure and does not continue to later lexical steps",
    async (failedMethod) => {
      const store = fakeStore();
      const providerError = new WorkspaceLexicalStoreError("write_failed", { operation: failedMethod });
      store[failedMethod].mockRejectedValueOnce(providerError);
      const projected = await runLexicalProjectionPhase({ facts: facts(), workspaceId: "workspace:a" });
      await expect(runLexicalWritePhase({ store, workspaceId: "workspace:a", batchId: "batch:lexical", repos: [repo], documents: projected.documents })).rejects.toMatchObject({ cause: providerError });
      const order = ["upsertDocuments", "reconcileRepoDocuments", "health"] as const;
      for (const later of order.slice(order.indexOf(failedMethod) + 1)) expect(store[later]).not.toHaveBeenCalled();
    }
  );
});
