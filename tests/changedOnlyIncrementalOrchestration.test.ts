import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../src/config/loadConfig.js";
import type { GraphFactsBatch } from "../src/core/graph-model/facts.js";
import type { GraphDB } from "../src/core/graph-model/db.js";
import {
  addIncrementalRepoMutation,
  type IncrementalIndexMutationSet,
  type IncrementalRepoMutation
} from "../src/core/indexing/incrementalMutation.js";
import type { RepoNode } from "../src/core/parsing/types.js";
import {
  LEXICAL_PROJECTION_SCHEMA_VERSION,
  type LexicalDocument,
  type LexicalIndexHealth
} from "../src/core/retrieval/types.js";
import { toRepoNode } from "../src/core/workspace/repoRegistry.js";

const mocks = vi.hoisted(() => ({
  planIndexRun: vi.fn(),
  createIndexRunContext: vi.fn(),
  prepareRepoIndex: vi.fn(),
  prepareIncrementalWorkspaceIndex: vi.fn(),
  runPerRepoIndex: vi.fn(),
  applyIncrementalRepoMutation: vi.fn(),
  runDependencyRebuild: vi.fn(async () => 0),
  autoDetectAndRegisterPlugins: vi.fn(),
  buildCombinedIncrementalSchemaVisibility: vi.fn(),
  incrementalSchemaPublicGraphDelta: vi.fn(),
  applyIncrementalSchemaMutation: vi.fn(),
  prepareIncrementalDependencyMutation: vi.fn(),
  applyIncrementalDependencyMutation: vi.fn(),
  refreshSucceededIndexStateLexicalMetrics: vi.fn(),
  runIndexStateCommitPhase: vi.fn(),
  generation: {
    assertIncrementalCompatible: vi.fn(),
    recoverExpiredReservation: vi.fn(),
    reservation: vi.fn(),
    supersededGenerations: vi.fn(),
    abortingGenerations: vi.fn(),
    reserveIncremental: vi.fn(),
    renewLease: vi.fn(),
    validateIncremental: vi.fn(),
    activeRevision: vi.fn(),
    abandonIncremental: vi.fn(),
    rollback: vi.fn()
  }
}));

vi.mock("../src/core/indexing/planning.js", () => ({
  planIndexRun: mocks.planIndexRun
}));

vi.mock("../src/core/indexing/context.js", () => ({
  createIndexRunContext: mocks.createIndexRunContext
}));

vi.mock("../src/core/indexing/orchestrator.js", () => ({
  prepareRepoIndex: mocks.prepareRepoIndex,
  prepareIncrementalWorkspaceIndex: mocks.prepareIncrementalWorkspaceIndex,
  runBatchedFullIndex: vi.fn(),
  runFullCopyBulkIndex: vi.fn(),
  runPerRepoIndex: mocks.runPerRepoIndex,
  applyIncrementalRepoMutation: mocks.applyIncrementalRepoMutation,
  runDependencyRebuild: mocks.runDependencyRebuild
}));

vi.mock("../src/core/plugins/register.js", () => ({
  autoDetectAndRegisterPlugins: mocks.autoDetectAndRegisterPlugins
}));

vi.mock("../src/core/schema/staging.js", () => ({
  buildCombinedIncrementalSchemaVisibility: mocks.buildCombinedIncrementalSchemaVisibility,
  incrementalSchemaPublicGraphDelta: mocks.incrementalSchemaPublicGraphDelta,
  applyIncrementalSchemaMutation: mocks.applyIncrementalSchemaMutation
}));

vi.mock("../src/core/graph-model/rebuildRelations.js", () => ({
  prepareIncrementalDependencyMutation: mocks.prepareIncrementalDependencyMutation,
  applyIncrementalDependencyMutation: mocks.applyIncrementalDependencyMutation
}));

vi.mock("../src/core/indexing/stateCommit.js", () => ({
  refreshSucceededIndexStateLexicalMetrics: mocks.refreshSucceededIndexStateLexicalMetrics,
  runIndexStateCommitPhase: mocks.runIndexStateCommitPhase
}));

vi.mock("../src/core/schema/generationStore.js", () => ({
  SchemaGenerationStore: class {
    assertIncrementalCompatible = mocks.generation.assertIncrementalCompatible;
    recoverExpiredReservation = mocks.generation.recoverExpiredReservation;
    reservation = mocks.generation.reservation;
    supersededGenerations = mocks.generation.supersededGenerations;
    abortingGenerations = mocks.generation.abortingGenerations;
    reserveIncremental = mocks.generation.reserveIncremental;
    renewLease = mocks.generation.renewLease;
    validateIncremental = mocks.generation.validateIncremental;
    activeRevision = mocks.generation.activeRevision;
    abandonIncremental = mocks.generation.abandonIncremental;
    rollback = mocks.generation.rollback;
  }
}));

import { runIndexing } from "../src/core/indexing/run.js";

const WORKSPACE_ID = "workspace:changed-only-delta";
const ACTIVE_GENERATION = "generation:active";
const ACTIVE_REVISION = "revision:active";

function lexicalHealth(documentCount: number): LexicalIndexHealth {
  return {
    providerVersion: "test-provider",
    projectionSchemaVersion: LEXICAL_PROJECTION_SCHEMA_VERSION,
    tokenizerVersion: "1",
    status: "healthy",
    reasons: [],
    metrics: { documentCount, indexSizeBytes: documentCount * 10 }
  };
}

function emptySchemaMutation() {
  return {
    sourceFactReplacements: [],
    behaviorFingerprintReplacements: [],
    contributionReplacements: [],
    visibilityChanges: [],
    upsertLexicalDocuments: [],
    deleteLexicalDocumentIds: []
  };
}

function emptyGraphFacts(input: {
  batchId: string;
  repo: RepoNode;
  generation: string;
}): GraphFactsBatch {
  return {
    batchId: input.batchId,
    workspaceId: WORKSPACE_ID,
    generation: input.generation,
    systemName: "changed-only-test",
    indexedAt: "2026-08-02T00:00:00.000Z",
    repos: [input.repo],
    parsedFiles: [],
    files: [],
    code: [],
    sections: [],
    entities: [],
    operations: [],
    workflows: [],
    contracts: [],
    evidence: [],
    contains: [],
    imports: [],
    calls: [],
    mentions: [],
    sectionDescribesRepos: [],
    sectionDocumentsCode: [],
    sectionReferencesFile: [],
    repoContracts: [],
    packageUsages: [],
    contractEntities: [],
    operationRepos: [],
    workflowOperations: [],
    repoDependencies: [],
    contractSpecs: [],
    contractSpecEdges: [],
    semanticRelations: [],
    crossRepo: {
      contracts: [],
      evidence: [],
      entities: [],
      operations: [],
      workflows: [],
      repoContracts: [],
      repoDependencies: [],
      contractEntities: [],
      operationRepos: [],
      workflowOperations: [],
      packageUsages: [],
      contractSpecs: [],
      contractSpecEdges: [],
      semanticRelations: [],
      schemaInternalFacts: {
        declarations: [],
        resolutionContexts: [],
        resolutionScopeDependencies: [],
        roots: [],
        dependencies: [],
        provenance: [],
        diagnostics: [],
        fingerprints: []
      },
      schemaDeclarations: []
    }
  };
}

function createFixture(changed: boolean) {
  const config = {
    ...defaultConfig(),
    repos: [{ name: "repo", path: "repo" }],
    indexing: { ...defaultConfig().indexing, concurrency: 3 }
  };
  const cwd = "C:/workspace";
  const repo = toRepoNode(config.repos[0]!, cwd);
  const fileId = "file:src/models.ts";
  const parsedFile = {
    repoId: repo.id,
    fileId,
    path: "src/models.ts",
    language: "typescript",
    hash: "hash:new",
    loc: 1,
    symbols: [],
    imports: [],
    calls: []
  };
  const initializeGeneration = vi.fn();
  const applyIncrementalMutation = vi.fn();
  const lexicalStore = {
    initializeGeneration,
    applyIncrementalMutation,
    health: vi.fn(async () => lexicalHealth(changed ? 1 : 7)),
    commitBatch: vi.fn(),
    deleteGeneration: vi.fn(),
    cleanupBatch: vi.fn()
  };
  const applyIncrementalIndexMutation = vi.fn(async <T>(
    _request: unknown,
    apply: () => Promise<T>
  ): Promise<T> => apply());
  const db = {
    query: vi.fn(async () => []),
    stats: vi.fn(async () => ({
      repos: 1,
      files: changed ? 1 : 7,
      codeNodes: 0,
      sectionNodes: 0,
      callEdges: 0,
      importEdges: 0,
      entities: 0
    })),
    readPublicGraphStats: vi.fn(async () => ({
      repos: 1,
      files: changed ? 1 : 7,
      codeNodes: 0,
      sectionNodes: 0,
      callEdges: 0,
      importEdges: 0,
      entities: 0,
      revision: ACTIVE_REVISION
    })),
    applyPublicGraphStatsDelta: vi.fn(async () => ({
      repos: 1,
      files: changed ? 1 : 7,
      codeNodes: 0,
      sectionNodes: 0,
      callEdges: 0,
      importEdges: 0,
      entities: 0,
      revision: "revision:next"
    })),
    recoverIncompleteGraphWriteBatches: vi.fn(async () => []),
    deletePublicGraphGeneration: vi.fn(),
    applyIncrementalIndexMutation,
    commitGraphWriteBatch: vi.fn(),
    updateGraphWriteBatch: vi.fn()
  } as unknown as GraphDB;
  const ctx = {
    workspaceId: WORKSPACE_ID,
    lexicalStore,
    pendingIndexStateCommits: new Map(),
    logger: {},
    config
  };

  mocks.planIndexRun.mockResolvedValue({
    publicationMode: "incremental",
    activeGeneration: ACTIVE_GENERATION,
    activeRevision: ACTIVE_REVISION,
    runPath: "per-repo",
    writeMode: "merge",
    repoConfigs: config.repos,
    initialRepoCount: 1,
    batchSize: 0,
    shouldUseCopyBulk: false
  });
  mocks.createIndexRunContext.mockResolvedValue(ctx);
  mocks.prepareRepoIndex.mockResolvedValue({
    repoConfig: config.repos[0],
    repo,
    batchId: "prepare:repo",
    indexedAt: "2026-08-02T00:00:00.000Z",
    scanParse: {
      repo,
      scannedFiles: [],
      parsedFiles: changed ? [parsedFile] : [],
      activeFileIds: changed ? [fileId] : [],
      removedFileIds: [],
      filesScanned: 20,
      filesChanged: changed ? 1 : 0
    }
  });

  return {
    config,
    cwd,
    repo,
    fileId,
    parsedFile,
    lexicalStore,
    initializeGeneration,
    applyIncrementalIndexMutation,
    db
  };
}

describe("changed-only incremental orchestration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.autoDetectAndRegisterPlugins.mockResolvedValue({
      additionalIndexFilesByRepo: new Map(),
      activePluginSourceGlobsByRepo: new Map()
    });
    mocks.generation.recoverExpiredReservation.mockResolvedValue(undefined);
    mocks.generation.reservation.mockResolvedValue(undefined);
    mocks.generation.supersededGenerations.mockResolvedValue([]);
    mocks.generation.abortingGenerations.mockResolvedValue([]);
    mocks.generation.activeRevision.mockResolvedValue(ACTIVE_REVISION);
    mocks.buildCombinedIncrementalSchemaVisibility.mockResolvedValue(emptySchemaMutation());
    mocks.incrementalSchemaPublicGraphDelta.mockReturnValue({
      upsertSpecs: [],
      deleteSpecIds: [],
      upsertRelations: [],
      deleteRelations: []
    });
    mocks.prepareIncrementalDependencyMutation.mockResolvedValue({
      affectedSpecIds: [],
      affectedContractIds: [],
      upsertSemanticRelations: [],
      upsertRepoDependencies: []
    });
  });

  it("does no graph or lexical writes for a no-op changed-only run", async () => {
    const fixture = createFixture(false);

    const result = await runIndexing(fixture.db, fixture.config, {
      cwd: fixture.cwd,
      changedOnly: true,
      writeMode: "merge"
    });

    expect(result).toMatchObject({
      filesScanned: 20,
      filesChanged: 0,
      lexicalDocumentCount: 7,
      lexicalProjectionDurationMs: 0,
      lexicalWriteDurationMs: 0
    });
    expect(fixture.initializeGeneration).not.toHaveBeenCalled();
    expect(fixture.applyIncrementalIndexMutation).not.toHaveBeenCalled();
    expect(fixture.lexicalStore.applyIncrementalMutation).not.toHaveBeenCalled();
    expect(mocks.runPerRepoIndex).not.toHaveBeenCalled();
    expect(mocks.generation.reserveIncremental).not.toHaveBeenCalled();
    expect(fixture.db.readPublicGraphStats).toHaveBeenCalledOnce();
    expect(fixture.db.stats).not.toHaveBeenCalled();
    expect(fixture.lexicalStore.health).toHaveBeenCalledOnce();
    expect(fixture.lexicalStore.health).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      generation: ACTIVE_GENERATION,
      revision: ACTIVE_REVISION
    });
  });

  it("rejects a missing active lexical stats revision without performing writes", async () => {
    const fixture = createFixture(false);
    fixture.lexicalStore.health.mockResolvedValue({
      ...lexicalHealth(0),
      status: "unhealthy",
      reasons: ["lexical_stats_revision_missing"]
    });

    await expect(runIndexing(fixture.db, fixture.config, {
      cwd: fixture.cwd,
      changedOnly: true,
      writeMode: "merge"
    })).rejects.toThrow(/lexical_stats_revision_missing.*clean generated graph\/internal\/lexical artifacts/u);

    expect(fixture.lexicalStore.health).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      generation: ACTIVE_GENERATION,
      revision: ACTIVE_REVISION
    });
    expect(fixture.initializeGeneration).not.toHaveBeenCalled();
    expect(fixture.applyIncrementalIndexMutation).not.toHaveBeenCalled();
    expect(fixture.lexicalStore.applyIncrementalMutation).not.toHaveBeenCalled();
    expect(mocks.generation.reserveIncremental).not.toHaveBeenCalled();
  });

  it("rejects stale stats metadata on a no-op changed-only run without scanning graph labels", async () => {
    const fixture = createFixture(false);
    vi.mocked(fixture.db.readPublicGraphStats).mockResolvedValue({
      repos: 1,
      files: 7,
      codeNodes: 0,
      sectionNodes: 0,
      callEdges: 0,
      importEdges: 0,
      entities: 0,
      revision: "revision:stale"
    });

    await expect(runIndexing(fixture.db, fixture.config, {
      cwd: fixture.cwd,
      changedOnly: true,
      writeMode: "merge"
    })).rejects.toThrow("does not match active revision");
    expect(fixture.db.stats).not.toHaveBeenCalled();
    expect(fixture.applyIncrementalIndexMutation).not.toHaveBeenCalled();
    expect(fixture.lexicalStore.applyIncrementalMutation).not.toHaveBeenCalled();
  });

  it("publishes only the changed file lexical delta without cloning either active corpus", async () => {
    const fixture = createFixture(true);
    const batchId = "batch:changed-file";
    const changedDocument: LexicalDocument = {
      id: "lexical:file:new",
      canonicalId: fixture.fileId,
      workspaceId: WORKSPACE_ID,
      repoId: fixture.repo.id,
      kind: "file",
      title: "models.ts",
      path: "src/models.ts",
      searchableText: "changed lexical document",
      tokens: ["changed", "lexical", "document"],
      active: true,
      sourceHash: "hash:new",
      batchId,
      renderRef: "render-ref:changed"
    };
    const repoMutation: IncrementalRepoMutation = {
      batchId,
      indexedAt: "2026-08-02T00:00:00.000Z",
      repos: [fixture.repo],
      parsedFiles: [fixture.parsedFile] as IncrementalRepoMutation["parsedFiles"],
      selection: { mode: "merge", fast: false, fallbackToMerge: false },
      publicGraph: {
        facts: emptyGraphFacts({
          batchId,
          repo: fixture.repo,
          generation: ACTIVE_GENERATION
        }),
        touchedFileIds: [fixture.fileId],
        deletedFileIds: [],
        activeFileIdsByRepo: new Map([[fixture.repo.id, [fixture.fileId]]]),
        replacement: {
          sourceFileIds: [fixture.fileId],
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
        }
      },
      schema: emptySchemaMutation(),
      lexical: {
        upsertDocuments: [changedDocument],
        deleteDocumentIds: ["lexical:file:old"]
      },
      summaries: { kind: "none" },
      reconcileLexicalRepos: false,
      lexicalProjectionDurationMs: 1
    };
    mocks.prepareIncrementalWorkspaceIndex.mockImplementation(async ({ ctx }: {
      ctx: { incrementalMutationSet?: IncrementalIndexMutationSet };
    }) => {
      if (!ctx.incrementalMutationSet) throw new Error("missing incremental mutation set");
      addIncrementalRepoMutation(ctx.incrementalMutationSet, repoMutation);
      ctx.incrementalMutationSet.publicGraphStatsDelta = {
        repos: 0,
        files: 0,
        codeNodes: 0,
        sectionNodes: 0,
        callEdges: 0,
        importEdges: 0,
        entities: 0
      };
      return {
        filesScanned: 20,
        filesChanged: 1,
        repos: [fixture.repo],
        batchId,
        lexicalProjectionDurationMs: 1,
        lexicalWriteDurationMs: 0
      };
    });
    mocks.applyIncrementalRepoMutation.mockImplementation(async ({ mutation, deferLexicalWrite }: {
      mutation: IncrementalRepoMutation;
      deferLexicalWrite?: boolean;
    }) => {
      expect(deferLexicalWrite).toBe(true);
      const applied = {
        graphWrite: {
          writerMode: "merge" as const,
          batchId,
          repoNames: [fixture.repo.name],
          repoIds: [fixture.repo.id],
          atomicityMode: "transactional" as const,
          journalStatus: "started" as const,
          recoveredBatchIds: [],
          fallback: false
        },
        filesStaleByRepo: new Map([[fixture.repo.id, 0]])
      };
      mutation.applied = applied;
      return applied;
    });

    const result = await runIndexing(fixture.db, fixture.config, {
      cwd: fixture.cwd,
      changedOnly: true,
      writeMode: "merge"
    });

    expect(result.filesChanged).toBe(1);
    expect(fixture.initializeGeneration).not.toHaveBeenCalled();
    expect(fixture.applyIncrementalIndexMutation).toHaveBeenCalledTimes(1);
    expect(fixture.lexicalStore.applyIncrementalMutation).toHaveBeenCalledOnce();
    expect(fixture.lexicalStore.applyIncrementalMutation).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      generation: ACTIVE_GENERATION,
      expectedRevision: ACTIVE_REVISION,
      nextRevision: expect.stringMatching(/^schema-generation:/),
      upsertDocuments: [changedDocument],
      deleteDocumentIds: ["lexical:file:old"]
    });
    const writtenDocuments = fixture.lexicalStore.applyIncrementalMutation.mock.calls
      .flatMap(([request]) => request.upsertDocuments);
    expect(writtenDocuments).toEqual([changedDocument]);
  });
});
