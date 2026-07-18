import { describe, expect, it, vi } from "vitest";

const writerMocks = vi.hoisted(() => ({
  neo4j: vi.fn().mockResolvedValue(undefined),
  bulk: vi.fn().mockResolvedValue(undefined),
  append: vi.fn().mockResolvedValue(undefined),
  upsert: vi.fn().mockResolvedValue(undefined),
  merge: vi.fn().mockResolvedValue(undefined)
}));

vi.mock("../src/adapters/graph-db/neo4j/Neo4jBatchWriter.js", () => ({ writeGraphFactsWithNeo4jBatch: writerMocks.neo4j }));
vi.mock("../src/core/graph-model/bulkWriter.js", () => ({
  writeGraphFactsWithKuzuBulk: writerMocks.bulk,
  writeGraphFactsWithKuzuAppendCopy: writerMocks.append,
  writeGraphFactsWithKuzuBulkUpsert: writerMocks.upsert
}));
vi.mock("../src/core/graph-model/batchWriter.js", () => ({ writeGraphFactsBatch: writerMocks.merge }));

import { runGraphWritePhase, selectGraphWriter } from "../src/core/indexing/graphWrite.js";
import { configSchema } from "../src/config/schema.js";
import type { GraphDB } from "../src/core/graph-model/db.js";
import type { GraphFactsBatch } from "../src/core/graph-model/facts.js";
import type { RepoNode } from "../src/core/parsing/types.js";
import type { WorkspaceLexicalStore } from "../src/core/retrieval/provider.js";

const repo: RepoNode = { id: "repo:a", name: "service-a", path: "service-a", remoteUrl: "", branch: "main", commitSha: "abc", language: "typescript", indexedAt: "2026-07-18T00:00:00.000Z" };

function emptyFacts(): GraphFactsBatch {
  return {
    batchId: "batch:write", indexedAt: "2026-07-18T00:00:00.000Z", repos: [repo], parsedFiles: [], files: [], code: [], sections: [], entities: [], operations: [], workflows: [], contracts: [], evidence: [], contains: [], imports: [], calls: [], mentions: [], sectionDescribesRepos: [], sectionDocumentsCode: [], sectionReferencesFile: [], repoContracts: [], packageUsages: [], contractEntities: [], operationRepos: [], workflowOperations: [], repoDependencies: [], contractSpecs: [], contractSpecEdges: [], semanticRelations: [], crossRepo: { imports: [], calls: [] }
  } as unknown as GraphFactsBatch;
}

function fakeDb(events: string[]): GraphDB & Record<string, ReturnType<typeof vi.fn>> {
  return {
    recoverIncompleteGraphWriteBatches: vi.fn(async () => { events.push("recover"); return []; }),
    beginGraphWriteBatch: vi.fn(async () => { events.push("begin"); }),
    updateGraphWriteBatch: vi.fn(async (input) => { events.push(input.completedStage); }),
    commitGraphWriteBatch: vi.fn(async () => { events.push("commit"); }),
    failGraphWriteBatch: vi.fn(async (input) => { events.push(input.awaitingCleanup ? "awaiting-cleanup" : "cleanup-complete"); }),
    cleanupGraphWriteBatch: vi.fn(async () => { events.push("graph-cleanup"); }),
    clearRepoIndexedArtifacts: vi.fn()
  } as unknown as GraphDB & Record<string, ReturnType<typeof vi.fn>>;
}

function fakeStore(events: string[]): WorkspaceLexicalStore & Record<string, ReturnType<typeof vi.fn>> {
  return {
    cleanupBatch: vi.fn(async () => { events.push("lexical-cleanup"); })
  } as unknown as WorkspaceLexicalStore & Record<string, ReturnType<typeof vi.fn>>;
}

async function runMerge(input: { db: GraphDB; store: WorkspaceLexicalStore; write: () => Promise<unknown> }) {
  return runGraphWritePhase({
    db: input.db,
    cwd: process.cwd(),
    selection: { mode: "merge", fast: false, fallbackToMerge: false },
    facts: emptyFacts(), repos: [repo], parsedFiles: [], config: configSchema.parse({ indexing: { llmSummaryLevel: "off" } }),
    llmSummaryLevel: "off", label: "test", createProgressBar: () => ({ update: () => {}, reporter: () => () => {}, complete: () => {} }),
    log: () => {}, warn: () => {}, lexical: { store: input.store, workspaceId: "workspace:a", write: input.write }
  });
}

describe("graph write phase", () => {
  it("uses bulk-copy for the first empty batched full import and append-copy afterward", () => {
    expect(selectGraphWriter({
      writeMode: "auto",
      batchedFull: true,
      graphIsEmpty: true
    })).toEqual({
      mode: "bulk-copy",
      fast: true,
      fallbackToMerge: false
    });

    expect(selectGraphWriter({
      writeMode: "auto",
      batchedFull: true,
      graphIsEmpty: false
    })).toEqual({
      mode: "append-copy",
      fast: true,
      fallbackToMerge: false
    });
  });

  it("keeps full empty graph imports on bulk-copy", () => {
    expect(selectGraphWriter({
      writeMode: "bulk",
      fullCopyBulk: true
    })).toEqual({
      mode: "bulk-copy",
      fast: true,
      fallbackToMerge: false
    });
  });

  it("uses append-copy for auto full per-repo updates with merge fallback", () => {
    expect(selectGraphWriter({
      writeMode: "auto",
      changedOnly: false
    })).toEqual({
      mode: "append-copy",
      fast: true,
      fallbackToMerge: true
    });
  });

  it("uses bulk-upsert for auto changed-only updates with merge fallback", () => {
    expect(selectGraphWriter({
      writeMode: "auto",
      changedOnly: true
    })).toEqual({
      mode: "bulk-upsert",
      fast: true,
      fallbackToMerge: true
    });
  });

  it("keeps explicit bulk-upsert as a hard-failing fast writer", () => {
    expect(selectGraphWriter({
      writeMode: "bulk-upsert",
      changedOnly: true
    })).toEqual({
      mode: "bulk-upsert",
      fast: true,
      fallbackToMerge: false
    });
  });

  it("uses merge for explicit merge mode", () => {
    expect(selectGraphWriter({
      writeMode: "merge",
      changedOnly: true
    })).toEqual({
      mode: "merge",
      fast: false,
      fallbackToMerge: false
    });
  });

  describe("non-kuzu provider forces merge mode", () => {
    it("forces merge mode for neo4j provider regardless of writeMode=auto", () => {
      expect(selectGraphWriter({
        writeMode: "auto",
        batchedFull: true,
        graphIsEmpty: true,
        provider: "neo4j"
      })).toEqual({
        mode: "merge",
        fast: false,
        fallbackToMerge: false
      });
    });

    it("forces merge mode for neo4j provider with bulk writeMode", () => {
      expect(selectGraphWriter({
        writeMode: "bulk",
        fullCopyBulk: true,
        provider: "neo4j"
      })).toEqual({
        mode: "merge",
        fast: false,
        fallbackToMerge: false
      });
    });

    it("forces merge mode for neo4j provider with changedOnly", () => {
      expect(selectGraphWriter({
        writeMode: "auto",
        changedOnly: true,
        provider: "neo4j"
      })).toEqual({
        mode: "merge",
        fast: false,
        fallbackToMerge: false
      });
    });

    it("forces merge mode for any non-kuzu provider name", () => {
      expect(selectGraphWriter({
        writeMode: "bulk",
        fullCopyBulk: true,
        provider: "custom-db"
      })).toEqual({
        mode: "merge",
        fast: false,
        fallbackToMerge: false
      });
    });

    it("does not force merge mode for kuzu provider", () => {
      expect(selectGraphWriter({
        writeMode: "auto",
        batchedFull: true,
        graphIsEmpty: true,
        provider: "kuzu"
      })).toEqual({
        mode: "bulk-copy",
        fast: true,
        fallbackToMerge: false
      });
    });

    it("does not force merge mode when provider is undefined", () => {
      expect(selectGraphWriter({
        writeMode: "auto",
        batchedFull: true,
        graphIsEmpty: true
      })).toEqual({
        mode: "bulk-copy",
        fast: true,
        fallbackToMerge: false
      });
    });
  });

  it("commits only after graph and lexical writes both succeed", async () => {
    writerMocks.neo4j.mockResolvedValueOnce(undefined);
    const events: string[] = [];
    const db = fakeDb(events);
    const store = fakeStore(events);
    await runMerge({ db, store, write: async () => { events.push("lexical-write"); } });
    expect(events).toEqual(["recover", "begin", "graph-written", "lexical-write", "lexical-written", "commit"]);
    expect(db.beginGraphWriteBatch).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "workspace:a" }));
  });

  it("preserves a lexical write error and cleans both providers before leaving the journal failed", async () => {
    writerMocks.neo4j.mockResolvedValueOnce(undefined);
    const events: string[] = [];
    const db = fakeDb(events);
    const store = fakeStore(events);
    const original = new Error("lexical exploded");
    await expect(runMerge({ db, store, write: async () => { throw original; } })).rejects.toMatchObject({ cause: original });
    expect(events).toEqual(["recover", "begin", "graph-written", "awaiting-cleanup", "graph-cleanup", "lexical-cleanup", "cleanup-complete"]);
    expect(db.commitGraphWriteBatch).not.toHaveBeenCalled();
  });

  it("attempts lexical cleanup when graph cleanup fails and retains awaiting-cleanup", async () => {
    writerMocks.neo4j.mockRejectedValueOnce(new Error("graph exploded"));
    const events: string[] = [];
    const db = fakeDb(events);
    (db.cleanupGraphWriteBatch as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => { events.push("graph-cleanup"); throw new Error("graph cleanup exploded"); });
    const store = fakeStore(events);
    await expect(runMerge({ db, store, write: async () => { events.push("lexical-write"); } })).rejects.toThrow("graph exploded");
    expect(events).toContain("lexical-cleanup");
    expect(events.at(-1)).toBe("awaiting-cleanup");
  });

  it("attempts graph cleanup when lexical cleanup fails and records awaiting-cleanup", async () => {
    writerMocks.neo4j.mockRejectedValueOnce(new Error("graph exploded"));
    const events: string[] = [];
    const db = fakeDb(events);
    const store = fakeStore(events);
    (store.cleanupBatch as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => { events.push("lexical-cleanup"); throw new Error("lexical cleanup exploded"); });
    await expect(runMerge({ db, store, write: async () => {} })).rejects.toThrow("graph exploded");
    expect(events).toContain("graph-cleanup");
    expect(events.at(-1)).toBe("awaiting-cleanup");
  });

  it("attempts both cleanups when both providers fail cleanup", async () => {
    writerMocks.neo4j.mockRejectedValueOnce(new Error("graph exploded"));
    const events: string[] = [];
    const db = fakeDb(events);
    const store = fakeStore(events);
    (db.cleanupGraphWriteBatch as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => { events.push("graph-cleanup"); throw new Error("graph cleanup exploded"); });
    (store.cleanupBatch as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => { events.push("lexical-cleanup"); throw new Error("lexical cleanup exploded"); });
    await expect(runMerge({ db, store, write: async () => {} })).rejects.toThrow("graph exploded");
    expect(events).toContain("graph-cleanup");
    expect(events).toContain("lexical-cleanup");
    expect(events.at(-1)).toBe("awaiting-cleanup");
  });

  it("writes lexical data once after a successful fast-writer fallback", async () => {
    writerMocks.upsert.mockRejectedValueOnce(new Error("fast failed"));
    writerMocks.merge.mockResolvedValueOnce(undefined);
    const events: string[] = [];
    const db = fakeDb(events);
    const store = fakeStore(events);
    const lexicalWrite = vi.fn(async () => { events.push("lexical-write"); });
    await runGraphWritePhase({
      db, cwd: process.cwd(), selection: { mode: "bulk-upsert", fast: true, fallbackToMerge: true }, facts: emptyFacts(), repos: [repo], parsedFiles: [],
      config: configSchema.parse({ indexing: { llmSummaryLevel: "off" } }), llmSummaryLevel: "off", label: "test",
      createProgressBar: () => ({ update: () => {}, reporter: () => () => {}, complete: () => {} }), log: () => {}, warn: () => {},
      lexical: { store, workspaceId: "workspace:a", write: lexicalWrite }
    });
    expect(lexicalWrite).toHaveBeenCalledTimes(1);
    expect(db.beginGraphWriteBatch).toHaveBeenCalledTimes(2);
    expect(db.commitGraphWriteBatch).toHaveBeenCalledTimes(1);
  });

  it.each(["graph", "lexical"] as const)("does not enter fallback when %s cleanup fails", async (provider) => {
    writerMocks.upsert.mockRejectedValueOnce(new Error("fast failed"));
    const mergeCallCount = writerMocks.merge.mock.calls.length;
    const events: string[] = [];
    const db = fakeDb(events);
    const store = fakeStore(events);
    if (provider === "graph") {
      (db.cleanupGraphWriteBatch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("graph cleanup failed"));
    } else {
      (store.cleanupBatch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("lexical cleanup failed"));
    }
    await expect(runGraphWritePhase({
      db, cwd: process.cwd(), selection: { mode: "bulk-upsert", fast: true, fallbackToMerge: true }, facts: emptyFacts(), repos: [repo], parsedFiles: [],
      config: configSchema.parse({ indexing: { llmSummaryLevel: "off" } }), llmSummaryLevel: "off", label: "test",
      createProgressBar: () => ({ update: () => {}, reporter: () => () => {}, complete: () => {} }), log: () => {}, warn: () => {},
      lexical: { store, workspaceId: "workspace:a", write: async () => {} }
    })).rejects.toThrow("fast failed");
    expect(db.beginGraphWriteBatch).toHaveBeenCalledTimes(1);
    expect(writerMocks.merge.mock.calls).toHaveLength(mergeCallCount);
  });

  it("attempts both provider cleanups when marking the journal awaiting-cleanup fails", async () => {
    writerMocks.neo4j.mockRejectedValueOnce(new Error("graph exploded"));
    const events: string[] = [];
    const db = fakeDb(events);
    const store = fakeStore(events);
    (db.failGraphWriteBatch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("journal update failed"));
    const original = new Error("unused");
    await expect(runMerge({ db, store, write: async () => { throw original; } })).rejects.toThrow("graph exploded");
    expect(db.cleanupGraphWriteBatch).toHaveBeenCalledTimes(1);
    expect(store.cleanupBatch).toHaveBeenCalledTimes(1);
  });
});
