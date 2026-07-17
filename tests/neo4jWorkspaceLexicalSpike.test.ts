import crypto from "node:crypto";
import neo4j, { type Driver, type Session } from "neo4j-driver";
import { describe, expect, it } from "vitest";
import { mrrAtK, recallAtK, refusalAccuracy } from "../src/core/retrieval/evaluation.js";
import type { LexicalHit, LexicalSearchOptions } from "../src/core/retrieval/types.js";
import { runWorkspaceLexicalConformance, type LexicalProviderHarness } from "./retrieval/providerConformance.js";
import { WORKSPACE_CORPUS } from "./retrieval/workspaceCorpus.js";
import { queryTerms, workspaceSpikeDocuments } from "./retrieval/workspaceLexicalSpikeFixtures.js";

const WORKSPACE_ID = "workspace:spike";
const required = ["LOGICLENS_TEST_NEO4J_URL", "LOGICLENS_TEST_NEO4J_USERNAME", "LOGICLENS_TEST_NEO4J_PASSWORD"] as const;
const missing = required.filter((name) => !process.env[name]);

class Neo4jHarness implements LexicalProviderHarness {
  readonly provider = "neo4j-fulltext";
  private readonly suffix = crypto.randomBytes(10).toString("hex");
  private readonly label = `WorkspaceLexicalSpike${this.suffix}`;
  private readonly index = `workspace_lexical_${this.suffix}`;
  private readonly database = process.env.LOGICLENS_TEST_NEO4J_DATABASE;
  private readonly driver: Driver;
  private nativeCalls = 0;

  constructor() {
    this.driver = neo4j.driver(process.env.LOGICLENS_TEST_NEO4J_URL!, neo4j.auth.basic(process.env.LOGICLENS_TEST_NEO4J_USERNAME!, process.env.LOGICLENS_TEST_NEO4J_PASSWORD!));
  }

  private session(): Session { return this.driver.session(this.database ? { database: this.database } : undefined); }

  async prepare(): Promise<void> {
    await this.driver.verifyConnectivity();
    const session = this.session();
    try {
      await session.run(`CREATE FULLTEXT INDEX ${this.index} IF NOT EXISTS FOR (n:${this.label}) ON EACH [n.searchableText]`);
      await session.run("CALL db.awaitIndexes(300)");
    } finally { await session.close(); }
  }

  async write(): Promise<void> {
    const documents = await workspaceSpikeDocuments(WORKSPACE_ID);
    documents.push({ id: "document:foreign:payment-ledger", canonicalId: "foreign:payment-ledger", workspaceId: "workspace:foreign", repoId: "repo:foreign", kind: "file", title: "payment ledger", searchableText: "payment ledger foreignonlymarker", tokens: [], active: true, sourceHash: "foreign", batchId: "foreign", renderRef: "fixture:foreign:payment-ledger" });
    const session = this.session();
    try {
      await session.executeWrite((transaction) => transaction.run(`UNWIND $documents AS document CREATE (n:${this.label}) SET n = document`, { documents: documents.map((document) => ({ id: document.id, canonicalId: document.canonicalId, workspaceId: document.workspaceId, repoId: document.repoId, kind: document.kind, searchableText: document.searchableText, active: document.active, renderRef: document.renderRef })) }));
      await session.run("CALL db.awaitIndexes(300)");
    } finally { await session.close(); }
  }

  async search(query: { workspaceId: string; text: string }, options: LexicalSearchOptions): Promise<LexicalHit[]> {
    this.nativeCalls++;
    const session = this.session();
    try {
      const result = await session.run(`CALL db.index.fulltext.queryNodes($index, $text) YIELD node, score WHERE node.workspaceId = $workspaceId AND node.active = true RETURN node.canonicalId AS canonicalId, node.id AS documentId, node.repoId AS repoId, node.kind AS kind, node.renderRef AS renderRef, score ORDER BY score DESC, documentId ASC LIMIT $topK`, { index: this.index, text: queryTerms(query.text), workspaceId: query.workspaceId, topK: neo4j.int(options.topK) });
      return result.records.map((record, index) => ({ canonicalId: String(record.get("canonicalId")), documentId: String(record.get("documentId")), repoId: String(record.get("repoId")), kind: String(record.get("kind")) as LexicalHit["kind"], rank: index + 1, matchReasons: ["native-fulltext"], renderRef: String(record.get("renderRef")) }));
    } finally { await session.close(); }
  }

  nativeSearchCount(): number { return this.nativeCalls; }
  async isWorkspaceVisible(workspaceId: string): Promise<boolean> { const session = this.session(); try { const result = await session.run(`MATCH (n:${this.label}) WHERE n.workspaceId = $workspaceId AND n.active = true RETURN count(n) AS count`, { workspaceId }); return neo4j.integer.toNumber(result.records[0]!.get("count")) > 0; } finally { await session.close(); } }
  async isWorkspaceIsolated(workspaceId: string): Promise<boolean> { return (await this.search({ workspaceId, text: "foreignonlymarker" }, { topK: 5 })).length === 0; }
  async cleanup(): Promise<void> { const session = this.session(); try { await session.run(`MATCH (n:${this.label}) DETACH DELETE n`); await session.run(`DROP INDEX ${this.index} IF EXISTS`); } finally { await session.close(); } }
  async close(): Promise<void> { await this.driver.close(); }
}

describe("Neo4j workspace lexical conformance spike", () => {
  const integrationName = missing.length === 0
    ? "runs real full-text conformance with isolated cleanup"
    : `Neo4j integration skipped: missing ${missing.join(", ")}`;

  it.skipIf(missing.length > 0)(integrationName, async () => {
    const harness = new Neo4jHarness();
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
