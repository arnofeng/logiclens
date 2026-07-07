export type ConfidenceRule =
  | "exact-manifest"
  | "exact-framework-marker"
  | "exact-parser-route"
  | "exact-parser-route-spec"
  | "strong-static-import"
  | "probable-package-path"
  | "probable-http-client"
  | "probable-http-client-spec"
  | "probable-http-route"
  | "probable-route-merge"
  | "exact-event-annotation"
  | "probable-event"
  | "probable-event-spec"
  | "heuristic-package-owner-alias"
  | "heuristic-shared-symbol"
  | "heuristic-config-file"
  | "heuristic-config-reference"
  | "heuristic-section-documents-code"
  | "heuristic-entity-mention"
  | "heuristic-schema-fields"
  | "heuristic-generic-type-param"
  | "heuristic-request-body-type"
  | "heuristic-response-body-type"
  | "fallback-framework-language"
  | "fallback-framework-signature"
  | "method-unknown-fallback"
  | "exact-method-path-match"
  | "path-only-match"
  | "template-compatible-match"
  | "static-path-to-template-match"
  | "wildcard-path-match"
  | "exact-grpc-match"
  | "exact-graphql-match"
  | "probable-regex-route"
  | "probable-grpc-package-unspecified"
  | "probable-grpc-package-mismatch"
  | "exact-dubbo-match"
  | "probable-dubbo-group-version-unspecified"
  | "probable-dubbo-group-version-mismatch";

export type ConfidenceBand = "exact" | "probable" | "heuristic";

export const PROBABLE_CONFIDENCE_THRESHOLD = 0.8;

const CONFIDENCE_BY_RULE: Record<ConfidenceRule, number> = {
  "exact-manifest": 1,
  "exact-framework-marker": 1,
  "exact-parser-route": 0.9,
  "exact-parser-route-spec": 0.9,
  "strong-static-import": 0.9,
  "probable-package-path": 0.8,
  "probable-http-client": 0.85,
  "probable-http-client-spec": 0.85,
  "probable-http-route": 0.8,
  "probable-route-merge": 0.85,
  "exact-event-annotation": 0.9,
  "probable-event": 0.85,
  "probable-event-spec": 0.85,
  "heuristic-package-owner-alias": 0.7,
  "heuristic-shared-symbol": 0.75,
  "heuristic-config-file": 0.75,
  "heuristic-config-reference": 0.7,
  "heuristic-section-documents-code": 0.7,
  "heuristic-entity-mention": 0.6,
  "heuristic-schema-fields": 0.75,
  "heuristic-generic-type-param": 0.7,
  "heuristic-request-body-type": 0.7,
  "heuristic-response-body-type": 0.7,
  "fallback-framework-language": 0.55,
  "fallback-framework-signature": 0.7,
  "method-unknown-fallback": 0.6,
  "exact-method-path-match": 0.95,
  "path-only-match": 0.75,
  "template-compatible-match": 0.9,
  "static-path-to-template-match": 0.9,
  "wildcard-path-match": 0.8,
  "exact-grpc-match": 0.95,
  "exact-graphql-match": 0.95,
  "probable-regex-route": 0.85,
  "probable-grpc-package-unspecified": 0.9,
  "probable-grpc-package-mismatch": 0.8,
  "exact-dubbo-match": 0.95,
  "probable-dubbo-group-version-unspecified": 0.9,
  "probable-dubbo-group-version-mismatch": 0.8
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
