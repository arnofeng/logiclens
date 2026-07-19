import type { RetrievalRoute } from "./planner.js";
import {
  createRetrievalCandidate,
  selectCandidateProvenance,
  stableCandidateKey,
  strongestCandidateConfidence,
  type CandidateConfidence,
  type CandidateProvenance,
  type CandidateRouteMembership,
  type RetrievalCandidate
} from "./candidates.js";

export type FusionRouteDiagnostic = Readonly<{
  route: RetrievalRoute;
  rank: number;
  weight: number;
  contribution: number;
}>;

export type FusionDiagnostics = Readonly<{
  routes: readonly FusionRouteDiagnostic[];
  confidenceSignal: CandidateConfidence;
  confidenceContribution: number;
  totalScore: number;
  matchReasons: readonly string[];
  selectedProvenance?: CandidateProvenance;
}>;

export type FusedRetrievalCandidate = RetrievalCandidate & Readonly<{
  fusionScore: number;
  diagnostics: FusionDiagnostics;
}>;

export type FusionOptions = Readonly<{
  rrfConstant?: number;
  routeWeights?: Partial<Record<RetrievalRoute, number>>;
  confidenceWeights?: Partial<Record<CandidateConfidence, number>>;
  precision?: number;
}>;

const DEFAULT_CONFIDENCE_WEIGHTS: Record<CandidateConfidence, number> = {
  exact: 1,
  "resolved-contract": 0.5,
  corroborated: 0,
  discovery: 0
};

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function finiteNonNegative(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be a finite non-negative number.`);
  return value;
}

function rounded(value: number, precision: number): number {
  return Number(value.toFixed(precision));
}

function mergeCandidates(candidates: readonly RetrievalCandidate[]): RetrievalCandidate {
  const ordered = [...candidates].sort((left, right) =>
    stableCandidateKey(left).localeCompare(stableCandidateKey(right)) ||
    (left.renderRef ?? "").localeCompare(right.renderRef ?? "")
  );
  const first = ordered[0]!;
  return createRetrievalCandidate({
    canonicalId: first.canonicalId,
    repoId: first.repoId,
    kind: first.kind,
    provenance: ordered.flatMap((candidate) => candidate.provenance),
    routes: ordered.flatMap((candidate) => candidate.routes),
    matchReasons: ordered.flatMap((candidate) => candidate.matchReasons),
    confidence: strongestCandidateConfidence(ordered.map((candidate) => candidate.confidence))
  });
}

export function reciprocalRankFusion(
  candidates: readonly RetrievalCandidate[],
  options: FusionOptions = {}
): FusedRetrievalCandidate[] {
  const rrfConstant = finiteNonNegative(options.rrfConstant ?? 60, "RRF constant");
  const precision = options.precision ?? 12;
  if (!Number.isSafeInteger(precision) || precision < 0 || precision > 15) {
    throw new Error("Fusion precision must be an integer between 0 and 15.");
  }
  const groups = new Map<string, RetrievalCandidate[]>();
  for (const candidate of candidates) {
    const key = stableCandidateKey(candidate);
    const values = groups.get(key) ?? [];
    values.push(candidate);
    groups.set(key, values);
  }

  return [...groups.entries()].map(([key, values]) => {
    const candidate = mergeCandidates(values);
    const routes = candidate.routes.map((membership: CandidateRouteMembership): FusionRouteDiagnostic => {
      const weight = finiteNonNegative(options.routeWeights?.[membership.route] ?? 1, `Route weight for ${membership.route}`);
      return Object.freeze({
        route: membership.route,
        rank: membership.rank,
        weight: rounded(weight, precision),
        contribution: rounded(weight / (rrfConstant + membership.rank), precision)
      });
    });
    const confidenceContribution = rounded(finiteNonNegative(
      options.confidenceWeights?.[candidate.confidence] ?? DEFAULT_CONFIDENCE_WEIGHTS[candidate.confidence],
      `Confidence weight for ${candidate.confidence}`
    ), precision);
    const totalScore = rounded(routes.reduce((sum, route) => sum + route.contribution, 0) + confidenceContribution, precision);
    const selectedProvenance = selectCandidateProvenance(candidate.provenance);
    const diagnostics: FusionDiagnostics = Object.freeze({
      routes: Object.freeze(routes),
      confidenceSignal: candidate.confidence,
      confidenceContribution,
      totalScore,
      matchReasons: candidate.matchReasons,
      ...(selectedProvenance ? { selectedProvenance } : {})
    });
    return Object.freeze({ ...candidate, fusionScore: totalScore, diagnostics, key });
  }).sort((left, right) =>
    right.fusionScore - left.fusionScore || compareText(stableCandidateKey(left), stableCandidateKey(right))
  ).map(({ key: _key, ...candidate }) => Object.freeze(candidate));
}
