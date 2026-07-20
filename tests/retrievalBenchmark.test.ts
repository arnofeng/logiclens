import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_RETRIEVAL_BENCHMARK_OPTIONS,
  runRetrievalBenchmark,
  summarizeDurations,
} from "../src/core/retrieval/benchmark.js";
import type { RetrievalResult } from "../src/features/ask/retrieve.js";
import { KuzuWorkspaceLexicalStore } from "../src/adapters/graph-db/kuzu/KuzuWorkspaceLexicalStore.js";
import { QUALITY_GATE_CORPUS } from "./retrieval/workspaceCorpus.js";
import {
  createWorkspaceEvaluationFixture,
  EVALUATION_RETRIEVE_OPTIONS,
} from "./retrieval/workspaceEvaluationFixture.js";

const ROUTES = ["exact", "contract", "entity", "lexical", "graph", "semantic"] as const;

function fakeResult(input: Readonly<{
  lexical?: number;
  fusion?: number;
  selection?: number;
  sourceLoading?: number;
  outcome?: "succeeded" | "failed";
}> = {}): RetrievalResult {
  const byRoute = Object.freeze({ exact: 1, contract: 0, entity: 0, lexical: 1, graph: 0, semantic: 0 });
  return {
    outcome: input.outcome ?? "succeeded",
    loadedEvidence: [{ document: { searchableText: "secret body", sourceHash: "secret", batchId: "secret" } }],
    diagnostics: {
      timings: {
        lexical: { status: "completed", durationMs: input.lexical ?? 1 },
        fusion: { status: "completed", durationMs: input.fusion ?? 2 },
        selection: { status: "completed", durationMs: input.selection ?? 3 },
        sourceLoading: { status: "completed", durationMs: input.sourceLoading ?? 4 },
      },
      queries: { total: 2, byRoute },
      providers: {
        lexical: { status: "succeeded" },
        semantic: { status: "disabled" },
      },
    },
  } as unknown as RetrievalResult;
}

describe("retrieval benchmark statistics", () => {
  it("uses nearest-rank P50/P95 for odd, even, and single-sample inputs", () => {
    expect(summarizeDurations([5, 1, 3])).toMatchObject({ min: 1, max: 5, p50: 3, p95: 5, sampleCount: 3, unit: "ms" });
    expect(summarizeDurations([4, 1, 3, 2])).toMatchObject({ p50: 2, p95: 4, sampleCount: 4 });
    expect(summarizeDurations([7.125])).toMatchObject({ p50: 7.125, p95: 7.125, sampleCount: 1 });
  });

  it("does not mutate or depend on the input sample order", () => {
    const samples = [9, 1, 5, 3];
    const original = [...samples];
    expect(summarizeDurations(samples)).toEqual(summarizeDurations([1, 3, 5, 9]));
    expect(samples).toEqual(original);
  });

  it("excludes warmups, maps every stage, and measures end-to-end with the injected clock", async () => {
    const queries = Object.freeze([
      Object.freeze({ id: "q-b", question: "B" }),
      Object.freeze({ id: "q-a", question: "A" }),
    ]);
    const options = Object.freeze({ warmupRuns: 2, measuredRuns: 2 });
    const clockValues = [10, 20.25, 30, 42.5, 50, 63.75, 70, 85.5];
    const now = vi.fn(() => clockValues.shift()!);
    const result = fakeResult({ lexical: 1.25, fusion: 2.5, selection: 3.75, sourceLoading: 4.5 });
    const resultSnapshot = JSON.stringify(result);
    const calls: string[] = [];

    const report = await runRetrievalBenchmark(queries, options, async (query, context) => {
      calls.push(`${context.phase}:${context.iteration}:${query.id}`);
      return context.phase === "warmup" ? fakeResult({ lexical: 999, fusion: 999, selection: 999, sourceLoading: 999 }) : result;
    }, { now });

    expect(calls.slice(0, 4).every((call) => call.startsWith("warmup:"))).toBe(true);
    expect(report.options).toEqual({ warmupRuns: 2, measuredRuns: 2, queryCount: 2, unit: "ms" });
    expect(report.queryIds).toEqual(["q-b", "q-a"]);
    expect(report.providerSearch.samples.map(({ durationMs }) => durationMs)).toEqual([1.25, 1.25, 1.25, 1.25]);
    expect(report.fusion.samples.map(({ durationMs }) => durationMs)).toEqual([2.5, 2.5, 2.5, 2.5]);
    expect(report.selection.samples.map(({ durationMs }) => durationMs)).toEqual([3.75, 3.75, 3.75, 3.75]);
    expect(report.sourceLoading.samples.map(({ durationMs }) => durationMs)).toEqual([4.5, 4.5, 4.5, 4.5]);
    expect(report.endToEnd.samples.map(({ durationMs }) => durationMs)).toEqual([10.25, 12.5, 13.75, 15.5]);
    expect(report.endToEnd.summary).toMatchObject({ sampleCount: 4, p50: 12.5, p95: 15.5 });
    expect(report.diagnostics.queryCount).toEqual({
      total: 8,
      byRoute: { exact: 4, contract: 0, entity: 0, lexical: 4, graph: 0, semantic: 0 },
    });
    expect(Object.keys(report).slice(4, 9)).toEqual(["providerSearch", "fusion", "selection", "sourceLoading", "endToEnd"]);
    expect(JSON.stringify(result)).toBe(resultSnapshot);
    expect(queries).toEqual([{ id: "q-b", question: "B" }, { id: "q-a", question: "A" }]);
    expect(options).toEqual({ warmupRuns: 2, measuredRuns: 2 });
  });

  it("rejects invalid run counts and invalid duration samples", async () => {
    const query = [{ id: "q", question: "Q" }];
    const execute = async () => fakeResult();
    await expect(runRetrievalBenchmark(query, { warmupRuns: -1, measuredRuns: 1 }, execute)).rejects.toThrow("warmupRuns");
    await expect(runRetrievalBenchmark(query, { warmupRuns: 0.5, measuredRuns: 1 }, execute)).rejects.toThrow("warmupRuns");
    await expect(runRetrievalBenchmark(query, { warmupRuns: 0, measuredRuns: 0 }, execute)).rejects.toThrow("measuredRuns");
    await expect(runRetrievalBenchmark(query, { warmupRuns: 0, measuredRuns: Number.MAX_SAFE_INTEGER + 1 }, execute)).rejects.toThrow("measuredRuns");
    for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, -0.1]) {
      expect(() => summarizeDurations([invalid])).toThrow("non-negative finite");
      await expect(runRetrievalBenchmark(query, { warmupRuns: 0, measuredRuns: 1 }, async () => fakeResult({ lexical: invalid }), { now: (() => {
        const values = [0, 1];
        return () => values.shift()!;
      })() })).rejects.toThrow("providerSearch duration");
    }
    expect(() => summarizeDurations([])).toThrow("At least one");
  });

  it("never turns executor failures, failed outcomes, or missing diagnostics into successful reports", async () => {
    const query = [{ id: "broken-query", question: "Q" }];
    await expect(runRetrievalBenchmark(query, { warmupRuns: 0, measuredRuns: 1 }, async () => {
      throw new Error("boom");
    })).rejects.toThrow("broken-query: boom");
    await expect(runRetrievalBenchmark(query, { warmupRuns: 0, measuredRuns: 1 }, async () => fakeResult({ outcome: "failed" }))).rejects.toThrow("broken-query: outcome=failed");
    await expect(runRetrievalBenchmark(query, { warmupRuns: 0, measuredRuns: 1 }, async () => ({ outcome: "succeeded" }) as RetrievalResult)).rejects.toThrow("broken-query: diagnostics are missing");
  });

  it("serializes only benchmark-safe fields", async () => {
    const values = [0, 1];
    const report = await runRetrievalBenchmark([{ id: "safe", question: "Q" }], { warmupRuns: 0, measuredRuns: 1 }, async () => fakeResult(), { now: () => values.shift()! });
    const json = JSON.stringify(report);
    for (const forbidden of ["secret body", "searchableText", "sourceHash", "batchId", "tokens", "API key"]) {
      expect(json).not.toContain(forbidden);
    }
  });
});

describe("real Kuzu retrieval benchmark", () => {
  it("keeps the unrounded end-to-end P95 at or below 500 ms", async () => {
    const originalFetch = globalThis.fetch;
    const fetchSpy = vi.fn(async () => { throw new Error("network must not be used"); });
    globalThis.fetch = fetchSpy as typeof fetch;
    const lexicalSearch = vi.spyOn(KuzuWorkspaceLexicalStore.prototype, "search");
    const fixture = await createWorkspaceEvaluationFixture();
    const retrieve = vi.spyOn(fixture.client, "retrieve");
    try {
      const report = await runRetrievalBenchmark(
        QUALITY_GATE_CORPUS.map(({ id, question }) => ({ id, question })),
        DEFAULT_RETRIEVAL_BENCHMARK_OPTIONS,
        async (query) => fixture.client.retrieve(query.question, {
          ...EVALUATION_RETRIEVE_OPTIONS,
          lexical: true,
          semantic: false,
        }),
      );
      const details = JSON.stringify({
        samples: report.endToEnd.samples,
        p50: report.endToEnd.summary.p50,
        p95: report.endToEnd.summary.p95,
        queryIds: report.queryIds,
        diagnostics: report.diagnostics,
      });
      const expectedMeasuredSamples = QUALITY_GATE_CORPUS.length * DEFAULT_RETRIEVAL_BENCHMARK_OPTIONS.measuredRuns;
      const expectedExecutions = QUALITY_GATE_CORPUS.length * (
        DEFAULT_RETRIEVAL_BENCHMARK_OPTIONS.warmupRuns
        + DEFAULT_RETRIEVAL_BENCHMARK_OPTIONS.measuredRuns
      );
      const expectedIterations = Array.from(
        { length: DEFAULT_RETRIEVAL_BENCHMARK_OPTIONS.measuredRuns },
        (_, iteration) => iteration,
      );
      expect(retrieve).toHaveBeenCalledTimes(expectedExecutions);
      expect(report.endToEnd.summary.sampleCount).toBe(expectedMeasuredSamples);
      for (const stage of ["providerSearch", "fusion", "selection", "sourceLoading", "endToEnd"] as const) {
        expect(report[stage].summary.sampleCount).toBe(expectedMeasuredSamples);
        for (const { id } of QUALITY_GATE_CORPUS) {
          expect(report[stage].samples
            .filter(({ queryId }) => queryId === id)
            .map(({ iteration }) => iteration)).toEqual(expectedIterations);
        }
      }
      for (const { id } of QUALITY_GATE_CORPUS) {
        expect(report.diagnostics.measurements
          .filter(({ queryId }) => queryId === id)
          .map(({ iteration }) => iteration)).toEqual(expectedIterations);
      }
      expect(report.diagnostics.measurements.every(({ providers }) => providers.semantic === "disabled")).toBe(true);
      expect(report.diagnostics.measurements.every(({ providers }) => providers.lexical === "succeeded")).toBe(true);
      expect(report.diagnostics.measurements.every(({ queries }) => queries.byRoute.lexical <= 1)).toBe(true);
      expect(lexicalSearch.mock.calls.length).toBeLessThanOrEqual(expectedExecutions);
      expect(report.endToEnd.summary.p95, details).toBeLessThanOrEqual(500);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(Object.keys(report.diagnostics.queryCount.byRoute)).toEqual(ROUTES);
    } finally {
      retrieve.mockRestore();
      lexicalSearch.mockRestore();
      globalThis.fetch = originalFetch;
      await fixture.close();
    }
  }, 60_000);
});
