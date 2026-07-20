import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runRetrievalEvaluation, type RetrievalEvaluationReport } from "../src/core/retrieval/evaluation.js";
import { QUALITY_GATE_CORPUS } from "./retrieval/workspaceCorpus.js";
import { createWorkspaceEvaluationFixture, EVALUATION_RETRIEVE_OPTIONS, type WorkspaceEvaluationFixture } from "./retrieval/workspaceEvaluationFixture.js";

const MIN_RECALL_AT_5 = 0.80;
const MIN_MRR_AT_3 = 0.80;

function qualityFailure(report: RetrievalEvaluationReport): string {
  return report.queries.map((query) => `${query.queryId} [${query.category}/${query.language}]: ` +
    `expected=${JSON.stringify(query.expectedCanonicalIds)}, top5=${query.rankedCanonicalIds.slice(0, 5).map((id, index) => `${index + 1}:${id}`).join(",")}, ` +
    `Recall@5=${query.recallAt5}, MRR@3=${query.mrrAt3}, refusalCorrect=${query.refusalCorrect}, outcome=${query.outcome}, ` +
    `lexical=${query.diagnostics.providers.lexical?.status}, queries=${JSON.stringify(query.diagnostics.queries)}`).join("\n");
}

describe("workspace retrieval multilingual quality", () => {
  let fixture: WorkspaceEvaluationFixture;
  beforeAll(async () => { fixture = await createWorkspaceEvaluationFixture(); }, 30_000);
  afterAll(async () => { await fixture?.close(); });

  it("meets raw quality thresholds overall and for every language", async () => {
    const report = await runRetrievalEvaluation(QUALITY_GATE_CORPUS, (corpusCase) => fixture.execute(corpusCase.question, {
      ...EVALUATION_RETRIEVE_OPTIONS,
      lexical: true,
    }));
    const detail = qualityFailure(report);
    expect(report.overall.recallAt5, detail).toBeGreaterThanOrEqual(MIN_RECALL_AT_5);
    expect(report.overall.mrrAt3, detail).toBeGreaterThanOrEqual(MIN_MRR_AT_3);
    expect(report.overall.refusalAccuracy, detail).toBe(1);
    expect(report.byLanguage.map(({ key }) => key), detail).toEqual(["en", "mixed", "zh"]);
    for (const language of report.byLanguage) {
      expect(language.metrics.answerableCount, `${language.key}\n${detail}`).toBeGreaterThan(0);
      expect(language.metrics.recallAt5, `${language.key}\n${detail}`).toBeGreaterThanOrEqual(MIN_RECALL_AT_5);
      expect(language.metrics.mrrAt3, `${language.key}\n${detail}`).toBeGreaterThanOrEqual(MIN_MRR_AT_3);
      expect(language.metrics.refusalAccuracy, `${language.key}\n${detail}`).toBe(1);
    }
  }, 30_000);
});
