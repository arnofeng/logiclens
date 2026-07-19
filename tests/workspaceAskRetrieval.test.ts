import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KuzuGraphDB } from "../src/adapters/graph-db/kuzu/KuzuGraphDB.js";
import { KuzuWorkspaceLexicalStore } from "../src/adapters/graph-db/kuzu/KuzuWorkspaceLexicalStore.js";
import type { WorkspaceLexicalStore } from "../src/core/retrieval/provider.js";
import { deriveWorkspaceId } from "../src/core/workspace/identity.js";
import { planQuestion } from "../src/features/ask/planner.js";
import { retrieveForQuestion } from "../src/features/ask/retrieve.js";
import { WORKSPACE_CORPUS } from "./retrieval/workspaceCorpus.js";
import { workspaceSpikeDocuments } from "./retrieval/workspaceLexicalSpikeFixtures.js";

describe("workspace Ask retrieval", () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((close) => close()));
  });

  it("uses one real global Kuzu lexical query per multilingual workspace question with stable results", async () => {
    const previousCloseMode = process.env.LOGICLENS_KUZU_CLOSE_MODE;
    process.env.LOGICLENS_KUZU_CLOSE_MODE = "explicit";
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-workspace-ask-"));
    const db = await KuzuGraphDB.open(path.join(directory, "ask.kuzu"));
    cleanup.push(async () => {
      await db.close();
      await fs.rm(directory, { recursive: true, force: true });
      if (previousCloseMode === undefined) delete process.env.LOGICLENS_KUZU_CLOSE_MODE;
      else process.env.LOGICLENS_KUZU_CLOSE_MODE = previousCloseMode;
    });

    const systemName = "workspace-ask-integration";
    const workspaceId = deriveWorkspaceId(systemName);
    await db.initSchema(systemName);
    const realStore = new KuzuWorkspaceLexicalStore(db);
    await realStore.ensureSchema();
    const documents = await workspaceSpikeDocuments(workspaceId);
    expect(new Set(documents.map(({ repoId }) => repoId)).size).toBeGreaterThanOrEqual(2);
    await realStore.upsertDocuments(documents);
    await realStore.commitVersions();

    const search = vi.fn(realStore.search.bind(realStore));
    const health = vi.fn(realStore.health.bind(realStore));
    const store = new Proxy(realStore, {
      get(target, property, receiver) {
        if (property === "search") return search;
        if (property === "health") return health;
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }
    }) as WorkspaceLexicalStore;

    const answerableRepos = new Set<string>();
    let sawCrossRepoRanking = false;
    for (const corpusCase of WORKSPACE_CORPUS) {
      const plan = planQuestion(corpusCase.question);
      const direct = plan.normalizedLexicalQuery
        ? await realStore.search({ workspaceId, text: plan.normalizedLexicalQuery }, { topK: plan.budgets.lexical.limit })
        : [];
      const before = search.mock.calls.length;
      const healthBefore = health.mock.calls.length;
      const first = await retrieveForQuestion(db, corpusCase.question, {
        lexicalStore: store,
        config: { systemName, embedding: { provider: "off", level: "off" } } as never
      });
      expect(search.mock.calls.length - before, corpusCase.id).toBe(plan.enabledRoutes.includes("lexical") && plan.normalizedLexicalQuery ? 1 : 0);
      expect(health.mock.calls.length - healthBefore, corpusCase.id).toBe(plan.enabledRoutes.includes("lexical") && plan.normalizedLexicalQuery ? 1 : 0);

      const lexicalOrder = first.fusedCandidates
        .filter((candidate) => candidate.routes.some(({ route }) => route === "lexical"))
        .sort((left, right) => (left.routes.find(({ route }) => route === "lexical")?.rank ?? 0) - (right.routes.find(({ route }) => route === "lexical")?.rank ?? 0))
        .map(({ canonicalId }) => canonicalId);
      const directCanonicalOrder = [...new Set(direct.map(({ canonicalId }) => canonicalId))];
      expect(lexicalOrder, corpusCase.id).toEqual(directCanonicalOrder);
      expect(first.fusedCandidates.every(({ repoId }) => repoId.startsWith("repo:")), corpusCase.id).toBe(true);
      const directRepos = new Set(direct.map(({ repoId }) => repoId));
      if (directRepos.size > 1) sawCrossRepoRanking = true;

      if (corpusCase.answerable) {
        expect(lexicalOrder.length, `${corpusCase.id}: lexical evidence`).toBeGreaterThan(0);
        for (const expectedCanonicalId of corpusCase.expectedCanonicalIds) {
          expect(lexicalOrder, corpusCase.id).toContain(expectedCanonicalId);
          const expected = first.fusedCandidates.find(({ canonicalId }) => canonicalId === expectedCanonicalId);
          expect(expected, `${corpusCase.id}: ${expectedCanonicalId}`).toBeDefined();
          answerableRepos.add(expected!.repoId);
          expect(expected!.repoId).toMatch(/^repo:/u);
          if (corpusCase.category === "path") {
            expect(expected!.location?.path).toBe("src/contracts/orders.ts");
          } else if (expectedCanonicalId.startsWith("code:") || expectedCanonicalId.startsWith("section:") || expectedCanonicalId.startsWith("file:")) {
            expect(expected!.location?.path, `${corpusCase.id}: location`).toBeTruthy();
          }
        }
      } else {
        expect(corpusCase.expectedCanonicalIds).toEqual([]);
        expect(lexicalOrder, `${corpusCase.id}: refusal`).toEqual([]);
        expect(first.selectedCandidates, `${corpusCase.id}: refusal selection`).toEqual([]);
        expect(first.outcome).toBe("no_results");
      }

      const repeatBefore = search.mock.calls.length;
      const second = await retrieveForQuestion(db, corpusCase.question, {
        lexicalStore: store,
        config: { systemName, embedding: { provider: "off", level: "off" } } as never
      });
      expect(search.mock.calls.length - repeatBefore, corpusCase.id).toBe(plan.enabledRoutes.includes("lexical") && plan.normalizedLexicalQuery ? 1 : 0);
      expect(second.fusedCandidates).toEqual(first.fusedCandidates);
      expect(second.selectedCandidates).toEqual(first.selectedCandidates);
      expect(second.outcome).toBe(first.outcome);
    }
    expect(answerableRepos.size).toBeGreaterThanOrEqual(2);
    expect(sawCrossRepoRanking).toBe(true);
  }, 15_000);
});
