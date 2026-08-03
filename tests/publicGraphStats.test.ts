import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { KuzuGraphDB } from "../src/adapters/graph-db/kuzu/KuzuGraphDB.js";
import type { GraphFactsBatch } from "../src/core/graph-model/facts.js";
import { withTransaction } from "../src/core/graph-model/db.js";
import type { PublicGraphGenerationScope } from "../src/core/graph-model/publicGraphGeneration.js";
import type {
  CodeSymbol,
  EntityNode,
  FileNode,
  RepoNode
} from "../src/core/parsing/types.js";
import type { IncrementalPublicGraphReplacementPlan } from "../src/core/indexing/graphWrite.js";
import { prepareIncrementalPublicGraphStatsDelta } from "../src/core/indexing/publicGraphStats.js";

const WORKSPACE_ID = "workspace:public-graph-stats";
const GENERATION = "generation:public-graph-stats";
const REVISION_ONE = "revision:one";
const REVISION_TWO = "revision:two";
const scope: PublicGraphGenerationScope = { workspaceId: WORKSPACE_ID, generation: GENERATION };
const directories: string[] = [];
let previousCloseMode: string | undefined;

const repo: RepoNode = {
  id: "repo:stats",
  name: "stats",
  path: "fixtures/stats",
  remoteUrl: "",
  branch: "main",
  commitSha: "commit:stats",
  language: "typescript",
  indexedAt: "2026-08-02T00:00:00.000Z"
};

function file(id: string, sourcePath: string): FileNode {
  return {
    id,
    repoId: repo.id,
    path: sourcePath,
    directory: path.posix.dirname(sourcePath),
    language: "typescript",
    hash: `hash:${id}`,
    loc: 1,
    batchId: "batch:old",
    indexedAt: "2026-08-02T00:00:00.000Z",
    active: true
  };
}

function code(id: string, fileId: string): CodeSymbol {
  return {
    id,
    repoId: repo.id,
    fileId,
    kind: "function",
    name: id,
    qualifiedName: id,
    startLine: 1,
    endLine: 1,
    signature: `${id}()`,
    source: `function ${id}() {}`,
    hash: `hash:${id}`,
    batchId: "batch:old",
    indexedAt: "2026-08-02T00:00:00.000Z",
    active: true
  };
}

function entity(id: string): EntityNode {
  return { id, name: id, kind: "domain", description: id };
}

function incrementalFacts(input: {
  changedFile: FileNode;
  changedCode: CodeSymbol;
  targetCode: CodeSymbol;
  changedEntity: EntityNode;
  unchangedFile: FileNode;
}): GraphFactsBatch {
  return {
    batchId: "batch:next",
    workspaceId: WORKSPACE_ID,
    generation: GENERATION,
    systemName: "public-graph-stats",
    indexedAt: "2026-08-02T01:00:00.000Z",
    repos: [repo],
    parsedFiles: [],
    files: [{ ...input.changedFile, batchId: "batch:next" }],
    code: [{ ...input.changedCode, batchId: "batch:next" }],
    sections: [],
    entities: [input.changedEntity],
    operations: [],
    workflows: [],
    contracts: [],
    evidence: [],
    contains: [],
    imports: [{
      fromFileId: input.changedFile.id,
      toFileId: input.unchangedFile.id,
      module: "./unchanged",
      raw: "import './unchanged'",
      batchId: "batch:next",
      active: true
    }],
    calls: [{
      fromCodeId: input.changedCode.id,
      toCodeId: input.targetCode.id,
      confidence: 1,
      resolution: "exact",
      raw: "unchanged()",
      batchId: "batch:next",
      active: true
    }],
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

async function openDb(): Promise<KuzuGraphDB> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "repohelix-public-graph-stats-"));
  directories.push(directory);
  const db = await KuzuGraphDB.open(path.join(directory, "graph.kuzu"));
  await db.initSchema("public-graph-stats");
  return db;
}

beforeAll(() => {
  previousCloseMode = process.env.REPOHELIX_KUZU_CLOSE_MODE;
  process.env.REPOHELIX_KUZU_CLOSE_MODE = "explicit";
});

afterAll(() => {
  if (previousCloseMode === undefined) delete process.env.REPOHELIX_KUZU_CLOSE_MODE;
  else process.env.REPOHELIX_KUZU_CLOSE_MODE = previousCloseMode;
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

describe("public graph stats metadata", () => {
  it("prepares a targeted delta, rolls it back atomically, and converges with a full count", async () => {
    const statsReadSpy = vi.spyOn(KuzuGraphDB.prototype, "query");
    const db = await openDb();
    const changedFile = file("file:stats:changed.ts", "src/changed.ts");
    const unchangedFile = file("file:stats:unchanged.ts", "src/unchanged.ts");
    const deletedFile = file("file:stats:deleted.ts", "src/deleted.ts");
    const oldChangedCode = code("code:stats:changed-old", changedFile.id);
    const unchangedCode = code("code:stats:unchanged", unchangedFile.id);
    const deletedCode = code("code:stats:deleted", deletedFile.id);
    const nextChangedCode = code("code:stats:changed-next", changedFile.id);
    const oldEntity = entity("entity:stats:old");
    const nextEntity = entity("entity:stats:next");
    const facts = incrementalFacts({
      changedFile,
      changedCode: nextChangedCode,
      targetCode: unchangedCode,
      changedEntity: nextEntity,
      unchangedFile
    });
    const replacement: IncrementalPublicGraphReplacementPlan = {
      sourceFileIds: [changedFile.id, deletedFile.id],
      deletedFileIds: [deletedFile.id],
      existingEvidenceIds: [],
      staleCodeIds: [oldChangedCode.id, deletedCode.id],
      staleSectionIds: [],
      staleEvidenceIds: [],
      staleSpecIds: [],
      orphanEntityIds: [oldEntity.id],
      orphanOperationIds: [],
      orphanWorkflowIds: [],
      orphanContractIds: []
    };

    try {
      await db.upsertRepo(repo, scope);
      for (const item of [changedFile, unchangedFile, deletedFile]) await db.upsertFile(item, scope);
      for (const item of [oldChangedCode, unchangedCode, deletedCode]) await db.upsertCode(item, scope);
      await db.upsertEntity(oldEntity, scope);
      await db.addImport({
        fromFileId: changedFile.id,
        toFileId: unchangedFile.id,
        module: "./unchanged",
        raw: "import './unchanged'",
        active: true
      }, scope);
      await db.addImport({
        fromFileId: unchangedFile.id,
        toFileId: deletedFile.id,
        module: "./deleted",
        raw: "import './deleted'",
        active: true
      }, scope);
      await db.addCall({
        fromCodeId: oldChangedCode.id,
        toCodeId: unchangedCode.id,
        confidence: 1,
        resolution: "exact",
        raw: "unchanged()",
        active: true
      }, scope);
      await db.addCall({
        fromCodeId: unchangedCode.id,
        toCodeId: deletedCode.id,
        confidence: 1,
        resolution: "exact",
        raw: "deleted()",
        active: true
      }, scope);
      await db.initializePublicGraphStats(scope, REVISION_ONE, await db.computePublicGraphStats(scope));
      const missingScope = { workspaceId: WORKSPACE_ID, generation: "generation:stats-missing" };
      statsReadSpy.mockClear();
      await expect(db.stats(missingScope)).rejects.toThrow(/stats metadata is missing/u);
      expect(statsReadSpy.mock.calls.map(([query]) => query)).toHaveLength(1);
      expect(statsReadSpy.mock.calls[0]?.[0]).toContain("PublicGraphStats");
      expect(statsReadSpy.mock.calls[0]?.[0]).not.toContain("count(");

      statsReadSpy.mockClear();
      expect(await db.stats(scope)).toEqual(expect.objectContaining({
        repos: 1,
        files: 3,
        codeNodes: 3,
        callEdges: 2,
        importEdges: 2,
        entities: 1
      }));
      expect(statsReadSpy.mock.calls.map(([query]) => query)).toHaveLength(1);
      expect(statsReadSpy.mock.calls[0]?.[0]).toContain("PublicGraphStats");
      statsReadSpy.mockClear();

      const prepared = await prepareIncrementalPublicGraphStatsDelta({
        db,
        scope,
        facts,
        replacement,
        expectedRevision: REVISION_ONE
      });
      expect(prepared.delta).toEqual({
        repos: 0,
        files: -1,
        codeNodes: -1,
        sectionNodes: 0,
        callEdges: -1,
        importEdges: -1,
        entities: 0
      });
      expect(prepared.next).toEqual({
        repos: 1,
        files: 2,
        codeNodes: 2,
        sectionNodes: 0,
        callEdges: 1,
        importEdges: 1,
        entities: 1
      });
      const preparationQueries = statsReadSpy.mock.calls.map(([query]) => query);
      expect(preparationQueries.some((query) => query.includes("RETURN count("))).toBe(false);
      expect(preparationQueries).toEqual(expect.arrayContaining([
        expect.stringContaining("source.fileId IN $sourceFileIds OR target.id IN $staleCodeIds"),
        expect.stringContaining("source.id IN $sourceFileIds OR target.id IN $deletedFileIds")
      ]));

      const applyGraphDelta = async (): Promise<void> => {
        const base = { workspaceId: WORKSPACE_ID, generation: GENERATION };
        await db.query(
          "MATCH (source:Code)-[r:CALLS]->(target:Code) " +
          "WHERE source.workspaceId=$workspaceId AND source.generation=$generation " +
          "AND target.workspaceId=$workspaceId AND target.generation=$generation " +
          "AND r.workspaceId=$workspaceId AND r.generation=$generation " +
          "AND (source.fileId IN $sourceFileIds OR target.id IN $staleCodeIds) DELETE r;",
          { ...base, sourceFileIds: replacement.sourceFileIds, staleCodeIds: replacement.staleCodeIds }
        );
        await db.query(
          "MATCH (source:File)-[r:IMPORTS]->(target:File) " +
          "WHERE source.workspaceId=$workspaceId AND source.generation=$generation " +
          "AND target.workspaceId=$workspaceId AND target.generation=$generation " +
          "AND r.workspaceId=$workspaceId AND r.generation=$generation " +
          "AND (source.id IN $sourceFileIds OR target.id IN $deletedFileIds) DELETE r;",
          { ...base, sourceFileIds: replacement.sourceFileIds, deletedFileIds: replacement.deletedFileIds }
        );
        await db.query(
          "MATCH (n:Code) WHERE n.workspaceId=$workspaceId AND n.generation=$generation AND n.id IN $ids DETACH DELETE n;",
          { ...base, ids: replacement.staleCodeIds }
        );
        await db.query(
          "MATCH (n:File) WHERE n.workspaceId=$workspaceId AND n.generation=$generation AND n.id IN $ids DETACH DELETE n;",
          { ...base, ids: replacement.deletedFileIds }
        );
        await db.query(
          "MATCH (n:Entity) WHERE n.workspaceId=$workspaceId AND n.generation=$generation AND n.id IN $ids DETACH DELETE n;",
          { ...base, ids: replacement.orphanEntityIds }
        );
        await db.upsertFile(facts.files[0]!, scope);
        await db.upsertCode(facts.code[0]!, scope);
        await db.upsertEntity(facts.entities[0]!, scope);
        await db.addImport(facts.imports[0]!, scope);
        await db.addCall(facts.calls[0]!, scope);
      };

      const beforeStats = await db.readPublicGraphStats(scope);
      const beforePhysical = await db.computePublicGraphStats(scope);
      await expect(withTransaction(db, async () => {
        await applyGraphDelta();
        await db.applyPublicGraphStatsDelta(scope, {
          expectedRevision: REVISION_ONE,
          nextRevision: REVISION_TWO,
          delta: prepared.delta
        });
        throw new Error("injected failure after stats update");
      })).rejects.toThrow("injected failure after stats update");
      expect(await db.readPublicGraphStats(scope)).toEqual(beforeStats);
      expect(await db.computePublicGraphStats(scope)).toEqual(beforePhysical);

      await withTransaction(db, async () => {
        await applyGraphDelta();
        await db.applyPublicGraphStatsDelta(scope, {
          expectedRevision: REVISION_ONE,
          nextRevision: REVISION_TWO,
          delta: prepared.delta
        });
      });
      const committed = await db.readPublicGraphStats(scope);
      expect(committed?.revision).toBe(REVISION_TWO);
      expect(committed && (({ revision: _revision, ...stats }) => stats)(committed))
        .toEqual(await db.computePublicGraphStats(scope));
      await db.query(
        "MATCH (s:PublicGraphStats) WHERE s.workspaceId=$workspaceId AND s.generation=$generation DELETE s;",
        scope
      );
      await expect(prepareIncrementalPublicGraphStatsDelta({
        db,
        scope,
        facts,
        replacement,
        expectedRevision: REVISION_TWO
      })).rejects.toThrow("metadata is missing");
      await db.initializePublicGraphStats(scope, "revision:stale", await db.computePublicGraphStats(scope));
      await expect(prepareIncrementalPublicGraphStatsDelta({
        db,
        scope,
        facts,
        replacement,
        expectedRevision: REVISION_TWO
      })).rejects.toThrow("does not match incremental parent");
    } finally {
      await db.close();
    }
  }, 30_000);
});
