import { describe, expect, it, vi, beforeEach } from "vitest";
import type { GraphDB, ActiveAliasOverride } from "../src/core/graph-model/db.js";
import type { RepoNode, ParsedGraphFile } from "../src/core/parsing/types.js";

// Mock external dependencies used by upsertParsedFiles
vi.mock("../src/core/graph-model/facts.js", () => ({
  buildGraphFactsBatch: vi.fn().mockResolvedValue({
    batchId: "test", indexedAt: "2026-06-22T00:00:00.000Z",
    repos: [], parsedFiles: [],
    files: [], code: [], sections: [], entities: [], operations: [], workflows: [],
    contracts: [], evidence: [], contains: [], imports: [], calls: [], mentions: [],
    sectionDescribesRepos: [], sectionDocumentsCode: [], sectionReferencesFile: [],
    repoContracts: [], packageUsages: [], contractEntities: [], operationRepos: [],
    workflowOperations: [], repoDependencies: [],
    contractSpecs: [], contractSpecEdges: [], semanticRelations: [],
    crossRepo: { contracts: [], evidence: [], repoDependencies: [], packageUsages: [], contractEntities: [], workflowOperations: [] }
  })
}));
vi.mock("../src/core/semantic/summarizeGraph.js", () => ({
  summarizeReposAndSystem: vi.fn().mockResolvedValue({ repoSummaries: [], systemSummary: "" })
}));

import { upsertParsedFiles } from "../src/core/graph-model/upsert.js";
import { upsertAliasOverride } from "../src/features/quality/quality.js";
import { buildGraphFactsBatch } from "../src/core/graph-model/facts.js";

const repoA: RepoNode = {
  id: "repo:a", name: "service-a", path: "/tmp/a",
  remoteUrl: "", branch: "main", commitSha: "abc", language: "typescript", indexedAt: "2026-06-22T00:00:00.000Z"
};

const repoB: RepoNode = {
  id: "repo:b", name: "service-b", path: "/tmp/b",
  remoteUrl: "", branch: "main", commitSha: "def", language: "typescript", indexedAt: "2026-06-22T00:00:00.000Z"
};

const parsedA: ParsedGraphFile = {
  fileId: "file:a:ts", repoId: "repo:a", path: "src/index.ts", language: "typescript",
  hash: "h1", loc: 10, symbols: [], imports: [], calls: []
};

function createMockDb(overrides: Partial<GraphDB> = {}): GraphDB {
  return {
    initSchema: vi.fn(), upsertRepo: vi.fn(), updateRepoSummary: vi.fn(),
    updateSystemSummary: vi.fn(), upsertFile: vi.fn(), upsertCode: vi.fn(),
    upsertSection: vi.fn(), upsertEntity: vi.fn(), upsertOperation: vi.fn(),
    upsertWorkflow: vi.fn(), upsertContract: vi.fn(), upsertEvidence: vi.fn(),
    addRepoContract: vi.fn(), addRepoDependency: vi.fn(), addRepoDependenciesBatch: vi.fn(),
    addPackageUsage: vi.fn(), addContractEntity: vi.fn(), addOperationRepo: vi.fn(),
    addWorkflowOperation: vi.fn(), upsertContractSpec: vi.fn(), addHasSpec: vi.fn(),
    addSemanticRelation: vi.fn(), addSemanticRelationsBatch: vi.fn(), addContractEvidence: vi.fn(), addRepoEvidence: vi.fn(),
    addContains: vi.fn(), addImport: vi.fn(), addCall: vi.fn(), addMention: vi.fn(),
    addSectionMention: vi.fn(), addSectionDescribesRepo: vi.fn(),
    addSectionDocumentsCode: vi.fn(), addSectionReferencesFile: vi.fn(),
    clearRepoDependencies: vi.fn(), clearRepoIndexedArtifacts: vi.fn(),
    beginGraphWriteBatch: vi.fn(), commitGraphWriteBatch: vi.fn(),
    failGraphWriteBatch: vi.fn(), recoverIncompleteGraphWriteBatches: vi.fn(),
    cleanupGraphWriteBatch: vi.fn(), markRepoArtifactsStale: vi.fn(),
    upsertIndexState: vi.fn(), knownFileHashes: vi.fn(), repoCount: vi.fn(),
    listRepos: vi.fn().mockResolvedValue([]),
    listActiveAliasOverrides: vi.fn().mockResolvedValue([]),
    rejectEvidence: vi.fn(), upsertAliasOverride: vi.fn(),
    listContracts: vi.fn(), query: vi.fn(), stats: vi.fn(), close: vi.fn(),
    ...overrides
  } as unknown as GraphDB;
}

describe("listActiveAliasOverrides integration in upsertParsedFiles", () => {
  beforeEach(() => {
    vi.mocked(buildGraphFactsBatch).mockClear();
  });

  it("calls db.listActiveAliasOverrides and passes results to buildGraphFactsBatch", async () => {
    const overrides: ActiveAliasOverride[] = [
      { alias: "old-name", targetRepoId: "repo:a" }
    ];
    const db = createMockDb({
      listActiveAliasOverrides: vi.fn().mockResolvedValue(overrides)
    });

    await upsertParsedFiles(db, [], true, [repoA]);

    expect(db.listActiveAliasOverrides).toHaveBeenCalledOnce();
    expect(buildGraphFactsBatch).toHaveBeenCalledWith(
      expect.objectContaining({ aliasOverrides: overrides })
    );
  });

  it("passes empty array when listActiveAliasOverrides returns empty", async () => {
    const db = createMockDb({
      listActiveAliasOverrides: vi.fn().mockResolvedValue([])
    });

    await upsertParsedFiles(db, [], true, [repoA]);

    expect(buildGraphFactsBatch).toHaveBeenCalledWith(
      expect.objectContaining({ aliasOverrides: [] })
    );
  });
});

describe("listRepos fallback in upsertParsedFiles", () => {
  beforeEach(() => {
    vi.mocked(buildGraphFactsBatch).mockClear();
  });

  it("calls db.listRepos when repos argument is not provided", async () => {
    const db = createMockDb({
      listRepos: vi.fn().mockResolvedValue([repoA, repoB])
    });

    await upsertParsedFiles(db, [parsedA], true);

    expect(db.listRepos).toHaveBeenCalledOnce();
    expect(buildGraphFactsBatch).toHaveBeenCalledWith(
      expect.objectContaining({ repos: [repoA] })
    );
  });

  it("does not call db.listRepos when repos argument is provided", async () => {
    const listRepos = vi.fn().mockResolvedValue([repoA, repoB]);
    const db = createMockDb({ listRepos });

    await upsertParsedFiles(db, [parsedA], true, [repoA]);

    expect(listRepos).not.toHaveBeenCalled();
  });
});

describe("upsertAliasOverride delegation", () => {
  it("delegates to db.upsertAliasOverride with the correct input", async () => {
    const mockUpsert = vi.fn().mockResolvedValue(undefined);
    const db = createMockDb({ upsertAliasOverride: mockUpsert });

    await upsertAliasOverride(db, { alias: "my-alias", targetRepoId: "repo:a", reason: "Manual override" });

    expect(mockUpsert).toHaveBeenCalledWith({
      alias: "my-alias",
      targetRepoId: "repo:a",
      reason: "Manual override"
    });
  });
});
