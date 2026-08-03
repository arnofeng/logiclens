import { randomUUID } from "node:crypto";
import { describe, it } from "vitest";
import { Neo4jGraphDB } from "../src/adapters/graph-db/neo4j/Neo4jGraphDB.js";
import { resolveNeo4jTestEnvironment, runNeo4jCleanupSteps } from "./helpers/neo4jTestEnvironment.js";
import { runSchemaReplacementConformance } from "./helpers/schemaReplacementConformance.js";

const integration = resolveNeo4jTestEnvironment();

describe("Neo4j schema replacement conformance", () => {
  it.skipIf(!integration.enabled)(integration.testName, async () => {
    const configuration = integration.requireConfiguration();
    const suffix = randomUUID().replace(/-/gu, "");
    const workspaceId = `workspace:schema-replacement:${suffix}`;
    const db = await Neo4jGraphDB.open(configuration.url, {
      username: configuration.username,
      password: configuration.password,
      database: configuration.database
    });
    let failure: unknown;
    try {
      await db.initSchema(`schema-replacement-${suffix}`);
      await runSchemaReplacementConformance(db, workspaceId);
    } catch (error) {
      failure = error;
    }
    let cleanupFailure: unknown;
    try {
      await runNeo4jCleanupSteps([
        { name: "delete schema replacement facts", run: () => db.query(
          "MATCH (n) WHERE (n:SchemaGeneration AND n.workspaceId = $workspaceId) OR (n:SchemaGenerationState AND n.workspaceId = $workspaceId) OR (n.generation IS NOT NULL AND n.generation STARTS WITH $workspaceId) DETACH DELETE n;",
          { workspaceId }
        ) },
        { name: "close database", run: () => db.close() }
      ]);
    } catch (error) {
      cleanupFailure = error;
    }
    if (failure && cleanupFailure) throw new AggregateError([failure, cleanupFailure]);
    if (failure) throw failure;
    if (cleanupFailure) throw cleanupFailure;
  }, 120000);
});
