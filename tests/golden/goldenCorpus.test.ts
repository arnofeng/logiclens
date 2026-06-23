import path from "node:path";
import { describe, expect, it } from "vitest";
import { extractCrossRepoContracts } from "../../src/extractors/crossRepoContracts.js";
import { evaluateGoldenCorpus, formatGoldenEvaluationReport } from "../../src/golden/evaluate.js";
import { parseSourceFile } from "../../src/parsers/parserRegistry.js";
import type { ParsedGraphFile } from "../../src/parsers/types.js";
import { goldenExpectations, goldenFiles, goldenRepos } from "./corpus.js";

describe("Golden Corpus", () => {
  it("keeps cross-repo contract and dependency extraction at the golden baseline", async () => {
    const reposByName = new Map(goldenRepos.map((repo) => [repo.name, repo]));
    const parsedFiles: ParsedGraphFile[] = [];

    for (const file of goldenFiles) {
      const repo = reposByName.get(file.repo);
      if (!repo) throw new Error(`Unknown golden repo: ${file.repo}`);
      parsedFiles.push(await parseSourceFile({
        repoId: repo.id,
        absolutePath: path.join(repo.path, file.path),
        relativePath: file.path,
        language: file.language
      }));
    }

    const facts = await extractCrossRepoContracts(goldenRepos, parsedFiles);
    const report = evaluateGoldenCorpus(facts, goldenRepos, goldenExpectations);

    expect(report.contracts.falseNegative, formatGoldenEvaluationReport(report)).toEqual([]);
    expect(report.participants.falseNegative, formatGoldenEvaluationReport(report)).toEqual([]);
    expect(report.dependencies.falseNegative, formatGoldenEvaluationReport(report)).toEqual([]);
    expect(report.absentContracts.violations, formatGoldenEvaluationReport(report)).toEqual([]);
    expect(report.contracts.precision).toBe(1);
    expect(report.contracts.recall).toBe(1);
    expect(report.participants.precision).toBe(1);
    expect(report.participants.recall).toBe(1);
    expect(report.dependencies.precision).toBe(1);
    expect(report.dependencies.recall).toBe(1);
    expect(report.passed).toBe(true);
  }, 20000);
});
