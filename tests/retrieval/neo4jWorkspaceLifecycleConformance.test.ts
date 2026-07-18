import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Neo4jGraphDB } from "../../src/adapters/graph-db/neo4j/Neo4jGraphDB.js";
import { Neo4jWorkspaceLexicalStore } from "../../src/adapters/graph-db/neo4j/Neo4jWorkspaceLexicalStore.js";
import { runWorkspaceLifecycleConformance, type WorkspaceLifecycleFixture } from "./workspaceLifecycleConformanceHarness.js";

const required = ["NEO4J_URI", "NEO4J_USERNAME", "NEO4J_PASSWORD", "NEO4J_TEST_DATABASE"] as const;
const missing = required.filter((key) => !process.env[key]?.trim());
const testDatabase = process.env.NEO4J_TEST_DATABASE?.trim();
const normalizedTestDatabase = testDatabase?.toLowerCase();
const unsafeDatabase = !testDatabase || normalizedTestDatabase === "neo4j" || normalizedTestDatabase === "system";

describe("Neo4j workspace lifecycle conformance", () => {
  it.skipIf(missing.length > 0 || unsafeDatabase)(
    `runs the shared isolated graph-facts lifecycle (missing: ${missing.join(", ") || "none"}; dedicated database: ${unsafeDatabase ? "required" : "configured"})`,
    async () => {
      const suffix = randomUUID().replace(/-/g, "");
      const workspaceId = `workspace:neo4j-conformance:${suffix}`;
      const indexName = `workspace_lexical_${suffix}`;
      const open = () => Neo4jGraphDB.open(process.env.NEO4J_URI!, {
        username: process.env.NEO4J_USERNAME!,
        password: process.env.NEO4J_PASSWORD!,
        database: testDatabase!
      });
      let db = await open();
      let store = new Neo4jWorkspaceLexicalStore(db, { indexName });
      const previousSystem = await db.query<{ name: string; summary: string }>(
        "MATCH (s:System {id: 'system:default'}) RETURN s.name AS name, s.summary AS summary;"
      );
      const fixture: WorkspaceLifecycleFixture = {
        get db() { return db; },
        get store() { return store; },
        workspaceId,
        suffix,
        async reopen() {
          await db.close();
          db = await open();
          store = new Neo4jWorkspaceLexicalStore(db, { indexName });
          await store.ensureSchema();
        },
        async assertSingleIndex() {
          const indexes = await db.query<{ name: string }>(
            "SHOW FULLTEXT INDEXES YIELD name WHERE name = $indexName RETURN name;",
            { indexName }
          );
          expect(indexes).toEqual([{ name: indexName }]);
        }
      };
      try {
        await db.initSchema(`neo4j-conformance-${suffix}`);
        await runWorkspaceLifecycleConformance(fixture);
      } finally {
        // The suffix scopes every graph id and workspace lexical document.
        await db.query("MATCH (n:LexicalDocument) WHERE n.workspaceId IN [$workspaceId, $foreignWorkspaceId] DETACH DELETE n;", { workspaceId, foreignWorkspaceId: `${workspaceId}:foreign` });
        await db.query("MATCH (s:LexicalWorkspaceStats) WHERE s.workspaceId IN [$workspaceId, $foreignWorkspaceId] DETACH DELETE s;", { workspaceId, foreignWorkspaceId: `${workspaceId}:foreign` });
        await db.query("MATCH (b:GraphWriteBatch) WHERE b.workspaceId = $workspaceId DETACH DELETE b;", { workspaceId });
        await db.query(
          "MATCH (n) WHERE (n.repoId IS NOT NULL AND n.repoId ENDS WITH $suffix) OR (n:Repo AND n.id ENDS WITH $suffix) DETACH DELETE n;",
          { suffix }
        );
        if (previousSystem[0]) {
          await db.query(
            "MERGE (s:System {id: 'system:default'}) SET s.name = $name, s.summary = $summary;",
            previousSystem[0]
          );
        } else {
          await db.query("MATCH (s:System {id: 'system:default'}) DETACH DELETE s;");
        }
        await db.query(`DROP INDEX ${indexName} IF EXISTS`);
        await db.close();
      }
    },
    120000
  );
});
