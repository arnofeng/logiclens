export type ConfidenceRule =
  | "exact-manifest"
  | "exact-framework-marker"
  | "exact-parser-route"
  | "strong-static-import"
  | "probable-package-path"
  | "probable-http-client"
  | "probable-http-route"
  | "probable-route-merge"
  | "probable-event"
  | "heuristic-package-owner-alias"
  | "heuristic-shared-symbol"
  | "heuristic-config-file"
  | "heuristic-config-reference"
  | "heuristic-section-documents-code"
  | "heuristic-entity-mention"
  | "fallback-framework-language"
  | "fallback-framework-signature";

export type ConfidenceBand = "exact" | "probable" | "heuristic";

export const PROBABLE_CONFIDENCE_THRESHOLD = 0.8;

const CONFIDENCE_BY_RULE: Record<ConfidenceRule, number> = {
  "exact-manifest": 1,
  "exact-framework-marker": 1,
  "exact-parser-route": 0.9,
  "strong-static-import": 0.9,
  "probable-package-path": 0.8,
  "probable-http-client": 0.85,
  "probable-http-route": 0.8,
  "probable-route-merge": 0.85,
  "probable-event": 0.85,
  "heuristic-package-owner-alias": 0.7,
  "heuristic-shared-symbol": 0.75,
  "heuristic-config-file": 0.75,
  "heuristic-config-reference": 0.7,
  "heuristic-section-documents-code": 0.7,
  "heuristic-entity-mention": 0.6,
  "fallback-framework-language": 0.55,
  "fallback-framework-signature": 0.7
};

export function confidenceFor(rule: ConfidenceRule): number {
  return CONFIDENCE_BY_RULE[rule];
}

// Keep output grouping coarse and stable: exact/probable edges are suitable for
// default topology views, while heuristic edges should remain auditable/debuggable.
export function confidenceBand(confidence: number): ConfidenceBand {
  if (confidence >= 0.9) return "exact";
  if (confidence >= PROBABLE_CONFIDENCE_THRESHOLD) return "probable";
  return "heuristic";
}

// Call resolution combines independent static signals. Name match alone is only
// a candidate; locality/import/repo evidence upgrades it into a stronger edge.
export function scoreCallResolution(candidate: { sameFile: boolean; imported: boolean; sameRepo: boolean; nameExact: boolean }): number {
  let score = 0;
  if (candidate.nameExact) score += 0.4;
  if (candidate.sameFile) score += 0.4;
  if (candidate.imported) score += 0.3;
  if (candidate.sameRepo) score += 0.1;
  return Number(Math.min(score, 1).toFixed(2));
}
