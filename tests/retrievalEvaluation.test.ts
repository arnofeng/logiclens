import { describe, expect, it } from "vitest";
import { mrrAtK, recallAtK, refusalAccuracy, runRetrievalEvaluation, type EvaluationCorpusCase } from "../src/core/retrieval/evaluation.js";

const diagnostics = {
  providers: { semantic: { status: "disabled" }, lexical: { status: "succeeded" } },
  queries: { total: 3, byRoute: { lexical: 1, exact: 1 }, sourceLoading: 1 },
} as const;

describe("retrieval evaluation", () => {
  it("calculates recall for multiple relevant identities without duplicate inflation", () => {
    expect(recallAtK(["a", "b"], ["a", "a", "b"], 3)).toBe(1);
    expect(recallAtK(["a", "b"], ["a", "a", "b"], 2)).toBe(0.5);
  });
  it("handles empty results and one-based reciprocal rank boundaries", () => {
    expect(recallAtK(["a"], [], 5)).toBe(0);
    expect(mrrAtK(["a"], ["x", "a"], 1)).toBe(0);
    expect(mrrAtK(["a"], ["x", "a"], 2)).toBe(0.5);
    expect(mrrAtK(["a"], ["x", "y", "a"], 3)).toBe(1 / 3);
    expect(mrrAtK(["a"], ["x", "y", "z", "a"], 3)).toBe(0);
    expect(mrrAtK(["a"], ["a"], 0)).toBe(0);
  });
  it("scores refusal behavior for unanswerable questions", () => {
    expect(refusalAccuracy(false, [])).toBe(1);
    expect(refusalAccuracy(false, ["unsupported"])).toBe(0);
    expect(refusalAccuracy(true, ["evidence"])).toBe(1);
    expect(refusalAccuracy(true, [])).toBe(0);
  });

  it("runs and deterministically aggregates categories and languages", async () => {
    const corpus: EvaluationCorpusCase[] = [
      { id: "z-refusal", question: "z", category: "refusal", language: "en", answerable: false, expectedCanonicalIds: [] },
      { id: "a-multi", question: "a", category: "code", language: "mixed", answerable: true, expectedCanonicalIds: ["b", "a", "a"] },
      { id: "m-missed", question: "m", category: "code", language: "en", answerable: true, expectedCanonicalIds: ["c"] },
    ];
    const outputs = new Map([
      ["a-multi", { rankedCanonicalIds: ["a", "a", "x", "b"], outcome: "succeeded", diagnostics }],
      ["m-missed", { rankedCanonicalIds: [], outcome: "no_results", diagnostics }],
      ["z-refusal", { rankedCanonicalIds: ["wrong"], outcome: "succeeded", diagnostics }],
    ]);
    const execute = (entry: EvaluationCorpusCase) => outputs.get(entry.id)!;
    const report = await runRetrievalEvaluation(corpus, execute);
    const reversed = await runRetrievalEvaluation([...corpus].reverse(), execute);

    expect(report).toEqual(reversed);
    expect(report.queries.map(({ queryId }) => queryId)).toEqual(["a-multi", "m-missed", "z-refusal"]);
    expect(report.byCategory.map(({ key }) => key)).toEqual(["code", "refusal"]);
    expect(report.byLanguage.map(({ key }) => key)).toEqual(["en", "mixed"]);
    expect(report.queries[0]).toMatchObject({
      expectedCanonicalIds: ["a", "b"], recallAt5: 1, mrrAt3: 1, refusalCorrect: true,
      expectedRanks: [{ canonicalId: "a", rank: 1 }, { canonicalId: "b", rank: 4 }],
      diagnostics,
    });
    expect(report.overall).toEqual({ caseCount: 3, answerableCount: 2, refusalCount: 1, recallAt5: 0.5, mrrAt3: 0.5, refusalAccuracy: 1 / 3 });
    expect(report.failedQueryIds).toEqual(["m-missed", "z-refusal"]);
    expect(report.failures).toEqual([
      expect.stringContaining("m-missed [code/en]"),
      expect.stringContaining("z-refusal [refusal/en]"),
    ]);
  });

  it("defines empty corpus and empty expected identity behavior", async () => {
    const empty = await runRetrievalEvaluation([], () => { throw new Error("not called"); });
    expect(empty.overall).toEqual({ caseCount: 0, answerableCount: 0, refusalCount: 0, recallAt5: 1, mrrAt3: 1, refusalAccuracy: 1 });
    expect(empty.byCategory).toEqual([]);
    expect(empty.byLanguage).toEqual([]);
    await expect(runRetrievalEvaluation([
      { id: "same", question: "a", category: "a", language: "en", answerable: false, expectedCanonicalIds: [] },
      { id: "same", question: "b", category: "b", language: "en", answerable: false, expectedCanonicalIds: [] },
    ], () => ({ rankedCanonicalIds: [], outcome: "no_results", diagnostics }))).rejects.toThrow("Duplicate evaluation query id: same");
  });

  it("keeps reports free of retrieval bodies and indexing metadata", async () => {
    const report = await runRetrievalEvaluation([
      { id: "safe", question: "secret body", category: "code", language: "en", answerable: true, expectedCanonicalIds: ["id"] },
    ], () => ({ rankedCanonicalIds: ["id"], outcome: "succeeded", diagnostics }));
    const json = JSON.stringify(report);
    expect(json).not.toContain("secret body");
    for (const forbidden of ["searchableText", "tokens", "sourceHash", "batchId", "body"]) expect(json).not.toContain(forbidden);
  });
});
