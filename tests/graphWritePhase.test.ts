import { describe, expect, it, vi } from "vitest";

const writerMocks = vi.hoisted(() => ({
  neo4j: vi.fn().mockResolvedValue(undefined),
  bulk: vi.fn().mockResolvedValue(undefined),
  append: vi.fn().mockResolvedValue(undefined),
  upsert: vi.fn().mockResolvedValue(undefined),
  merge: vi.fn().mockResolvedValue(undefined)
}));

const summaryMocks = vi.hoisted(() => ({
  summarizeGraphWithProgress: vi.fn()
}));

vi.mock("../src/adapters/graph-db/neo4j/Neo4jBatchWriter.js", () => ({ writeGraphFactsWithNeo4jBatch: writerMocks.neo4j }));
vi.mock("../src/core/graph-model/bulkWriter.js", () => ({
  writeGraphFactsWithKuzuBulk: writerMocks.bulk,
  writeGraphFactsWithKuzuAppendCopy: writerMocks.append,
  writeGraphFactsWithKuzuBulkUpsert: writerMocks.upsert
}));
vi.mock("../src/core/graph-model/upsert.js", () => ({ writeGraphFactsWithMerge: writerMocks.merge }));
vi.mock("../src/core/indexing/summaries.js", () => ({
  shouldSummarizeGraphWithLlm: (level: string) => level === "repo" || level === "file" || level === "node",
  summarizeGraphWithProgress: summaryMocks.summarizeGraphWithProgress
}));

import { prepareGraphSummaries, prepareIncrementalPublicGraphReplacement, runGraphWritePhase, selectGraphWriter } from "../src/core/indexing/graphWrite.js";
import { configSchema } from "../src/config/schema.js";
import type { GraphDB } from "../src/core/graph-model/db.js";
import type { GraphFactsBatch } from "../src/core/graph-model/facts.js";
import type { ParsedFile, RepoNode } from "../src/core/parsing/types.js";
import type { WorkspaceLexicalStore } from "../src/core/retrieval/provider.js";

const repo: RepoNode = { id: "repo:a", name: "service-a", path: "service-a", remoteUrl: "", branch: "main", commitSha: "abc", language: "typescript", indexedAt: "2026-07-18T00:00:00.000Z" };

function emptyFacts(): GraphFactsBatch {
  return {
    batchId: "batch:write", workspaceId: "workspace:a", generation: "generation:pending", systemName: "test-system", indexedAt: "2026-07-18T00:00:00.000Z", repos: [repo], parsedFiles: [], files: [], code: [], sections: [], entities: [], operations: [], workflows: [], contracts: [], evidence: [], contains: [], imports: [], calls: [], mentions: [], sectionDescribesRepos: [], sectionDocumentsCode: [], sectionReferencesFile: [], repoContracts: [], packageUsages: [], contractEntities: [], operationRepos: [], workflowOperations: [], repoDependencies: [], contractSpecs: [], contractSpecEdges: [], semanticRelations: [], crossRepo: {
      contracts: [], evidence: [], entities: [], repoContracts: [], repoDependencies: [], contractEntities: [],
      operations: [], workflows: [], operationRepos: [], workflowOperations: [], packageUsages: [], contractSpecs: [],
      contractSpecEdges: [], semanticRelations: [], schemaDeclarations: [], schemaInternalFacts: {
        declarations: [], resolutionContexts: [], resolutionScopeDependencies: [], roots: [], dependencies: [],
        provenance: [], diagnostics: [], fingerprints: []
      }
    }
  };
}

function fakeDb(events: string[]): GraphDB & Record<string, ReturnType<typeof vi.fn>> {
  return {
    recoverIncompleteGraphWriteBatches: vi.fn(async () => { events.push("recover"); return []; }),
    beginGraphWriteBatch: vi.fn(async () => { events.push("begin"); }),
    updateGraphWriteBatch: vi.fn(async (input) => { events.push(input.completedStage); }),
    commitGraphWriteBatch: vi.fn(async () => { events.push("commit"); }),
    failGraphWriteBatch: vi.fn(async (input) => { events.push(input.awaitingCleanup ? "awaiting-cleanup" : "cleanup-complete"); }),
    cleanupGraphWriteBatch: vi.fn(async () => { events.push("graph-cleanup"); }),
    clearRepoIndexedArtifacts: vi.fn(),
    upsertSystem: vi.fn(),
    upsertRepo: vi.fn(),
    updateRepoSummary: vi.fn(async (repoId: string) => { events.push(`repo-summary:${repoId}`); }),
    updateSystemSummary: vi.fn(async () => { events.push("system-summary"); }),
    applyIncrementalIndexMutation: vi.fn(async (_request: unknown, apply: () => Promise<unknown>) => {
      events.push("provider-apply");
      return apply();
    }),
    query: vi.fn(async () => [])
  } as unknown as GraphDB & Record<string, ReturnType<typeof vi.fn>>;
}

function fakeStore(events: string[]): WorkspaceLexicalStore & Record<string, ReturnType<typeof vi.fn>> {
  return {
    cleanupBatch: vi.fn(async () => { events.push("lexical-cleanup"); })
  } as unknown as WorkspaceLexicalStore & Record<string, ReturnType<typeof vi.fn>>;
}

async function runMerge(input: {
  db: GraphDB;
  store: WorkspaceLexicalStore;
  write: () => Promise<unknown>;
  deferWorkspaceCommit?: boolean;
  skipRecovery?: boolean;
}) {
  return runGraphWritePhase({
    db: input.db,
    cwd: process.cwd(),
    selection: { mode: "merge", fast: false, fallbackToMerge: false },
    facts: emptyFacts(), repos: [repo], parsedFiles: [], config: configSchema.parse({ indexing: { llmSummaryLevel: "off" } }),
    llmSummaryLevel: "off", label: "test", createProgressBar: () => ({ update: () => {}, reporter: () => () => {}, complete: () => {} }),
    log: () => {}, warn: () => {}, deferWorkspaceCommit: input.deferWorkspaceCommit, skipRecovery: input.skipRecovery,
    lexical: { store: input.store, workspaceId: "workspace:a", write: input.write }
  });
}

describe("graph write phase", () => {
  it("prepares TypeScript imports and calls from exact imported files without scanning the repository", async () => {
    const events: string[] = [];
    const db = fakeDb(events);
    const facts = emptyFacts();
    const sourceFileId = "file:repo:a:src/publisher.ts";
    const targetFileId = "file:repo:a:src/models.ts";
    const callerId = "code:repo:a:src/publisher.ts:function:publish:2";
    const targetId = "code:repo:a:src/models.ts:function:target:1";
    const parsedFile: ParsedFile = {
      repoId: repo.id,
      fileId: sourceFileId,
      path: "src/publisher.ts",
      language: "typescript",
      hash: "hash:publisher",
      loc: 2,
      source: "import { target } from './models';\nexport function publish() { return target(); }",
      imports: [{ fileId: sourceFileId, module: "./models", raw: "import { target } from './models';", line: 1, bindings: [{ localName: "target", importedName: "target", kind: "named" }] }],
      symbols: [{ id: callerId, repoId: repo.id, fileId: sourceFileId, kind: "function", name: "publish", qualifiedName: "publish", startLine: 2, endLine: 2, signature: "publish()", source: "export function publish() { return target(); }", hash: "hash:publish" }],
      calls: [{ callerSymbolId: callerId, calleeName: "target", raw: "target()", fileId: sourceFileId, line: 2 }]
    };
    facts.files = [{ id: sourceFileId, repoId: repo.id, path: parsedFile.path, directory: "src", language: parsedFile.language, hash: parsedFile.hash, loc: parsedFile.loc, batchId: facts.batchId, indexedAt: facts.indexedAt, active: true }];
    facts.code = [...parsedFile.symbols];
    (db.query as ReturnType<typeof vi.fn>).mockImplementation(async (cypher: string) => {
      if (cypher.includes("f.id IN $candidateFileIds")) {
        return [{ id: targetFileId, repoId: repo.id, path: "src/models.ts", directory: "src", language: "typescript", hash: "hash:models", loc: 1 }];
      }
      if (cypher.includes("c.fileId IN $targetFileIds")) {
        return [{ id: targetId, repoId: repo.id, fileId: targetFileId, kind: "function", name: "target", qualifiedName: "target", startLine: 1, endLine: 1, signature: "target()", summary: "", hash: "hash:target" }];
      }
      return [];
    });

    await prepareIncrementalPublicGraphReplacement(db, facts, [parsedFile], []);

    expect(facts.imports).toEqual([expect.objectContaining({ fromFileId: sourceFileId, toFileId: targetFileId })]);
    expect(facts.calls).toEqual([expect.objectContaining({ fromCodeId: callerId, toCodeId: targetId })]);
    const fileQueries = (db.query as ReturnType<typeof vi.fn>).mock.calls
      .filter(([cypher]) => String(cypher).includes("MATCH (f:File)"));
    expect(fileQueries).toHaveLength(1);
    expect(String(fileQueries[0]?.[0])).toContain("f.id IN $candidateFileIds");
    expect(String(fileQueries[0]?.[0])).not.toContain("STARTS WITH");
  });

  it("prepares Go calls through an exact persisted package directory", async () => {
    const events: string[] = [];
    const db = fakeDb(events);
    const facts = emptyFacts();
    const sourceFileId = "file:repo:a:src/service/main.go";
    const targetFileId = "file:repo:a:src/service/helper.go";
    const callerId = "code:repo:a:src/service/main.go:function:run:3";
    const targetId = "code:repo:a:src/service/helper.go:function:helper:3";
    const parsedFile: ParsedFile = {
      repoId: repo.id,
      fileId: sourceFileId,
      path: "src/service/main.go",
      language: "go",
      hash: "hash:main",
      loc: 3,
      source: "package service\n\nfunc run() { helper() }",
      imports: [],
      symbols: [{ id: callerId, repoId: repo.id, fileId: sourceFileId, kind: "function", name: "run", qualifiedName: "run", startLine: 3, endLine: 3, signature: "func run()", source: "func run() { helper() }", hash: "hash:run" }],
      calls: [{ callerSymbolId: callerId, calleeName: "helper", raw: "helper()", fileId: sourceFileId, line: 3 }]
    };
    facts.files = [{ id: sourceFileId, repoId: repo.id, path: parsedFile.path, directory: "src/service", language: parsedFile.language, hash: parsedFile.hash, loc: parsedFile.loc, batchId: facts.batchId, indexedAt: facts.indexedAt, active: true }];
    facts.code = [...parsedFile.symbols];
    (db.query as ReturnType<typeof vi.fn>).mockImplementation(async (cypher: string) => {
      if (cypher.includes("f.directory = $directory")) {
        return [{ id: targetFileId, repoId: repo.id, path: "src/service/helper.go", directory: "src/service", language: "go", hash: "hash:helper", loc: 3 }];
      }
      if (cypher.includes("c.fileId IN $targetFileIds")) {
        return [{ id: targetId, repoId: repo.id, fileId: targetFileId, kind: "function", name: "helper", qualifiedName: "helper", startLine: 3, endLine: 3, signature: "func helper()", summary: "", hash: "hash:helper-symbol" }];
      }
      return [];
    });

    await prepareIncrementalPublicGraphReplacement(db, facts, [parsedFile], []);

    expect(facts.calls).toEqual([expect.objectContaining({ fromCodeId: callerId, toCodeId: targetId })]);
    const directoryQuery = (db.query as ReturnType<typeof vi.fn>).mock.calls.find(([cypher]) => String(cypher).includes("MATCH (f:File)") && String(cypher).includes("directory"));
    expect(String(directoryQuery?.[0])).toContain("f.directory = $directory");
    expect(directoryQuery?.[1]).toMatchObject({ repoId: repo.id, directory: "src/service" });
    expect(String(directoryQuery?.[0])).not.toContain("STARTS WITH");
  });

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

  it("leaves a generated workspace batch pending until the final active-pointer transaction", async () => {
    writerMocks.neo4j.mockResolvedValueOnce(undefined);
    const events: string[] = [];
    const db = fakeDb(events);
    const store = fakeStore(events);
    const result = await runMerge({
      db,
      store,
      write: async () => { events.push("lexical-write"); },
      deferWorkspaceCommit: true,
      skipRecovery: true
    });
    expect(events).toEqual(["begin", "graph-written", "lexical-write", "lexical-written", "workspace-pending"]);
    expect(db.commitGraphWriteBatch).not.toHaveBeenCalled();
    expect(result.journalStatus).toBe("started");
  });

  it("applies a prepared source replacement without discovery reads in the final transaction", async () => {
    writerMocks.neo4j.mockResolvedValueOnce(undefined);
    const events: string[] = [];
    const db = fakeDb(events);
    const store = fakeStore(events);
    const facts = emptyFacts();
    const touchedFileId = "file:repo:a:src/model.ts";
    facts.files.push({
      id: touchedFileId,
      repoId: repo.id,
      path: "src/model.ts",
      directory: "src",
      language: "typescript",
      hash: "hash:new",
      loc: 1,
      batchId: facts.batchId,
      indexedAt: facts.indexedAt,
      active: true
    });
    await runGraphWritePhase({
      db,
      cwd: process.cwd(),
      selection: { mode: "merge", fast: false, fallbackToMerge: false },
      facts,
      repos: [repo],
      parsedFiles: [],
      publicGraphReplacement: {
        sourceFileIds: [touchedFileId],
        deletedFileIds: [],
        existingEvidenceIds: ["evidence:old"],
        staleCodeIds: ["code:old"],
        staleSectionIds: ["section:old"],
        staleEvidenceIds: ["evidence:old"],
        staleSpecIds: ["spec:old"],
        orphanEntityIds: ["entity:old"],
        orphanOperationIds: [],
        orphanWorkflowIds: [],
        orphanContractIds: ["contract:old"]
      },
      config: configSchema.parse({ indexing: { llmSummaryLevel: "off" } }),
      llmSummaryLevel: "off",
      label: "prepared replacement",
      createProgressBar: () => ({ update: () => {}, reporter: () => () => {}, complete: () => {} }),
      log: () => {},
      warn: () => {},
      lexical: { store, workspaceId: facts.workspaceId, write: async () => {} }
    });
    const finalTransactionQueries = (db.query as ReturnType<typeof vi.fn>).mock.calls.map(([cypher]) => String(cypher));
    expect(finalTransactionQueries.length).toBeGreaterThan(0);
    expect(finalTransactionQueries.every((cypher) => !cypher.includes(" RETURN "))).toBe(true);
    expect(finalTransactionQueries.some((cypher) => cypher.includes("DELETE r"))).toBe(true);
    expect(finalTransactionQueries.some((cypher) => cypher.includes("DETACH DELETE n"))).toBe(true);
  });

  it("computes incremental summaries before provider publication and only writes the prepared payload inside it", async () => {
    summaryMocks.summarizeGraphWithProgress.mockReset();
    const events: string[] = [];
    summaryMocks.summarizeGraphWithProgress.mockImplementationOnce(async () => {
      events.push("summary-compute");
      return {
        repoSummaries: [{ repoId: repo.id, summary: "prepared repo summary" }],
        systemSummary: "prepared system summary"
      };
    });
    const db = fakeDb(events);
    const store = fakeStore(events);
    const facts = emptyFacts();
    const config = configSchema.parse({ indexing: { llmSummaryLevel: "repo" } });

    const preparedSummaries = await prepareGraphSummaries({
      repos: [repo],
      parsedFiles: [],
      crossRepo: facts.crossRepo,
      config,
      llmSummaryLevel: "repo",
      label: "incremental summary preparation",
      createProgressBar: () => ({ update: () => {}, reporter: () => () => {}, complete: () => {} })
    });

    await db.applyIncrementalIndexMutation({
      workspaceId: facts.workspaceId,
      expectedActiveGeneration: facts.generation,
      expectedActiveRevision: "revision:active",
      nextRevision: "revision:next",
      schemaIndexVersion: "test-schema-version",
      lexicalProjectionVersion: "test-lexical-version"
    }, async () => runGraphWritePhase({
      db,
      cwd: process.cwd(),
      selection: { mode: "merge", fast: false, fallbackToMerge: false },
      facts,
      repos: [repo],
      parsedFiles: [],
      publicGraphReplacement: {
        sourceFileIds: [],
        deletedFileIds: [],
        existingEvidenceIds: [],
        staleCodeIds: [],
        staleSectionIds: [],
        staleEvidenceIds: [],
        staleSpecIds: [],
        orphanEntityIds: [],
        orphanOperationIds: [],
        orphanWorkflowIds: [],
        orphanContractIds: []
      },
      preparedSummaries,
      config,
      llmSummaryLevel: "repo",
      label: "incremental summary apply",
      createProgressBar: () => ({ update: () => {}, reporter: () => () => {}, complete: () => {} }),
      log: () => {},
      warn: () => {},
      skipRecovery: true,
      lexical: { store, workspaceId: facts.workspaceId, write: async () => {} }
    }));

    expect(summaryMocks.summarizeGraphWithProgress).toHaveBeenCalledTimes(1);
    expect(events.indexOf("summary-compute")).toBeLessThan(events.indexOf("provider-apply"));
    expect(events.slice(events.indexOf("provider-apply") + 1)).not.toContain("summary-compute");
    expect(db.updateRepoSummary).toHaveBeenCalledWith(
      repo.id,
      "prepared repo summary",
      { workspaceId: facts.workspaceId, generation: facts.generation }
    );
    expect(db.updateSystemSummary).toHaveBeenCalledWith(
      "prepared system summary",
      { workspaceId: facts.workspaceId, generation: facts.generation }
    );
  });

  it("preserves a lexical staging error without compensating against either provider", async () => {
    writerMocks.neo4j.mockResolvedValueOnce(undefined);
    const events: string[] = [];
    const db = fakeDb(events);
    const store = fakeStore(events);
    const original = new Error("lexical exploded");
    await expect(runMerge({ db, store, write: async () => { throw original; } })).rejects.toMatchObject({ cause: original });
    expect(events).toEqual(["recover", "begin", "graph-written", "awaiting-cleanup", "awaiting-cleanup"]);
    expect(db.commitGraphWriteBatch).not.toHaveBeenCalled();
    expect(db.cleanupGraphWriteBatch).not.toHaveBeenCalled();
    expect(store.cleanupBatch).not.toHaveBeenCalled();
  });

  it("leaves pending-generation cleanup to the workspace lifecycle when graph staging fails", async () => {
    writerMocks.neo4j.mockRejectedValueOnce(new Error("graph exploded"));
    const events: string[] = [];
    const db = fakeDb(events);
    const store = fakeStore(events);
    await expect(runMerge({ db, store, write: async () => { events.push("lexical-write"); } })).rejects.toThrow("graph exploded");
    expect(events).toEqual(["recover", "begin", "awaiting-cleanup"]);
    expect(events.at(-1)).toBe("awaiting-cleanup");
    expect(db.cleanupGraphWriteBatch).not.toHaveBeenCalled();
    expect(store.cleanupBatch).not.toHaveBeenCalled();
  });

  it("does not invoke graph cleanup when lexical staging fails", async () => {
    writerMocks.neo4j.mockResolvedValueOnce(undefined);
    const events: string[] = [];
    const db = fakeDb(events);
    const store = fakeStore(events);
    await expect(runMerge({ db, store, write: async () => { throw new Error("lexical exploded"); } })).rejects.toThrow("lexical exploded");
    expect(events.at(-1)).toBe("awaiting-cleanup");
    expect(db.cleanupGraphWriteBatch).not.toHaveBeenCalled();
    expect(store.cleanupBatch).not.toHaveBeenCalled();
  });

  it("does not call legacy compensating cleanup callbacks", async () => {
    writerMocks.neo4j.mockRejectedValueOnce(new Error("graph exploded"));
    const events: string[] = [];
    const db = fakeDb(events);
    const store = fakeStore(events);
    (db.cleanupGraphWriteBatch as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => { events.push("graph-cleanup"); throw new Error("graph cleanup exploded"); });
    (store.cleanupBatch as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => { events.push("lexical-cleanup"); throw new Error("lexical cleanup exploded"); });
    await expect(runMerge({ db, store, write: async () => {} })).rejects.toThrow("graph exploded");
    expect(db.cleanupGraphWriteBatch).not.toHaveBeenCalled();
    expect(store.cleanupBatch).not.toHaveBeenCalled();
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

  it.each(["graph", "lexical"] as const)("enters fallback without invoking legacy %s cleanup", async (provider) => {
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
    })).resolves.toMatchObject({ fallback: true, fallbackError: "fast failed" });
    expect(db.beginGraphWriteBatch).toHaveBeenCalledTimes(2);
    expect(writerMocks.merge.mock.calls).toHaveLength(mergeCallCount + 1);
    expect(db.cleanupGraphWriteBatch).not.toHaveBeenCalled();
    expect(store.cleanupBatch).not.toHaveBeenCalled();
  });

  it("does not compensate provider state when marking the pending journal fails", async () => {
    writerMocks.neo4j.mockRejectedValueOnce(new Error("graph exploded"));
    const events: string[] = [];
    const db = fakeDb(events);
    const store = fakeStore(events);
    (db.failGraphWriteBatch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("journal update failed"));
    const original = new Error("unused");
    await expect(runMerge({ db, store, write: async () => { throw original; } })).rejects.toThrow("graph exploded");
    expect(db.cleanupGraphWriteBatch).not.toHaveBeenCalled();
    expect(store.cleanupBatch).not.toHaveBeenCalled();
  });
});
