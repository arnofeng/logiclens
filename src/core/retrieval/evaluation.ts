import { BRAND } from "../../shared/branding.js";

function atK<T>(values: readonly T[], k: number): readonly T[] {
  if (!Number.isInteger(k) || k < 0) {
    throw new Error("k must be a non-negative integer.");
  }
  return values.slice(0, k);
}

/** Fraction of unique expected identities recovered among the first k results. */
export function recallAtK(expectedCanonicalIds: readonly string[], rankedCanonicalIds: readonly string[], k: number): number {
  const expected = new Set(expectedCanonicalIds);
  if (expected.size === 0) return 1;
  const found = new Set(atK(rankedCanonicalIds, k).filter((id) => expected.has(id)));
  return found.size / expected.size;
}

/** Reciprocal rank of the first expected identity among the first k results. */
export function mrrAtK(expectedCanonicalIds: readonly string[], rankedCanonicalIds: readonly string[], k: number): number {
  const expected = new Set(expectedCanonicalIds);
  const rank = atK(rankedCanonicalIds, k).findIndex((id) => expected.has(id));
  return rank === -1 ? 0 : 1 / (rank + 1);
}

/** A refusal is correct exactly when an unanswerable case has no returned evidence. */
export function refusalAccuracy(answerable: boolean, returnedCanonicalIds: readonly string[]): number {
  return Number(answerable ? returnedCanonicalIds.length > 0 : returnedCanonicalIds.length === 0);
}

export const RETRIEVAL_EVALUATION_SCHEMA = `${BRAND.cliName}.retrieval-evaluation` as const;
export const RETRIEVAL_EVALUATION_VERSION = 1;

export type EvaluationCorpusCase = Readonly<{
  id: string;
  question: string;
  category: string;
  language: string;
  answerable: boolean;
  expectedCanonicalIds: readonly string[];
}>;

export type EvaluationDiagnostics = Readonly<{
  providers: Readonly<Record<string, Readonly<{ status: string }>>>;
  queries: Readonly<{
    total: number;
    byRoute: Readonly<Record<string, number>>;
    sourceLoading: number;
  }>;
}>;

export type EvaluationExecutionResult = Readonly<{
  rankedCanonicalIds: readonly string[];
  outcome: string;
  diagnostics: EvaluationDiagnostics;
}>;

export type EvaluationExpectedRank = Readonly<{
  canonicalId: string;
  rank: number | null;
}>;

export type EvaluationQueryResult = Readonly<{
  queryId: string;
  category: string;
  language: string;
  answerable: boolean;
  expectedCanonicalIds: readonly string[];
  rankedCanonicalIds: readonly string[];
  expectedRanks: readonly EvaluationExpectedRank[];
  recallAt5: number;
  mrrAt3: number;
  refusalCorrect: boolean;
  outcome: string;
  diagnostics: EvaluationDiagnostics;
}>;

export type EvaluationMetrics = Readonly<{
  caseCount: number;
  answerableCount: number;
  refusalCount: number;
  recallAt5: number;
  mrrAt3: number;
  refusalAccuracy: number;
}>;

export type EvaluationMetricGroup = Readonly<{
  key: string;
  metrics: EvaluationMetrics;
}>;

export type RetrievalEvaluationReport = Readonly<{
  schema: typeof RETRIEVAL_EVALUATION_SCHEMA;
  version: typeof RETRIEVAL_EVALUATION_VERSION;
  overall: EvaluationMetrics;
  byCategory: readonly EvaluationMetricGroup[];
  byLanguage: readonly EvaluationMetricGroup[];
  queries: readonly EvaluationQueryResult[];
  failedQueryIds: readonly string[];
  failures: readonly string[];
}>;

export type RetrievalEvaluationExecutor = (
  corpusCase: EvaluationCorpusCase,
) => Promise<EvaluationExecutionResult> | EvaluationExecutionResult;

function sortedUnique(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)].sort((left, right) => left.localeCompare(right)));
}

function stableDiagnostics(diagnostics: EvaluationDiagnostics): EvaluationDiagnostics {
  return Object.freeze({
    providers: Object.freeze(Object.fromEntries(Object.entries(diagnostics.providers)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([provider, value]) => [provider, Object.freeze({ status: value.status })]))),
    queries: Object.freeze({
      total: diagnostics.queries.total,
      byRoute: Object.freeze(Object.fromEntries(Object.entries(diagnostics.queries.byRoute)
        .sort(([left], [right]) => left.localeCompare(right)))),
      sourceLoading: diagnostics.queries.sourceLoading,
    }),
  });
}

function summarize(results: readonly EvaluationQueryResult[]): EvaluationMetrics {
  const answerable = results.filter((result) => result.answerable);
  const average = (values: readonly number[], emptyValue: number) =>
    values.length === 0 ? emptyValue : values.reduce((total, value) => total + value, 0) / values.length;
  return Object.freeze({
    caseCount: results.length,
    answerableCount: answerable.length,
    refusalCount: results.length - answerable.length,
    recallAt5: average(answerable.map((result) => result.recallAt5), 1),
    mrrAt3: average(answerable.map((result) => result.mrrAt3), 1),
    refusalAccuracy: average(results.map((result) => Number(result.refusalCorrect)), 1),
  });
}

function grouped(results: readonly EvaluationQueryResult[], field: "category" | "language"): readonly EvaluationMetricGroup[] {
  const keys = sortedUnique(results.map((result) => result[field]));
  return Object.freeze(keys.map((key) => Object.freeze({
    key,
    metrics: summarize(results.filter((result) => result[field] === key)),
  })));
}

function failureDetail(result: EvaluationQueryResult): string {
  const ranks = result.expectedRanks.map(({ canonicalId, rank }) => `${canonicalId}=${rank ?? "missing"}`).join(", ") || "none";
  return `${result.queryId} [${result.category}/${result.language}]: expected ranks ${ranks}; ` +
    `Recall@5=${result.recallAt5}, MRR@3=${result.mrrAt3}, refusalCorrect=${result.refusalCorrect}; outcome=${result.outcome}`;
}

/** Run a corpus through an injected retrieval executor and return a deterministic, content-safe report. */
export async function runRetrievalEvaluation(
  corpus: readonly EvaluationCorpusCase[],
  execute: RetrievalEvaluationExecutor,
): Promise<RetrievalEvaluationReport> {
  const duplicateIds = corpus.map(({ id }) => id).filter((id, index, ids) => ids.indexOf(id) !== index);
  if (duplicateIds.length > 0) throw new Error(`Duplicate evaluation query id: ${sortedUnique(duplicateIds).join(", ")}`);

  const results = await Promise.all(corpus.map(async (corpusCase): Promise<EvaluationQueryResult> => {
    const execution = await execute(corpusCase);
    const expectedCanonicalIds = sortedUnique(corpusCase.expectedCanonicalIds);
    const rankedCanonicalIds = Object.freeze([...execution.rankedCanonicalIds]);
    const expectedRanks = Object.freeze(expectedCanonicalIds.map((canonicalId) => {
      const index = rankedCanonicalIds.indexOf(canonicalId);
      return Object.freeze({ canonicalId, rank: index === -1 ? null : index + 1 });
    }));
    return Object.freeze({
      queryId: corpusCase.id,
      category: corpusCase.category,
      language: corpusCase.language,
      answerable: corpusCase.answerable,
      expectedCanonicalIds,
      rankedCanonicalIds,
      expectedRanks,
      recallAt5: recallAtK(expectedCanonicalIds, rankedCanonicalIds, 5),
      mrrAt3: mrrAtK(expectedCanonicalIds, rankedCanonicalIds, 3),
      refusalCorrect: refusalAccuracy(corpusCase.answerable, rankedCanonicalIds) === 1,
      outcome: execution.outcome,
      diagnostics: stableDiagnostics(execution.diagnostics),
    });
  }));
  results.sort((left, right) => left.queryId.localeCompare(right.queryId));
  const failed = results.filter((result) => !result.refusalCorrect || (result.answerable && (result.recallAt5 < 1 || result.mrrAt3 === 0)));
  return Object.freeze({
    schema: RETRIEVAL_EVALUATION_SCHEMA,
    version: RETRIEVAL_EVALUATION_VERSION,
    overall: summarize(results),
    byCategory: grouped(results, "category"),
    byLanguage: grouped(results, "language"),
    queries: Object.freeze(results),
    failedQueryIds: Object.freeze(failed.map(({ queryId }) => queryId)),
    failures: Object.freeze(failed.map(failureDetail)),
  });
}
