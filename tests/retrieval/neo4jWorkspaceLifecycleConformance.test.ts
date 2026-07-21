import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Neo4jGraphDB } from "../../src/adapters/graph-db/neo4j/Neo4jGraphDB.js";
import { Neo4jWorkspaceLexicalStore } from "../../src/adapters/graph-db/neo4j/Neo4jWorkspaceLexicalStore.js";
import { runWorkspaceLifecycleConformance, type WorkspaceLifecycleFixture } from "./workspaceLifecycleConformanceHarness.js";
import { resolveNeo4jTestEnvironment, runNeo4jCleanupSteps } from "../helpers/neo4jTestEnvironment.js";

const integration = resolveNeo4jTestEnvironment();

describe("Neo4j workspace lifecycle conformance", () => {
  it.skipIf(!integration.enabled)(
    integration.testName,
    async () => {
      const configuration = integration.requireConfiguration();
      const suffix = randomUUID().replace(/-/g, "");
      const workspaceId = `workspace:neo4j-conformance:${suffix}`;
      const indexName = `workspace_lexical_${suffix}`;
      const open = () => Neo4jGraphDB.open(configuration.url, {
        username: configuration.username,
        password: configuration.password,
        database: configuration.database
      });
      let db: Neo4jGraphDB | undefined;
      let store: Neo4jWorkspaceLexicalStore | undefined;
      let baselineCaptured = false;
      let initializationStarted = false;
      let previousSystem: { name: string; summary: string } | null = null;
      let testFailure: unknown;

      const currentDb = (): Neo4jGraphDB => {
        if (!db) throw new Error("Neo4j conformance database is not open.");
        return db;
      };
      const currentStore = (): Neo4jWorkspaceLexicalStore => {
        if (!store) throw new Error("Neo4j conformance lexical store is not open.");
        return store;
      };
      try {
        db = await open();
        store = new Neo4jWorkspaceLexicalStore(db, { indexName });
        previousSystem = (await db.query<{ name: string; summary: string }>(
          "MATCH (s:System {id: 'system:default'}) RETURN s.name AS name, s.summary AS summary;"
        ))[0] ?? null;
        baselineCaptured = true;
        const fixture: WorkspaceLifecycleFixture = {
          get db() { return currentDb(); },
          get store() { return currentStore(); },
          workspaceId,
          suffix,
          async reopen() {
            await currentDb().close();
            db = undefined;
            store = undefined;
            db = await open();
            store = new Neo4jWorkspaceLexicalStore(db, { indexName });
            await store.ensureSchema();
          },
          async assertSingleIndex() {
            const indexes = await currentDb().query<{ name: string }>(
              "SHOW FULLTEXT INDEXES YIELD name WHERE name = $indexName RETURN name;",
              { indexName }
            );
            expect(indexes).toEqual([{ name: indexName }]);
          }
        };
        initializationStarted = true;
        await db.initSchema(`neo4j-conformance-${suffix}`);
        await runWorkspaceLifecycleConformance(fixture);
      } catch (error) {
        testFailure = error;
      }

      const cleanupSteps = db ? [
        ...(initializationStarted ? [
          {
            name: "delete scoped lexical documents",
            run: () => currentDb().query(
              "MATCH (n:LexicalDocument) WHERE n.workspaceId IN [$workspaceId, $foreignWorkspaceId] DETACH DELETE n;",
              { workspaceId, foreignWorkspaceId: `${workspaceId}:foreign` }
            )
          },
          {
            name: "delete scoped lexical stats",
            run: () => currentDb().query(
              "MATCH (s:LexicalWorkspaceStats) WHERE s.workspaceId IN [$workspaceId, $foreignWorkspaceId] DETACH DELETE s;",
              { workspaceId, foreignWorkspaceId: `${workspaceId}:foreign` }
            )
          },
          {
            name: "delete scoped graph journal",
            run: () => currentDb().query(
              "MATCH (b:GraphWriteBatch) WHERE b.workspaceId = $workspaceId DETACH DELETE b;",
              { workspaceId }
            )
          },
          {
            name: "delete UUID-scoped graph facts",
            run: () => currentDb().query(
              "MATCH (n) WHERE (n.repoId IS NOT NULL AND n.repoId ENDS WITH $suffix) " +
              "OR (n:Repo AND n.id ENDS WITH $suffix) DETACH DELETE n;",
              { suffix }
            )
          }
        ] : []),
        ...(baselineCaptured && initializationStarted ? [{
          name: "restore System baseline",
          run: () => previousSystem === null
            ? currentDb().query("MATCH (s:System {id: 'system:default'}) DETACH DELETE s;")
            : currentDb().query(
              "MERGE (s:System {id: 'system:default'}) SET s.name = $name, s.summary = $summary;",
              previousSystem
            )
        }] : []),
        ...(initializationStarted ? [{
          name: "drop UUID-scoped full-text index",
          run: () => currentDb().query(`DROP INDEX ${indexName} IF EXISTS`)
        }] : []),
        { name: "close conformance database", run: () => currentDb().close() }
      ] : [];
      let cleanupFailure: unknown;
      try {
        await runNeo4jCleanupSteps(cleanupSteps);
      } catch (error) {
        cleanupFailure = error;
      }
      if (testFailure && cleanupFailure) {
        throw new AggregateError([testFailure, cleanupFailure], "Neo4j conformance and cleanup both failed.");
      }
      if (testFailure) throw testFailure;
      if (cleanupFailure) throw cleanupFailure;
    },
    120000
  );
});
