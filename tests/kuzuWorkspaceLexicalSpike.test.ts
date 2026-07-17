import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import kuzu, { type Connection } from "kuzu";
import { afterEach, describe, expect, it } from "vitest";
import { mrrAtK, recallAtK, refusalAccuracy } from "../src/core/retrieval/evaluation.js";
import type { LexicalHit, LexicalSearchOptions } from "../src/core/retrieval/types.js";
import { runWorkspaceLexicalConformance, type LexicalProviderHarness } from "./retrieval/providerConformance.js";
import { WORKSPACE_CORPUS } from "./retrieval/workspaceCorpus.js";
import { queryTerms, workspaceSpikeDocuments } from "./retrieval/workspaceLexicalSpikeFixtures.js";

const WORKSPACE_ID = "workspace:spike";

async function rows(result: kuzu.QueryResult | kuzu.QueryResult[]): Promise<Array<Record<string, unknown>>> {
  return (await Promise.all((Array.isArray(result) ? result : [result]).map((entry) => entry.getAll()))).flat() as Array<Record<string, unknown>>;
}

class KuzuHarness implements LexicalProviderHarness {
  readonly provider = "kuzu-0.11.3";
  private directory = "";
  private db?: kuzu.Database;
  private nativeCalls = 0;

  private async connection(): Promise<Connection> {
    if (!this.db) throw new Error("Kuzu database is closed");
    const connection = new kuzu.Connection(this.db);
    await connection.init();
    return connection;
  }

  async prepare(): Promise<void> {
    this.directory = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-kuzu-fts-"));
    this.db = new kuzu.Database(path.join(this.directory, "spike.kuzu"), 0, true, false, 137438953472);
    await this.db.init();
    const conn = await this.connection();
    try {
      await conn.query("LOAD EXTENSION FTS;");
      await conn.query("CREATE NODE TABLE LexicalDocument(id STRING, canonicalId STRING, workspaceId STRING, repoId STRING, kind STRING, searchableText STRING, active BOOL, renderRef STRING, PRIMARY KEY(id));");
      await conn.query("CALL CREATE_FTS_INDEX('LexicalDocument', 'workspace_lexical', ['searchableText']);");
    } finally { await conn.close(); }
  }

  async write(): Promise<void> {
    const documents = await workspaceSpikeDocuments(WORKSPACE_ID);
    documents.push({ id: "document:foreign:payment-ledger", canonicalId: "foreign:payment-ledger", workspaceId: "workspace:foreign", repoId: "repo:foreign", kind: "file", title: "payment ledger", searchableText: "payment ledger foreignonlymarker", tokens: [], active: true, sourceHash: "foreign", batchId: "foreign", renderRef: "fixture:foreign:payment-ledger" });
    const conn = await this.connection();
    try {
      for (const document of documents) {
        const statement = await conn.prepare("CREATE (:LexicalDocument {id: $id, canonicalId: $canonicalId, workspaceId: $workspaceId, repoId: $repoId, kind: $kind, searchableText: $searchableText, active: $active, renderRef: $renderRef});");
        if (!statement.isSuccess()) throw new Error(statement.getErrorMessage());
        await conn.execute(statement, { id: document.id, canonicalId: document.canonicalId, workspaceId: document.workspaceId, repoId: document.repoId, kind: document.kind, searchableText: document.searchableText, active: document.active, renderRef: document.renderRef });
      }
    } finally { await conn.close(); }
  }

  async search(query: { workspaceId: string; text: string }, options: LexicalSearchOptions): Promise<LexicalHit[]> {
    this.nativeCalls++;
    const conn = await this.connection();
    try {
      const statement = await conn.prepare("CALL QUERY_FTS_INDEX('LexicalDocument', 'workspace_lexical', $text) WHERE node.workspaceId = $workspaceId AND node.active = true RETURN node.canonicalId AS canonicalId, node.id AS documentId, node.repoId AS repoId, node.kind AS kind, node.renderRef AS renderRef, score ORDER BY score DESC, documentId ASC LIMIT $topK;");
      if (!statement.isSuccess()) throw new Error(statement.getErrorMessage());
      const resultRows = await rows(await conn.execute(statement, { text: queryTerms(query.text), workspaceId: query.workspaceId, topK: options.topK }));
      return resultRows.map((row, index) => ({ canonicalId: String(row.canonicalId), documentId: String(row.documentId), repoId: String(row.repoId), kind: String(row.kind) as LexicalHit["kind"], rank: index + 1, matchReasons: ["native-fts"], renderRef: String(row.renderRef) }));
    } finally { await conn.close(); }
  }

  nativeSearchCount(): number { return this.nativeCalls; }
  async isWorkspaceVisible(workspaceId: string): Promise<boolean> { if (!this.db) return false; const conn = await this.connection(); try { const statement = await conn.prepare("MATCH (n:LexicalDocument) WHERE n.workspaceId = $workspaceId AND n.active = true RETURN count(*) AS count;"); if (!statement.isSuccess()) throw new Error(statement.getErrorMessage()); const resultRows = await rows(await conn.execute(statement, { workspaceId })); return Number((resultRows[0] as { count: number }).count) > 0; } finally { await conn.close(); } }
  async isWorkspaceIsolated(workspaceId: string): Promise<boolean> { const hits = await this.search({ workspaceId, text: "foreignonlymarker" }, { topK: 5 }); return hits.length === 0; }
  async cleanup(): Promise<void> { const db = this.db; this.db = undefined; if (db) await db.close(); if (this.directory) await fs.rm(this.directory, { recursive: true, force: true }); }
}

describe("Kuzu workspace lexical conformance spike", () => {
  const harnesses: KuzuHarness[] = [];
  afterEach(async () => { await Promise.all(harnesses.splice(0).map((harness) => harness.cleanup())); });
  it("uses one native FTS query per corpus case and keeps workspace results isolated", async () => {
    const harness = new KuzuHarness(); harnesses.push(harness);
    const report = await runWorkspaceLexicalConformance(harness, WORKSPACE_CORPUS, WORKSPACE_ID);
    expect(report.lifecycle).toEqual({ visibleBeforeWrite: false, visibleAfterWrite: true, visibleAfterCleanup: false });
    expect(report.cases.every((entry) => entry.nativeSearchCalls === 1)).toBe(true);
    const answerable = report.cases.filter((entry) => WORKSPACE_CORPUS.find((case_) => case_.id === entry.caseId)?.answerable);
    expect(answerable.every((entry) => recallAtK(WORKSPACE_CORPUS.find((case_) => case_.id === entry.caseId)!.expectedCanonicalIds, entry.hits.map((hit) => hit.canonicalId), 5) > 0)).toBe(true);
    expect(answerable.every((entry) => mrrAtK(WORKSPACE_CORPUS.find((case_) => case_.id === entry.caseId)!.expectedCanonicalIds, entry.hits.map((hit) => hit.canonicalId), 3) > 0)).toBe(true);
    expect(report.cases.every((entry) => refusalAccuracy(WORKSPACE_CORPUS.find((case_) => case_.id === entry.caseId)!.answerable, entry.hits.map((hit) => hit.canonicalId)) === 1)).toBe(true);
  });
});
