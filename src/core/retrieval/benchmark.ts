import type { IndexResult } from "../indexing/types.js";
import type { RetrievalDiagnostics, RetrievalOutcome } from "../../features/ask/diagnostics.js";
import type { RetrievalResult } from "../../features/ask/retrieve.js";
import type { RetrievalRoute } from "../../features/ask/planner.js";
import type { RetrieverRouteStatus } from "../../features/ask/retrievers/types.js";
import { BRAND } from "../../shared/branding.js";

export const RETRIEVAL_BENCHMARK_SCHEMA = `${BRAND.cliName}.retrieval-benchmark` as const;
export const DEFAULT_RETRIEVAL_BENCHMARK_OPTIONS = Object.freeze({
  warmupRuns: 1,
  measuredRuns: 3,
});

const ROUTES = Object.freeze([
  "exact",
  "contract",
  "entity",
  "lexical",
  "graph",
  "semantic",
] as const satisfies readonly RetrievalRoute[]);

export type BenchmarkOptions = Readonly<{
  warmupRuns: number;
  measuredRuns: number;
  queryCount: number;
  unit: "ms";
}>;

export type BenchmarkQuery = Readonly<{
  id: string;
  question: string;
}>;

export type StageSample = Readonly<{
  queryId: string;
  iteration: number;
  durationMs: number;
}>;

export type PercentileSummary = Readonly<{
  sampleCount: number;
  min: number;
  max: number;
  p50: number;
  p95: number;
  unit: "ms";
}>;

export type StageBenchmark = Readonly<{
  samples: readonly StageSample[];
  summary: PercentileSummary;
}>;

export type RetrievalMeasurementDiagnostic = Readonly<{
  queryId: string;
  iteration: number;
  outcome: RetrievalOutcome;
  providers: Readonly<{
    lexical: RetrieverRouteStatus;
    semantic: RetrieverRouteStatus;
  }>;
  queries: Readonly<{
    total: number;
    byRoute: Readonly<Record<RetrievalRoute, number>>;
  }>;
}>;

export type RetrievalBenchmarkReport = Readonly<{
  schema: typeof RETRIEVAL_BENCHMARK_SCHEMA;
  version: 1;
  options: BenchmarkOptions;
  queryIds: readonly string[];
  providerSearch: StageBenchmark;
  fusion: StageBenchmark;
  selection: StageBenchmark;
  sourceLoading: StageBenchmark;
  endToEnd: StageBenchmark;
  diagnostics: Readonly<{
    measurements: readonly RetrievalMeasurementDiagnostic[];
    queryCount: Readonly<{
      total: number;
      byRoute: Readonly<Record<RetrievalRoute, number>>;
    }>;
    providers: Readonly<{
      lexical: Readonly<Record<RetrieverRouteStatus, number>>;
      semantic: Readonly<Record<RetrieverRouteStatus, number>>;
    }>;
  }>;
}>;

export type IndexingBenchmarkSample = Readonly<{
  durationMs: number;
  filesScanned: number;
  filesChanged: number;
  lexicalDocumentCount: number;
  lexicalIndexSizeBytes: number;
  lexicalIndexStatus: IndexResult["lexicalIndexStatus"];
  lexicalProjectionDurationMs: number;
  lexicalWriteDurationMs: number;
}>;

export type IndexingBenchmarkReport = Readonly<{
  fullRebuild: IndexingBenchmarkSample;
  changedOnly: IndexingBenchmarkSample;
}>;

export type WorkspaceBenchmarkReport = Readonly<{
  retrieval: RetrievalBenchmarkReport;
  indexing: IndexingBenchmarkReport;
}>;

type BenchmarkExecutor = (
  query: BenchmarkQuery,
  context: Readonly<{ phase: "warmup" | "measured"; iteration: number }>,
) => Promise<RetrievalResult>;

type BenchmarkRunnerDependencies = Readonly<{
  now?: () => number;
}>;

function assertRunCount(value: number, label: string, allowZero: boolean): void {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new Error(`${label} must be a ${allowZero ? "non-negative" : "positive"} safe integer.`);
  }
}

function assertDuration(value: number, label = "duration"): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative finite number of milliseconds.`);
  }
}

function percentile(sorted: readonly number[], fraction: number): number {
  const index = Math.max(0, Math.ceil(fraction * sorted.length) - 1);
  return sorted[index]!;
}

/**
 * Summarizes millisecond samples with nearest-rank percentiles. Samples are
 * sorted ascending and the rank index is max(0, ceil(p * n) - 1).
 */
export function summarizeDurations(samples: readonly number[]): PercentileSummary {
  if (samples.length === 0) throw new Error("At least one measured duration is required.");
  const sorted = samples.map((sample, index) => {
    assertDuration(sample, `duration sample ${index}`);
    return sample;
  }).sort((left, right) => left - right);
  return Object.freeze({
    sampleCount: sorted.length,
    min: sorted[0]!,
    max: sorted.at(-1)!,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    unit: "ms",
  });
}

function stageBenchmark(samples: readonly StageSample[]): StageBenchmark {
  const stableSamples = Object.freeze(samples.map((sample) => Object.freeze({ ...sample })));
  return Object.freeze({
    samples: stableSamples,
    summary: summarizeDurations(stableSamples.map(({ durationMs }) => durationMs)),
  });
}

function stableRouteCounts(
  counts?: Readonly<Partial<Record<RetrievalRoute, number>>>,
): Readonly<Record<RetrievalRoute, number>> {
  return Object.freeze(Object.fromEntries(ROUTES.map((route) => {
    const value = counts?.[route] ?? 0;
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`Query count for route ${route} must be a non-negative safe integer.`);
    }
    return [route, value];
  })) as Record<RetrievalRoute, number>);
}

function emptyProviderCounts(): Record<RetrieverRouteStatus, number> {
  return {
    succeeded: 0,
    disabled: 0,
    unavailable: 0,
    unhealthy: 0,
    failed: 0,
  };
}

function requireSuccessfulResult(queryId: string, result: RetrievalResult): RetrievalDiagnostics {
  if (result.outcome === "failed") {
    throw new Error(`Retrieval benchmark failed for query ${queryId}: outcome=failed.`);
  }
  if (!result.diagnostics?.timings || !result.diagnostics.queries || !result.diagnostics.providers) {
    throw new Error(`Retrieval benchmark failed for query ${queryId}: diagnostics are missing.`);
  }
  return result.diagnostics;
}

async function executeQuery(
  execute: BenchmarkExecutor,
  query: BenchmarkQuery,
  context: Readonly<{ phase: "warmup" | "measured"; iteration: number }>,
): Promise<RetrievalResult> {
  try {
    return await execute(query, context);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Retrieval benchmark executor failed for query ${query.id}: ${message}`, { cause: error });
  }
}

export async function runRetrievalBenchmark(
  queries: readonly BenchmarkQuery[],
  options: Readonly<{ warmupRuns: number; measuredRuns: number }>,
  execute: BenchmarkExecutor,
  dependencies: BenchmarkRunnerDependencies = {},
): Promise<RetrievalBenchmarkReport> {
  assertRunCount(options.warmupRuns, "warmupRuns", true);
  assertRunCount(options.measuredRuns, "measuredRuns", false);
  if (queries.length === 0) throw new Error("At least one benchmark query is required.");
  const stableQueries = queries.map(({ id, question }) => Object.freeze({ id, question }));
  if (stableQueries.some(({ id }) => id.length === 0) || new Set(stableQueries.map(({ id }) => id)).size !== stableQueries.length) {
    throw new Error("Benchmark query ids must be non-empty and unique.");
  }
  const now = dependencies.now ?? (() => performance.now());

  for (let iteration = 0; iteration < options.warmupRuns; iteration += 1) {
    for (const query of stableQueries) {
      const result = await executeQuery(execute, query, Object.freeze({ phase: "warmup", iteration }));
      requireSuccessfulResult(query.id, result);
    }
  }

  const stageSamples = {
    providerSearch: [] as StageSample[],
    fusion: [] as StageSample[],
    selection: [] as StageSample[],
    sourceLoading: [] as StageSample[],
    endToEnd: [] as StageSample[],
  };
  const measurements: RetrievalMeasurementDiagnostic[] = [];
  const totalByRoute = { ...stableRouteCounts() };
  let totalQueries = 0;
  const lexicalProviders = emptyProviderCounts();
  const semanticProviders = emptyProviderCounts();

  for (let iteration = 0; iteration < options.measuredRuns; iteration += 1) {
    for (const query of stableQueries) {
      const started = now();
      assertDuration(started, "monotonic clock value");
      const result = await executeQuery(execute, query, Object.freeze({ phase: "measured", iteration }));
      const ended = now();
      assertDuration(ended, "monotonic clock value");
      const endToEnd = ended - started;
      assertDuration(endToEnd, "end-to-end duration");
      const diagnostics = requireSuccessfulResult(query.id, result);
      const durations = {
        providerSearch: diagnostics.timings.lexical.durationMs,
        fusion: diagnostics.timings.fusion.durationMs,
        selection: diagnostics.timings.selection.durationMs,
        sourceLoading: diagnostics.timings.sourceLoading.durationMs,
        endToEnd,
      };
      for (const [stage, durationMs] of Object.entries(durations) as [keyof typeof durations, number][]) {
        assertDuration(durationMs, `${stage} duration for query ${query.id}`);
        stageSamples[stage].push(Object.freeze({ queryId: query.id, iteration, durationMs }));
      }
      const byRoute = stableRouteCounts(diagnostics.queries.byRoute);
      if (!Number.isSafeInteger(diagnostics.queries.total) || diagnostics.queries.total < 0) {
        throw new Error(`Total query count for ${query.id} must be a non-negative safe integer.`);
      }
      totalQueries += diagnostics.queries.total;
      for (const route of ROUTES) totalByRoute[route] += byRoute[route];
      lexicalProviders[diagnostics.providers.lexical.status] += 1;
      semanticProviders[diagnostics.providers.semantic.status] += 1;
      measurements.push(Object.freeze({
        queryId: query.id,
        iteration,
        outcome: result.outcome,
        providers: Object.freeze({
          lexical: diagnostics.providers.lexical.status,
          semantic: diagnostics.providers.semantic.status,
        }),
        queries: Object.freeze({ total: diagnostics.queries.total, byRoute }),
      }));
    }
  }

  const benchmarkOptions = Object.freeze({
    warmupRuns: options.warmupRuns,
    measuredRuns: options.measuredRuns,
    queryCount: stableQueries.length,
    unit: "ms" as const,
  });
  return Object.freeze({
    schema: RETRIEVAL_BENCHMARK_SCHEMA,
    version: 1,
    options: benchmarkOptions,
    queryIds: Object.freeze(stableQueries.map(({ id }) => id)),
    providerSearch: stageBenchmark(stageSamples.providerSearch),
    fusion: stageBenchmark(stageSamples.fusion),
    selection: stageBenchmark(stageSamples.selection),
    sourceLoading: stageBenchmark(stageSamples.sourceLoading),
    endToEnd: stageBenchmark(stageSamples.endToEnd),
    diagnostics: Object.freeze({
      measurements: Object.freeze(measurements),
      queryCount: Object.freeze({ total: totalQueries, byRoute: totalByRoute }),
      providers: Object.freeze({
        lexical: Object.freeze(lexicalProviders),
        semantic: Object.freeze(semanticProviders),
      }),
    }),
  });
}

function assertIndexMetric(value: number, label: string, integer = false): void {
  if (!Number.isFinite(value) || value < 0 || (integer && !Number.isSafeInteger(value))) {
    throw new Error(`${label} must be a non-negative ${integer ? "safe integer" : "finite number"}.`);
  }
}

export function toIndexingBenchmarkSample(result: IndexResult): IndexingBenchmarkSample {
  assertIndexMetric(result.durationMs, "durationMs");
  assertIndexMetric(result.filesScanned, "filesScanned", true);
  assertIndexMetric(result.filesChanged, "filesChanged", true);
  assertIndexMetric(result.lexicalDocumentCount, "lexicalDocumentCount", true);
  assertIndexMetric(result.lexicalIndexSizeBytes, "lexicalIndexSizeBytes", true);
  assertIndexMetric(result.lexicalProjectionDurationMs, "lexicalProjectionDurationMs");
  assertIndexMetric(result.lexicalWriteDurationMs, "lexicalWriteDurationMs");
  return Object.freeze({
    durationMs: result.durationMs,
    filesScanned: result.filesScanned,
    filesChanged: result.filesChanged,
    lexicalDocumentCount: result.lexicalDocumentCount,
    lexicalIndexSizeBytes: result.lexicalIndexSizeBytes,
    lexicalIndexStatus: result.lexicalIndexStatus,
    lexicalProjectionDurationMs: result.lexicalProjectionDurationMs,
    lexicalWriteDurationMs: result.lexicalWriteDurationMs,
  });
}
