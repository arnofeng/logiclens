import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KuzuGraphDB } from "../src/adapters/graph-db/kuzu/KuzuGraphDB.js";
import { KuzuWorkspaceLexicalStore } from "../src/adapters/graph-db/kuzu/KuzuWorkspaceLexicalStore.js";
import { mrrAtK, recallAtK, refusalAccuracy } from "../src/core/retrieval/evaluation.js";
import type { LexicalHit, LexicalSearchOptions } from "../src/core/retrieval/types.js";
import { runWorkspaceLexicalConformance, type LexicalProviderHarness } from "./retrieval/providerConformance.js";
import { WORKSPACE_CORPUS } from "./retrieval/workspaceCorpus.js";
import { workspaceSpikeDocuments } from "./retrieval/workspaceLexicalSpikeFixtures.js";

const WORKSPACE_ID = "workspace:spike";

class KuzuHarness implements LexicalProviderHarness {
  readonly provider = "kuzu-0.11.3";
  private directory = "";
  private db?: KuzuGraphDB;
  private store?: KuzuWorkspaceLexicalStore;
  private nativeCalls = 0;
  private previousCloseMode?: string;

  async prepare(): Promise<void> {
    this.previousCloseMode = process.env.LOGICLENS_KUZU_CLOSE_MODE;
    process.env.LOGICLENS_KUZU_CLOSE_MODE = "explicit";
    this.directory = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-kuzu-fts-"));
    this.db = await KuzuGraphDB.open(path.join(this.directory, "spike.kuzu"));
    this.store = new KuzuWorkspaceLexicalStore(this.db);
    await this.store.ensureSchema();
  }

  async write(): Promise<void> {
    if (!this.store) throw new Error("Kuzu lexical store is closed");
    await this.store.upsertDocuments(await workspaceSpikeDocuments(WORKSPACE_ID));
    await this.store.upsertDocuments([{
      id: "document:foreign:payment-ledger",
      canonicalId: "foreign:payment-ledger",
      workspaceId: "workspace:foreign",
      repoId: "repo:foreign",
      kind: "file",
      title: "payment ledger",
      searchableText: "payment ledger foreignonlymarker",
      tokens: ["payment", "ledger", "foreignonlymarker"],
      active: true,
      sourceHash: "foreign",
      batchId: "foreign",
      renderRef: "fixture:foreign:payment-ledger"
    }]);
  }

  async search(query: { workspaceId: string; text: string }, options: LexicalSearchOptions): Promise<LexicalHit[]> {
    if (!this.store) throw new Error("Kuzu lexical store is closed");
    this.nativeCalls++;
    return [...await this.store.search(query, options)];
  }

  nativeSearchCount(): number {
    return this.nativeCalls;
  }

  async isWorkspaceVisible(workspaceId: string): Promise<boolean> {
    if (!this.db) return false;
    const rows = await this.db.query<{ count: number }>(
      "MATCH (n:LexicalDocument) WHERE n.workspaceId = $workspaceId AND n.active = true RETURN count(*) AS count;",
      { workspaceId }
    );
    return Number(rows[0]?.count ?? 0) > 0;
  }

  async isWorkspaceIsolated(workspaceId: string): Promise<boolean> {
    const hits = await this.search({ workspaceId, text: "foreignonlymarker" }, { topK: 5 });
    return hits.length === 0;
  }

  async cleanup(): Promise<void> {
    const db = this.db;
    this.db = undefined;
    this.store = undefined;
    if (db) await db.close();
    if (this.directory) await fs.rm(this.directory, { recursive: true, force: true });
    if (this.previousCloseMode === undefined) delete process.env.LOGICLENS_KUZU_CLOSE_MODE;
    else process.env.LOGICLENS_KUZU_CLOSE_MODE = this.previousCloseMode;
  }
}

describe("Kuzu workspace lexical conformance spike", () => {
  const harnesses: KuzuHarness[] = [];
  afterEach(async () => {
    await Promise.all(harnesses.splice(0).map((harness) => harness.cleanup()));
  });

  it("uses the production store for one native FTS query per corpus case and workspace isolation", async () => {
    const harness = new KuzuHarness();
    harnesses.push(harness);
    const report = await runWorkspaceLexicalConformance(harness, WORKSPACE_CORPUS, WORKSPACE_ID);
    expect(report.lifecycle).toEqual({ visibleBeforeWrite: false, visibleAfterWrite: true, visibleAfterCleanup: false });
    expect(report.cases.every((entry) => entry.nativeSearchCalls === 1)).toBe(true);
    const answerable = report.cases.filter((entry) => WORKSPACE_CORPUS.find((case_) => case_.id === entry.caseId)?.answerable);
    expect(answerable.every((entry) => recallAtK(WORKSPACE_CORPUS.find((case_) => case_.id === entry.caseId)!.expectedCanonicalIds, entry.hits.map((hit) => hit.canonicalId), 5) > 0)).toBe(true);
    expect(answerable.every((entry) => mrrAtK(WORKSPACE_CORPUS.find((case_) => case_.id === entry.caseId)!.expectedCanonicalIds, entry.hits.map((hit) => hit.canonicalId), 3) > 0)).toBe(true);
    expect(report.cases.every((entry) => refusalAccuracy(WORKSPACE_CORPUS.find((case_) => case_.id === entry.caseId)!.answerable, entry.hits.map((hit) => hit.canonicalId)) === 1)).toBe(true);
  });
});
