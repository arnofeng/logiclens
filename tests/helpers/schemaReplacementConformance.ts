import { expect } from "vitest";
import { withTransaction, type GraphDB } from "../../src/core/graph-model/db.js";
import { SchemaGenerationStore } from "../../src/core/schema/generationStore.js";

export async function runSchemaReplacementConformance(db: GraphDB, workspaceId: string): Promise<void> {
  const store = new SchemaGenerationStore(db, workspaceId);
  const generation = `${workspaceId}:dataset`;
  const baseRevision = generation;
  const nextRevision = `${workspaceId}:revision:next`;
  const failedRevision = `${workspaceId}:revision:failed`;
  const specId = `${workspaceId}:spec:shared`;

  await store.beginFull({
    generation,
    createdAt: "2026-01-01T00:00:00.000Z",
    expectedActiveGeneration: null,
    expectedActiveRevision: null
  });
  await store.replaceSourceFacts({
    generation,
    kind: "declarations",
    repoId: "repo:a",
    fileId: "file:a",
    facts: [{ id: "declaration:a", repoId: "repo:a", sourceFileId: "file:a" }]
  });
  await store.replaceSourceFacts({
    generation,
    kind: "declarations",
    repoId: "repo:a",
    fileId: "file:b",
    facts: [{ id: "declaration:b", repoId: "repo:a", sourceFileId: "file:b" }]
  });
  await store.replaceContributions({
    generation,
    rootReferenceId: "root:a",
    contributions: [{ entityKind: "schema-spec", entityId: specId }]
  });
  await store.replaceContributions({
    generation,
    rootReferenceId: "root:b",
    contributions: [{ entityKind: "schema-spec", entityId: specId }]
  });
  await store.commitFull(generation);

  expect(await store.activeGeneration()).toBe(generation);
  expect(await store.activeRevision()).toBe(baseRevision);
  const oneRoot = await store.contributionVisibilityForReplacements({
    generation,
    replacements: [{ rootReferenceId: "root:a", contributions: [] }]
  });
  expect(oneRoot).toEqual([expect.objectContaining({
    entityKind: "schema-spec",
    entityId: specId,
    previousCount: 2,
    nextCount: 1
  })]);

  await store.reserveIncremental({
    revision: nextRevision,
    expectedActiveGeneration: generation,
    expectedActiveRevision: baseRevision
  });
  await withTransaction(db, async () => {
    await store.replaceActiveSourceFacts({
      generation,
      kind: "declarations",
      repoId: "repo:a",
      fileId: "file:a",
      facts: []
    });
    await store.replaceActiveContributions({ generation, rootReferenceId: "root:a", contributions: [] });
    await store.commitIncremental(nextRevision);
  });

  expect(await store.activeGeneration()).toBe(generation);
  expect(await store.activeRevision()).toBe(nextRevision);
  expect((await store.factsBySources("declarations", [{ repoId: "repo:a", fileId: "file:b" }], generation))
    .map((fact) => fact.id)).toEqual(["declaration:b"]);
  expect(await store.activeContributionCount("schema-spec", specId)).toBe(1);

  await store.reserveIncremental({
    revision: failedRevision,
    expectedActiveGeneration: generation,
    expectedActiveRevision: nextRevision
  });
  await expect(withTransaction(db, async () => {
    await store.replaceActiveSourceFacts({
      generation,
      kind: "declarations",
      repoId: "repo:a",
      fileId: "file:b",
      facts: []
    });
    throw new Error("injected incremental failure");
  })).rejects.toThrow(/injected incremental failure/u);
  await store.abandonIncremental(failedRevision);

  expect(await store.activeGeneration()).toBe(generation);
  expect(await store.activeRevision()).toBe(nextRevision);
  expect((await store.factsBySources("declarations", [{ repoId: "repo:a", fileId: "file:b" }], generation))
    .map((fact) => fact.id)).toEqual(["declaration:b"]);
}
