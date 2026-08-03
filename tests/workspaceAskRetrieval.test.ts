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
import { answerQuestion, NO_RELIABLE_EVIDENCE } from "../src/features/ask/answer.js";
import { WORKSPACE_CORPUS } from "./retrieval/workspaceCorpus.js";
import { workspaceSpikeDocuments } from "./retrieval/workspaceLexicalSpikeFixtures.js";
import { SchemaGenerationStore } from "../src/core/schema/generationStore.js";

describe("workspace Ask retrieval", () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((close) => close()));
  });

  it("uses one real global Kuzu lexical query per multilingual workspace question with stable results", async () => {
    const previousCloseMode = process.env.REPOHELIX_KUZU_CLOSE_MODE;
    process.env.REPOHELIX_KUZU_CLOSE_MODE = "explicit";
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "repohelix-workspace-ask-"));
    const db = await KuzuGraphDB.open(path.join(directory, "ask.kuzu"));
    cleanup.push(async () => {
      await db.close();
      await fs.rm(directory, { recursive: true, force: true });
      if (previousCloseMode === undefined) delete process.env.REPOHELIX_KUZU_CLOSE_MODE;
      else process.env.REPOHELIX_KUZU_CLOSE_MODE = previousCloseMode;
    });

    const systemName = "workspace-ask-integration";
    const workspaceId = deriveWorkspaceId(systemName);
    await db.initSchema(systemName);
    const realStore = new KuzuWorkspaceLexicalStore(db);
    await realStore.ensureSchema();
    const documents = await workspaceSpikeDocuments(workspaceId);
    expect(new Set(documents.map(({ repoId }) => repoId)).size).toBeGreaterThanOrEqual(2);
    const generation = "schema-generation:workspace-ask-integration:initial";
    const schemaGenerations = new SchemaGenerationStore(db, workspaceId);
    await schemaGenerations.beginFull({
      generation,
      createdAt: "2026-01-01T00:00:00.000Z",
      expectedActiveGeneration: null,
      expectedActiveRevision: null
    });
    await realStore.initializeGeneration({ workspaceId, generation });
    await realStore.upsertDocuments({ workspaceId, generation, documents });
    await realStore.commitVersions();
    await schemaGenerations.validateFull(generation);
    await schemaGenerations.commitFull(generation);

    const search = vi.fn(realStore.search.bind(realStore));
    const health = vi.fn(realStore.health.bind(realStore));
    const loadDocuments = vi.fn(realStore.loadDocuments.bind(realStore));
    const store = new Proxy(realStore, {
      get(target, property, receiver) {
        if (property === "search") return search;
        if (property === "health") return health;
        if (property === "loadDocuments") return loadDocuments;
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }
    }) as WorkspaceLexicalStore;

    const answerableRepos = new Set<string>();
    let sawCrossRepoRanking = false;
    for (const corpusCase of WORKSPACE_CORPUS) {
      const plan = planQuestion(corpusCase.question);
      const requiresExactContract = plan.contractTargets.length > 0 &&
        plan.contractTargets.every(({ kind }) => kind === "api");
      const direct = plan.enabledRoutes.includes("lexical") && plan.normalizedLexicalQuery
        ? await realStore.search({ workspaceId, generation, text: plan.normalizedLexicalQuery }, { topK: plan.budgets.lexical.limit })
        : [];
      const before = search.mock.calls.length;
      const healthBefore = health.mock.calls.length;
      const loadBefore = loadDocuments.mock.calls.length;
      const first = await retrieveForQuestion(db, corpusCase.question, {
        lexicalStore: store,
        config: { systemName, embedding: { provider: "off", level: "off" } } as never
      });
      expect(search.mock.calls.length - before, corpusCase.id).toBe(plan.enabledRoutes.includes("lexical") && plan.normalizedLexicalQuery ? 1 : 0);
      expect(health.mock.calls.length - healthBefore, corpusCase.id).toBe(plan.enabledRoutes.includes("lexical") && plan.normalizedLexicalQuery ? 1 : 0);
      expect(loadDocuments.mock.calls.length - loadBefore, corpusCase.id).toBe(first.selectedCandidates.length > 0 ? 1 : 0);
      expect(first.diagnostics.queries.sourceLoading, corpusCase.id).toBe(first.selectedCandidates.length > 0 ? 1 : 0);
      expect(first.loadedEvidence.length, corpusCase.id).toBe(first.selectedCandidates.length);

      const lexicalOrder = first.fusedCandidates
        .filter((candidate) => candidate.routes.some(({ route }) => route === "lexical"))
        .sort((left, right) => (left.routes.find(({ route }) => route === "lexical")?.rank ?? 0) - (right.routes.find(({ route }) => route === "lexical")?.rank ?? 0))
        .map(({ canonicalId }) => canonicalId);
      const directCanonicalOrder = [...new Set(direct.map(({ canonicalId }) => canonicalId))];
      expect(lexicalOrder, corpusCase.id).toEqual(directCanonicalOrder);
      const fusedOrder = first.fusedCandidates.map(({ canonicalId }) => canonicalId);
      expect(first.fusedCandidates.every(({ repoId }) => repoId.startsWith("repo:")), corpusCase.id).toBe(true);
      const directRepos = new Set(direct.map(({ repoId }) => repoId));
      if (directRepos.size > 1) sawCrossRepoRanking = true;

      if (corpusCase.answerable && !requiresExactContract) {
        if (plan.enabledRoutes.includes("lexical")) {
          expect(lexicalOrder.length, `${corpusCase.id}: lexical evidence`).toBeGreaterThan(0);
        }
        expect(first.selectedCandidates.length, `${corpusCase.id}: selected evidence`).toBeGreaterThan(0);
        expect(first.loadedEvidence.length, `${corpusCase.id}: loaded evidence`).toBeGreaterThan(0);
        expect(["succeeded", "degraded"], `${corpusCase.id}: outcome`).toContain(first.outcome);
        const localAnswer = await answerQuestion(corpusCase.question, first, "offline-test-model");
        expect(localAnswer, `${corpusCase.id}: local answer`).not.toBe(NO_RELIABLE_EVIDENCE);
        const citedEvidence = first.loadedEvidence.find(({ document }) => document.path);
        expect(citedEvidence, `${corpusCase.id}: cited path`).toBeDefined();
        expect(localAnswer, `${corpusCase.id}: citation id`).toContain("[C1]");
        expect(localAnswer, `${corpusCase.id}: repo/path citation`).toContain(`${citedEvidence!.document.repoId}/${citedEvidence!.document.path}`);
        for (const expectedCanonicalId of corpusCase.expectedCanonicalIds) {
          expect(fusedOrder, corpusCase.id).toContain(expectedCanonicalId);
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
      } else if (requiresExactContract) {
        expect(lexicalOrder, `${corpusCase.id}: strict contract lexical exclusion`).toEqual([]);
        expect(first.selectedCandidates, `${corpusCase.id}: unresolved strict contract`).toEqual([]);
        expect(first.loadedEvidence, `${corpusCase.id}: unresolved strict contract evidence`).toEqual([]);
        expect(first.outcome).toBe("no_results");
        await expect(answerQuestion(corpusCase.question, first, "offline-test-model"))
          .resolves.toBe(NO_RELIABLE_EVIDENCE);
      } else {
        expect(corpusCase.expectedCanonicalIds).toEqual([]);
        expect(lexicalOrder, `${corpusCase.id}: refusal`).toEqual([]);
        expect(first.selectedCandidates, `${corpusCase.id}: refusal selection`).toEqual([]);
        expect(first.outcome).toBe("no_results");
      }

      const repeatBefore = search.mock.calls.length;
      const repeatLoadBefore = loadDocuments.mock.calls.length;
      const second = await retrieveForQuestion(db, corpusCase.question, {
        lexicalStore: store,
        config: { systemName, embedding: { provider: "off", level: "off" } } as never
      });
      expect(search.mock.calls.length - repeatBefore, corpusCase.id).toBe(plan.enabledRoutes.includes("lexical") && plan.normalizedLexicalQuery ? 1 : 0);
      expect(loadDocuments.mock.calls.length - repeatLoadBefore, corpusCase.id).toBe(second.selectedCandidates.length > 0 ? 1 : 0);
      expect(second.fusedCandidates).toEqual(first.fusedCandidates);
      expect(second.selectedCandidates).toEqual(first.selectedCandidates);
      expect(second.loadedEvidence).toEqual(first.loadedEvidence);
      expect(second.outcome).toBe(first.outcome);
    }
    expect(answerableRepos.size).toBeGreaterThanOrEqual(2);
    expect(sawCrossRepoRanking).toBe(true);
  }, 15_000);
});
