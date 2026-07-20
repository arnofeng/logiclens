import { runRetrievalEvaluation } from "../src/core/retrieval/evaluation.js";
import { QUALITY_GATE_CORPUS } from "../tests/retrieval/workspaceCorpus.js";
import { createWorkspaceEvaluationFixture, EVALUATION_RETRIEVE_OPTIONS } from "../tests/retrieval/workspaceEvaluationFixture.js";

const fixture = await createWorkspaceEvaluationFixture();
try {
  const report = await runRetrievalEvaluation(QUALITY_GATE_CORPUS, (corpusCase) => fixture.execute(corpusCase.question, {
    ...EVALUATION_RETRIEVE_OPTIONS,
    lexical: true,
  }));
  process.stdout.write(`${JSON.stringify(report)}\n`);
} finally {
  await fixture.close();
}
