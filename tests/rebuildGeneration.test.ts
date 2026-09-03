import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KuzuGraphDB } from "../src/adapters/graph-db/kuzu/KuzuGraphDB.js";
import type { PublicGraphGenerationScope } from "../src/core/graph-model/publicGraphGeneration.js";
import { runGenerationSafeRelationRebuild } from "../src/core/graph-model/rebuildGeneration.js";
import type { RepoDependencyEdge, RepoNode } from "../src/core/parsing/types.js";
import { SchemaGenerationStore } from "../src/core/schema/generationStore.js";
import { repoId } from "../src/shared/path.js";

const WORKSPACE_ID = "workspace:relation-rebuild-generation";
const PARENT_GENERATION = "generation:relation-rebuild-parent";

type Fixture = {
  directory: string;
  db: KuzuGraphDB;
  generations: SchemaGenerationStore;
  parentScope: PublicGraphGenerationScope;
  consumer: RepoNode;
  producer: RepoNode;
  original: RepoDependencyEdge;
};

const fixtures: Fixture[] = [];

function repo(name: string): RepoNode {
  return {
    id: repoId(name),
    name,
    path: name,
    remoteUrl: "",
    branch: "main",
    commitSha: "commit:test",
    language: "typescript",
    indexedAt: "2026-08-02T00:00:00.000Z"
  };
}

function dependency(
  consumer: RepoNode,
  producer: RepoNode,
  key: string
): RepoDependencyEdge {
  return {
    fromRepoId: consumer.id,
    toRepoId: producer.id,
    dependencyType: "api",
    sourceContractId: `contract:api:${key}:consumer`,
    targetContractId: `contract:api:${key}:producer`,
    evidenceId: `evidence:${key}`,
    raw: `/api/${key}`,
    confidence: 0.9,
    batchId: `batch:${key}`,
    active: true
  };
}

async function openFixture(): Promise<Fixture> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "repohelix-rebuild-generation-"));
  const db = await KuzuGraphDB.open(path.join(directory, "graph.kuzu"));
  await db.initSchema("relation-rebuild-generation");
  const generations = new SchemaGenerationStore(db, WORKSPACE_ID);
  const parentScope = { workspaceId: WORKSPACE_ID, generation: PARENT_GENERATION };
  const consumer = repo("consumer");
  const producer = repo("producer");
  const original = dependency(consumer, producer, "old");

  await generations.beginFull({
    generation: PARENT_GENERATION,
    createdAt: "2026-08-02T00:00:00.000Z",
    expectedActiveGeneration: null,
    expectedActiveRevision: null
  });
  await db.upsertRepo(consumer, parentScope);
  await db.upsertRepo(producer, parentScope);
  await db.addRepoDependency(original, parentScope);
  await db.initializePublicGraphStats(
    parentScope,
    PARENT_GENERATION,
    await db.computePublicGraphStats(parentScope)
  );
  await generations.appendFullGenerationBatch({
    generation: PARENT_GENERATION,
    facts: {
      declarations: [{ id: "declaration:consumer:model", repoId: consumer.id, sourceFileId: "file:consumer:model" }],
      resolutionContexts: [], resolutionScopeDependencies: [], roots: [], dependencies: [],
      provenance: [], diagnostics: [], fingerprints: []
    },
    contributions: []
  });
  await generations.validateFull(PARENT_GENERATION);
  await generations.commitFull(PARENT_GENERATION);

  const fixture = {
    directory,
    db,
    generations,
    parentScope,
    consumer,
    producer,
    original
  };
  fixtures.push(fixture);
  return fixture;
}

async function dependencies(
  db: KuzuGraphDB,
  scope: PublicGraphGenerationScope
): Promise<Array<{ raw: string; batchId: string }>> {
  return db.query<{ raw: string; batchId: string }>(
    "MATCH (a:Repo)-[r:DEPENDS_ON]->(b:Repo) " +
    "WHERE a.workspaceId=$workspaceId AND a.generation=$generation " +
    "AND b.workspaceId=$workspaceId AND b.generation=$generation " +
    "AND r.workspaceId=$workspaceId AND r.generation=$generation " +
    "RETURN r.raw AS raw, r.batchId AS batchId ORDER BY raw;",
    scope
  );
}

async function generationCount(db: KuzuGraphDB, generation: string): Promise<number> {
  const rows = await db.query<{ count: number | bigint }>(
    "MATCH (g:SchemaGeneration {id: $generation}) RETURN count(g) AS count;",
    { generation }
  );
  return Number(rows[0]?.count ?? 0);
}

afterEach(async () => {
  vi.restoreAllMocks();
  while (fixtures.length > 0) {
    const fixture = fixtures.pop()!;
    await fixture.db.close();
    await fs.rm(fixture.directory, { recursive: true, force: true });
  }
});

describe("generation-safe relation rebuild", () => {
  it("rolls back an incremental relation delta and leaves the active revision exact", async () => {
    const fixture = await openFixture();
    const replacement = dependency(fixture.consumer, fixture.producer, "new");
    const originalRevision = await fixture.generations.activeRevision();
    const originalStats = await fixture.db.readPublicGraphStats(fixture.parentScope);
    let callbackGeneration = "";

    await expect(runGenerationSafeRelationRebuild({
      db: fixture.db,
      workspaceId: WORKSPACE_ID
    }, async (scope) => {
      callbackGeneration = scope.generation;
      await fixture.db.clearRepoDependencies(undefined, scope);
      await fixture.db.addRepoDependency(replacement, scope);
      throw new Error("injected rebuild validation failure");
    })).rejects.toThrow("injected rebuild validation failure");

    expect(await fixture.generations.activeGeneration()).toBe(PARENT_GENERATION);
    expect(await fixture.generations.activeRevision()).toBe(originalRevision);
    expect(await fixture.db.readPublicGraphStats(fixture.parentScope)).toEqual(originalStats);
    expect(callbackGeneration).toBe(PARENT_GENERATION);
    expect(await dependencies(fixture.db, fixture.parentScope)).toEqual([
      { raw: fixture.original.raw, batchId: fixture.original.batchId }
    ]);
    expect(await generationCount(fixture.db, PARENT_GENERATION)).toBe(1);
    expect(await fixture.db.query<{ id: string }>(
      "MATCH (n:TypeDeclarationFact) WHERE n.generation=$generation RETURN n.id AS id;",
      { generation: PARENT_GENERATION }
    )).toHaveLength(1);
  }, 30_000);

  it("atomically publishes the relation delta by advancing only the logical revision", async () => {
    const fixture = await openFixture();
    const replacement = dependency(fixture.consumer, fixture.producer, "new");
    const originalRevision = await fixture.generations.activeRevision();

    const rebuilt = await runGenerationSafeRelationRebuild({
      db: fixture.db,
      workspaceId: WORKSPACE_ID
    }, async (scope) => {
      await fixture.db.clearRepoDependencies(undefined, scope);
      await fixture.db.addRepoDependency(replacement, scope);
      return [replacement];
    });

    const activeGeneration = await fixture.generations.activeGeneration();
    expect(rebuilt).toEqual([replacement]);
    expect(activeGeneration).toBe(PARENT_GENERATION);
    expect(await fixture.generations.activeRevision()).not.toBe(originalRevision);
    expect((await fixture.db.readPublicGraphStats(fixture.parentScope))?.revision)
      .toBe(await fixture.generations.activeRevision());
    expect(await dependencies(fixture.db, fixture.parentScope))
      .toEqual([{ raw: replacement.raw, batchId: replacement.batchId }]);
    expect(await fixture.generations.factsBySources(
      "declarations",
      [{ repoId: fixture.consumer.id, fileId: "file:consumer:model" }],
      PARENT_GENERATION
    )).toEqual([
      expect.objectContaining({ id: "declaration:consumer:model" })
    ]);
  }, 30_000);

  it("does not garbage-collect a physical generation for an incremental rebuild", async () => {
    const fixture = await openFixture();
    const graphDelete = vi.spyOn(fixture.db, "deletePublicGraphGeneration");
    const originalRevision = await fixture.generations.activeRevision();

    await expect(runGenerationSafeRelationRebuild({
      db: fixture.db,
      workspaceId: WORKSPACE_ID
    }, async () => [])).resolves.toEqual([]);

    expect(await fixture.generations.activeGeneration()).toBe(PARENT_GENERATION);
    expect(await fixture.generations.activeRevision()).not.toBe(originalRevision);
    expect(graphDelete).not.toHaveBeenCalled();
  }, 30_000);
});
