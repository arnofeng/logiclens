import type { GraphDB } from "../../src/core/graph-model/db.js";
import type { PublicGraphGenerationScope } from "../../src/core/graph-model/publicGraphGeneration.js";
import { createPublicGraphReadSnapshot, type PublicGraphReadSnapshot } from "../../src/core/graph-model/readSnapshot.js";
import { SchemaGenerationStore } from "../../src/core/schema/generationStore.js";

export async function stageAndActivatePublicGraphGeneration<T>(
  db: GraphDB,
  scope: PublicGraphGenerationScope,
  write: (scope: PublicGraphGenerationScope) => Promise<T>
): Promise<{ result: T; snapshot: PublicGraphReadSnapshot }> {
  const generations = new SchemaGenerationStore(db, scope.workspaceId);
  await generations.beginFull({
    generation: scope.generation,
    createdAt: "test",
    expectedActiveGeneration: (await generations.activeGeneration()) ?? null,
    expectedActiveRevision: (await generations.activeRevision()) ?? null
  });
  try {
    const result = await write(scope);
    try {
      await db.initializePublicGraphStats(scope, scope.generation, await db.computePublicGraphStats(scope));
    } catch (error) {
      throw new Error("Failed to initialize full-snapshot public graph stats.", { cause: error });
    }
    try {
      await generations.validateFull(scope.generation);
      await generations.commitFull(scope.generation);
    } catch (error) {
      throw new Error("Failed to commit full-snapshot generation metadata.", { cause: error });
    }
    return {
      result,
      snapshot: createPublicGraphReadSnapshot({ ...scope, revision: scope.generation })
    };
  } catch (error) {
    await generations.abandonFull(scope.generation);
    await generations.rollback(scope.generation);
    throw error;
  }
}
