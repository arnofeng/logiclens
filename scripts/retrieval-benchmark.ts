import fs from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_RETRIEVAL_BENCHMARK_OPTIONS,
  runRetrievalBenchmark,
  toIndexingBenchmarkSample,
  type WorkspaceBenchmarkReport,
} from "../src/core/retrieval/benchmark.js";
import { QUALITY_GATE_CORPUS } from "../tests/retrieval/workspaceCorpus.js";
import {
  createWorkspaceEvaluationFixture,
  EVALUATION_RETRIEVE_OPTIONS,
} from "../tests/retrieval/workspaceEvaluationFixture.js";

const originalFetch = globalThis.fetch;
let fixture: Awaited<ReturnType<typeof createWorkspaceEvaluationFixture>> | undefined;
try {
  globalThis.fetch = (async () => {
    throw new Error("retrieval benchmark forbids network access");
  }) as typeof fetch;
  fixture = await createWorkspaceEvaluationFixture({ copyWorkspace: true });
  const changedFile = path.join(fixture.reposDirectory, "api", "src", "contracts", "orders.ts");
  await fs.appendFile(changedFile, "\n// retrieval benchmark changed-only marker\n", "utf8");
  const changedOnly = await fixture.client.index({ changedOnly: true, writeMode: "merge" });
  if (changedOnly.filesChanged <= 0) {
    throw new Error("Changed-only benchmark did not detect the controlled fixture modification.");
  }

  const retrieval = await runRetrievalBenchmark(
    QUALITY_GATE_CORPUS.map(({ id, question }) => ({ id, question })),
    DEFAULT_RETRIEVAL_BENCHMARK_OPTIONS,
    async (query) => fixture.client.retrieve(query.question, {
      ...EVALUATION_RETRIEVE_OPTIONS,
      lexical: true,
      semantic: false,
    }),
  );
  const report: WorkspaceBenchmarkReport = Object.freeze({
    retrieval,
    indexing: Object.freeze({
      fullRebuild: toIndexingBenchmarkSample(fixture.fullIndexResult),
      changedOnly: toIndexingBenchmarkSample(changedOnly),
    }),
  });
  process.stdout.write(`${JSON.stringify(report)}\n`);
} finally {
  globalThis.fetch = originalFetch;
  await fixture?.close();
}
