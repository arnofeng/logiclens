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
    behaviorFingerprintsByRepos: vi.fn(),
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
    behaviorFingerprintsByRepos = mocks.generation.behaviorFingerprintsByRepos;
    abandonIncremental = mocks.generation.abandonIncremental;
    rollback = mocks.generation.rollback;
  }
}));

import { runIndexing } from "../src/core/indexing/run.js";

const WORKSPACE_ID = "workspace:changed-only-delta";
const ACTIVE_GENERATION = "generation:active";
const ACTIVE_REVISION = "revision:active";

function emptySchemaMutation() {
  return {
    sourceFactReplacements: [],
    behaviorFingerprintReplacements: [],
    contributionReplacements: [],
    visibilityChanges: []
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
    mocks.generation.behaviorFingerprintsByRepos.mockResolvedValue([]);
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

  it("does no graph writes for a no-op changed-only run", async () => {
    const fixture = createFixture(false);

    const result = await runIndexing(fixture.db, fixture.config, {
      cwd: fixture.cwd,
      changedOnly: true,
      writeMode: "merge"
    });

    expect(result).toMatchObject({
      filesScanned: 20,
      filesChanged: 0
    });
    expect(fixture.applyIncrementalIndexMutation).not.toHaveBeenCalled();
    expect(mocks.runPerRepoIndex).not.toHaveBeenCalled();
    expect(mocks.generation.reserveIncremental).not.toHaveBeenCalled();
    expect(fixture.db.readPublicGraphStats).toHaveBeenCalledOnce();
    expect(fixture.db.stats).not.toHaveBeenCalled();
  });

  it("forces a clean workspace rebuild when behavior changes without source changes", async () => {
    const fixture = createFixture(false);
    mocks.generation.behaviorFingerprintsByRepos.mockResolvedValue([{
      id: "schema-behavior:old",
      languageId: "typescript",
      repoId: fixture.repo.id,
      resolutionScopeId: "scope:main",
      adapterVersion: "outdated-adapter",
      ruleSetVersion: "non-java-schema-rules-v1",
      serializationVersion: "schema-wire-v2",
      maxDepth: 12,
      maxTypesPerRoot: 256,
      buildInputsHash: "inputs",
      generation: ACTIVE_GENERATION
    }]);
    mocks.planIndexRun
      .mockResolvedValueOnce({
        publicationMode: "incremental",
        activeGeneration: ACTIVE_GENERATION,
        activeRevision: ACTIVE_REVISION,
        runPath: "per-repo",
        writeMode: "merge",
        repoConfigs: fixture.config.repos,
        initialRepoCount: 1,
        batchSize: 0,
        shouldUseCopyBulk: false
      })
      .mockRejectedValueOnce(new Error("clean workspace rebuild planned"));

    await expect(runIndexing(fixture.db, fixture.config, {
      cwd: fixture.cwd,
      changedOnly: true,
      writeMode: "merge"
    })).rejects.toThrow("clean workspace rebuild planned");

    expect(mocks.prepareRepoIndex).toHaveBeenCalledOnce();
    expect(mocks.planIndexRun).toHaveBeenLastCalledWith(expect.objectContaining({
      options: expect.objectContaining({ changedOnly: false })
    }));
    expect(mocks.generation.reserveIncremental).not.toHaveBeenCalled();
    expect(fixture.db.readPublicGraphStats).not.toHaveBeenCalled();
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
  });

  it("publishes only the changed file graph delta without cloning the active graph", async () => {
    const fixture = createFixture(true);
    const batchId = "batch:changed-file";
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
      summaries: { kind: "none" }
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
        batchId
      };
    });
    mocks.applyIncrementalRepoMutation.mockImplementation(async ({ mutation }: {
      mutation: IncrementalRepoMutation;
    }) => {
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
    expect(fixture.applyIncrementalIndexMutation).toHaveBeenCalledTimes(1);
    expect(mocks.applyIncrementalRepoMutation).toHaveBeenCalledOnce();
  });
});
