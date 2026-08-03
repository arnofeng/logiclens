import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { describe, it } from "vitest";
import { Neo4jGraphDB } from "../src/adapters/graph-db/neo4j/Neo4jGraphDB.js";
import { prepareContractSchemaReleaseCorpus, runContractSchemaReleaseConformance } from "./helpers/contractSchemaReleaseHarness.js";
import { resolveNeo4jTestEnvironment, runNeo4jCleanupSteps } from "./helpers/neo4jTestEnvironment.js";
import { deriveWorkspaceId } from "../src/core/workspace/identity.js";

const integration = resolveNeo4jTestEnvironment();

describe("contract-schema-release Neo4j conformance", () => {
  it.skipIf(!integration.enabled)(integration.testName, async () => {
    const configuration = integration.requireConfiguration();
    const corpus = await prepareContractSchemaReleaseCorpus();
    const suffix = randomUUID().replaceAll("-", "");
    corpus.config.systemName = `contract-schema-release-${suffix}`;
    const workspaceId = deriveWorkspaceId(corpus.config.systemName);
    const db = await Neo4jGraphDB.open(configuration.url, {
      username: configuration.username,
      password: configuration.password,
      database: configuration.database
    });
    let failure: unknown;
    try {
      await db.initSchema(corpus.config.systemName);
      await runContractSchemaReleaseConformance({ db, corpusDirectory: corpus.directory, config: corpus.config, groundTruth: corpus.groundTruth, manifest: corpus.manifest });
    } catch (error) {
      failure = error;
    }
    let cleanupFailure: unknown;
    try {
      await runNeo4jCleanupSteps([
        { name: "delete release corpus workspace", run: () => db.query("MATCH (n) WHERE n.workspaceId=$workspaceId DETACH DELETE n;", { workspaceId }) },
        { name: "close database", run: () => db.close() },
        { name: "remove corpus copy", run: () => fs.rm(corpus.directory, { recursive: true, force: true }) }
      ]);
    } catch (error) {
      cleanupFailure = error;
    }
    if (failure && cleanupFailure) throw new AggregateError([failure, cleanupFailure]);
    if (failure) throw failure;
    if (cleanupFailure) throw cleanupFailure;
  }, 180_000);
});
