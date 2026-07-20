import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { KuzuWorkspaceLexicalStore } from "../src/adapters/graph-db/kuzu/KuzuWorkspaceLexicalStore.js";
import { runRetrievalEvaluation, type RetrievalEvaluationReport } from "../src/core/retrieval/evaluation.js";
import type { RetrievalResult } from "../src/features/ask/retrieve.js";
import { QUALITY_GATE_CORPUS } from "./retrieval/workspaceCorpus.js";
import {
  createWorkspaceEvaluationFixture,
  EVALUATION_RETRIEVE_OPTIONS,
  projectEvaluationResult,
  type WorkspaceEvaluationFixture,
} from "./retrieval/workspaceEvaluationFixture.js";

function comparisonFailure(baseline: RetrievalEvaluationReport, lexical: RetrievalEvaluationReport): string {
  return baseline.queries.map((before) => {
    const after = lexical.queries.find(({ queryId }) => queryId === before.queryId)!;
    return `${before.queryId}: baseline=${JSON.stringify(before.expectedRanks)}, lexical=${JSON.stringify(after.expectedRanks)}, ` +
      `expected=${JSON.stringify(before.expectedCanonicalIds)}, outcomes=${before.outcome}/${after.outcome}, ` +
      `diagnostics=${JSON.stringify({ baseline: before.diagnostics, lexical: after.diagnostics })}`;
  }).join("\n");
}

describe("workspace retrieval lexical baseline comparison", () => {
  let fixture: WorkspaceEvaluationFixture;
  beforeAll(async () => { fixture = await createWorkspaceEvaluationFixture(); }, 30_000);
  afterAll(async () => { await fixture?.close(); });

  it("compares lexical off and on with every other evaluation input held constant", async () => {
    const search = vi.spyOn(KuzuWorkspaceLexicalStore.prototype, "search");
    const health = vi.spyOn(KuzuWorkspaceLexicalStore.prototype, "health");
    search.mockClear();
    health.mockClear();
    const baselineRaw = new Map<string, RetrievalResult>();
    const lexicalRaw = new Map<string, RetrievalResult>();
    const baselineOptions = Object.freeze({ ...EVALUATION_RETRIEVE_OPTIONS, lexical: false });
    const lexicalOptions = Object.freeze({ ...EVALUATION_RETRIEVE_OPTIONS, lexical: true });
    const comparableKeys = ["semantic", "topK", "graphHops", "contextBudget"] as const;
    expect(comparableKeys.map((key) => baselineOptions[key])).toEqual(comparableKeys.map((key) => lexicalOptions[key]));

    const baseline = await runRetrievalEvaluation(QUALITY_GATE_CORPUS, async (corpusCase) => {
      const result = await fixture.client.retrieve(corpusCase.question, baselineOptions);
      baselineRaw.set(corpusCase.id, result);
      return projectEvaluationResult(result);
    });
    expect(search).not.toHaveBeenCalled();
    expect(health).toHaveBeenCalledTimes(1);

    const lexical = await runRetrievalEvaluation(QUALITY_GATE_CORPUS, async (corpusCase) => {
      const result = await fixture.client.retrieve(corpusCase.question, lexicalOptions);
      lexicalRaw.set(corpusCase.id, result);
      return projectEvaluationResult(result);
    });
    const detail = comparisonFailure(baseline, lexical);
    expect(baseline.queries.map(({ queryId }) => queryId), detail).toEqual(lexical.queries.map(({ queryId }) => queryId));

    for (const corpusCase of QUALITY_GATE_CORPUS) {
      const before = baselineRaw.get(corpusCase.id)!;
      const after = lexicalRaw.get(corpusCase.id)!;
      expect(before.diagnostics.routes.lexical.queryCount, `${corpusCase.id}\n${detail}`).toBe(0);
      expect(before.diagnostics.providers.lexical.status, `${corpusCase.id}\n${detail}`).toBe("disabled");
      expect(after.diagnostics.routes.lexical.queryCount, `${corpusCase.id}\n${detail}`).toBeLessThanOrEqual(1);
      expect(before.sourceLoadRejections.some(({ reason }) => reason === "provider_unavailable"), `${corpusCase.id}\n${detail}`).toBe(false);
      if (before.selectedCandidates.length > 0) {
        expect(before.selectedCandidates.every((candidate) => candidate.routes.every(({ route }) => route !== "lexical")), `${corpusCase.id}\n${detail}`).toBe(true);
        expect(before.loadedEvidence.length, `${corpusCase.id}\n${detail}`).toBeGreaterThan(0);
        expect(before.diagnostics.queries.sourceLoading, `${corpusCase.id}\n${detail}`).toBe(1);
      }
    }
    expect(search).toHaveBeenCalledTimes(lexical.queries.reduce((total, query) => total + (query.diagnostics.queries.byRoute.lexical ?? 0), 0));
    expect(health).toHaveBeenCalledTimes(1);
    expect(lexical.overall.recallAt5, detail).toBeGreaterThanOrEqual(baseline.overall.recallAt5);
    expect(lexical.overall.mrrAt3, detail).toBeGreaterThanOrEqual(baseline.overall.mrrAt3);
    expect(lexical.overall.refusalAccuracy, detail).toBeGreaterThanOrEqual(baseline.overall.refusalAccuracy);
    expect(
      lexical.overall.recallAt5 > baseline.overall.recallAt5 ||
      lexical.overall.mrrAt3 > baseline.overall.mrrAt3 ||
      lexical.queries.some((query, index) => query.expectedRanks.some((rank, rankIndex) =>
        rank.rank !== null && (baseline.queries[index]!.expectedRanks[rankIndex]!.rank === null || rank.rank < baseline.queries[index]!.expectedRanks[rankIndex]!.rank!)
      )),
      detail,
    ).toBe(true);
    search.mockRestore();
    health.mockRestore();
  }, 30_000);
});
