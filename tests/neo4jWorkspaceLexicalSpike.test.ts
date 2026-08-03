import crypto from "node:crypto";
import neo4j, { type Driver, type Session } from "neo4j-driver";
import { describe, expect, it } from "vitest";
import type { GraphValue } from "../src/core/graph-model/db.js";
import { mrrAtK, recallAtK, refusalAccuracy } from "../src/core/retrieval/evaluation.js";
import type { LexicalHit, LexicalSearchOptions } from "../src/core/retrieval/types.js";
import { Neo4jWorkspaceLexicalStore } from "../src/adapters/graph-db/neo4j/Neo4jWorkspaceLexicalStore.js";
import {
  recordToPlain,
  toNeo4jParams,
  type Neo4jGraphDB
} from "../src/adapters/graph-db/neo4j/Neo4jGraphDB.js";
import { runWorkspaceLexicalConformance, type LexicalProviderHarness } from "./retrieval/providerConformance.js";
import { WORKSPACE_CORPUS } from "./retrieval/workspaceCorpus.js";
import { workspaceSpikeDocuments } from "./retrieval/workspaceLexicalSpikeFixtures.js";
import { resolveNeo4jTestEnvironment, type Neo4jTestConfiguration } from "./helpers/neo4jTestEnvironment.js";

const WORKSPACE_ID = "workspace:spike";
const GENERATION = "schema-generation:workspace-spike:neo4j-fixture";
const integration = resolveNeo4jTestEnvironment();

class Neo4jHarness implements LexicalProviderHarness {
  readonly provider = "neo4j-fulltext";
  private readonly suffix = crypto.randomBytes(10).toString("hex");
  private readonly label = `WorkspaceLexicalSpike${this.suffix}`;
  private readonly index = `workspace_lexical_${this.suffix}`;
  private readonly database: string;
  private readonly driver: Driver;
  private readonly productionStore: Neo4jWorkspaceLexicalStore;
  private nativeCalls = 0;

  constructor(configuration: Neo4jTestConfiguration) {
    this.database = configuration.database;
    this.driver = neo4j.driver(configuration.url, neo4j.auth.basic(configuration.username, configuration.password));
    const queryAdapter = {
      query: async <T>(cypher: string, params?: Record<string, GraphValue>): Promise<T[]> => {
        const session = this.session();
        try {
          const result = await session.run(cypher, toNeo4jParams(params));
          return result.records.map((record) => recordToPlain(record) as T);
        } finally {
          await session.close();
        }
      }
    } as unknown as Neo4jGraphDB;
    this.productionStore = new Neo4jWorkspaceLexicalStore(queryAdapter, { indexName: this.index });
  }

  private session(): Session { return this.driver.session({ database: this.database }); }

  async prepare(): Promise<void> {
    await this.driver.verifyConnectivity();
    const session = this.session();
    try {
      await session.run(`CREATE FULLTEXT INDEX ${this.index} IF NOT EXISTS FOR (n:${this.label}) ON EACH [n.ftsText] OPTIONS { indexConfig: { \`fulltext.analyzer\`: 'standard-no-stop-words', \`fulltext.eventually_consistent\`: false } }`);
      await session.run("CALL db.awaitIndexes(300)");
    } finally { await session.close(); }
  }

  async write(): Promise<void> {
    const documents = await workspaceSpikeDocuments(WORKSPACE_ID);
    documents.push({ id: "document:foreign:payment-ledger", canonicalId: "foreign:payment-ledger", workspaceId: "workspace:foreign", repoId: "repo:foreign", kind: "file", title: "payment ledger", searchableText: "payment ledger foreignonlymarker", tokens: [], active: true, sourceHash: "foreign", batchId: "foreign", renderRef: "fixture:foreign:payment-ledger" });
    const session = this.session();
    try {
      await session.executeWrite((transaction) => transaction.run(
        `UNWIND $documents AS document CREATE (n:${this.label}) SET n = document`,
        {
          documents: documents.map((document) => ({
            storageId: `lexical-storage:${JSON.stringify([document.workspaceId, GENERATION, document.id])}`,
            documentId: document.id,
            generation: GENERATION,
            canonicalId: document.canonicalId,
            workspaceId: document.workspaceId,
            repoId: document.repoId,
            kind: document.kind,
            ftsText: [document.searchableText, ...document.tokens].filter(Boolean).join(" "),
            active: document.active,
            renderRef: document.renderRef
          }))
        }
      ));
      await session.run("CALL db.awaitIndexes(300)");
    } finally { await session.close(); }
  }

  async search(query: { workspaceId: string; text: string }, options: LexicalSearchOptions): Promise<LexicalHit[]> {
    this.nativeCalls++;
    return [...await this.productionStore.search({ ...query, generation: GENERATION }, options)];
  }

  nativeSearchCount(): number { return this.nativeCalls; }
  async isWorkspaceVisible(workspaceId: string): Promise<boolean> { const session = this.session(); try { const result = await session.run(`MATCH (n:${this.label}) WHERE n.workspaceId = $workspaceId AND n.generation = $generation AND n.active = true RETURN count(n) AS count`, { workspaceId, generation: GENERATION }); return neo4j.integer.toNumber(result.records[0]!.get("count")) > 0; } finally { await session.close(); } }
  async isWorkspaceIsolated(workspaceId: string): Promise<boolean> { return (await this.search({ workspaceId, text: "foreignonlymarker" }, { topK: 5 })).length === 0; }
  async cleanup(): Promise<void> { const session = this.session(); try { await session.run(`MATCH (n:${this.label}) DETACH DELETE n`); await session.run(`DROP INDEX ${this.index} IF EXISTS`); } finally { await session.close(); } }
  async close(): Promise<void> { await this.driver.close(); }
}

describe("Neo4j workspace lexical conformance spike", () => {
  it.skipIf(!integration.enabled)(integration.testName, async () => {
    const harness = new Neo4jHarness(integration.requireConfiguration());
    try {
      const report = await runWorkspaceLexicalConformance(harness, WORKSPACE_CORPUS, WORKSPACE_ID);
      await harness.cleanup();
      expect(report.lifecycle).toEqual({ visibleBeforeWrite: false, visibleAfterWrite: true, visibleAfterCleanup: false });
      expect(report.cases.every((entry) => entry.nativeSearchCalls === 1)).toBe(true);
      const answerable = report.cases.filter((entry) => WORKSPACE_CORPUS.find((case_) => case_.id === entry.caseId)?.answerable);
      expect(answerable.every((entry) => recallAtK(WORKSPACE_CORPUS.find((case_) => case_.id === entry.caseId)!.expectedCanonicalIds, entry.hits.map((hit) => hit.canonicalId), 5) > 0)).toBe(true);
      expect(answerable.every((entry) => mrrAtK(WORKSPACE_CORPUS.find((case_) => case_.id === entry.caseId)!.expectedCanonicalIds, entry.hits.map((hit) => hit.canonicalId), 3) > 0)).toBe(true);
      expect(report.cases.every((entry) => refusalAccuracy(WORKSPACE_CORPUS.find((case_) => case_.id === entry.caseId)!.answerable, entry.hits.map((hit) => hit.canonicalId)) === 1)).toBe(true);
    } finally { await harness.close(); }
  });
});
