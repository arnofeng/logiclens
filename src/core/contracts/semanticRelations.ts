// ---------------------------------------------------------------------------
// Semantic relation metadata — centralized definition of properties for each
// SemanticRelationKind.  All usage sites (dependency materialization, impact
// analysis traversal) query this table instead of maintaining their own
// hard-coded switch / Set branches.
//
// Adding a new SemanticRelationKind only requires adding one entry here.
// ---------------------------------------------------------------------------

import type {
  SemanticRelationEdge,
  SemanticRelationKind,
  RepoDependencyEdge
} from "../parsing/types.js";
import { confidenceBand, type ConfidenceBand } from "../../shared/confidence.js";

export interface SemanticRelMeta {
  /**
   * Dependency type when materialized as a RepoDependencyEdge.
   * `null` means this kind is intra-spec and should NOT produce a
   * cross-repo dependency edge.
   */
  dependencyType: RepoDependencyEdge["dependencyType"] | null;

  /**
   * Dependency direction:
   *   "forward"  — fromSpec = consumer, toSpec = producer (e.g. CALLS_HTTP)
   *   "reverse"  — fromSpec = producer, toSpec = consumer (e.g. PUBLISHES_EVENT)
   */
  direction: "forward" | "reverse";

  /**
   * Relationship category for impact-analysis graph traversal:
   *   "consumer-to-producer" — cross-repo consumption relationship
   *   "schema-to-use"        — schema used by endpoint / event / other schema
   *   "intra-spec"           — pure intra-spec association (no cross-repo dep)
   */
  category: "consumer-to-producer" | "schema-to-use" | "execution-flow" | "intra-spec";
}

/**
 * Canonical metadata table for every SemanticRelationKind.
 *
 * IMPORTANT: when adding a new kind, add one entry here and the derived sets
 * below (CONSUMER_TO_PRODUCER_KINDS / SCHEMA_TO_USE_KINDS) update
 * automatically.  No need to touch crossRepoContracts.ts or impactEngine.ts.
 */
export const SEMANTIC_REL_META: Record<SemanticRelationKind, SemanticRelMeta> = {
  CALLS_HTTP: {
    dependencyType: "api",
    direction: "forward",
    category: "consumer-to-producer",
  },
  CALLS_DUBBO: {
    dependencyType: "api",
    direction: "forward",
    category: "consumer-to-producer",
  },
  CALLS_GRPC: {
    dependencyType: "api",
    direction: "forward",
    category: "consumer-to-producer",
  },
  CALLS_GRAPHQL: {
    dependencyType: "api",
    direction: "forward",
    category: "consumer-to-producer",
  },
  INTERNAL_CALL: {
    dependencyType: null,
    direction: "forward",
    category: "execution-flow",
  },
  SUBSCRIBES_EVENT: {
    dependencyType: "event",
    direction: "forward",
    category: "consumer-to-producer",
  },
  PUBLISHES_EVENT: {
    dependencyType: "event",
    direction: "reverse",
    category: "consumer-to-producer",
  },
  USES_SCHEMA: {
    dependencyType: "shared-contract",
    direction: "forward",
    category: "schema-to-use",
  },
  REQUEST_SCHEMA: {
    dependencyType: null,
    direction: "forward",
    category: "schema-to-use",
  },
  RESPONSE_SCHEMA: {
    dependencyType: null,
    direction: "forward",
    category: "schema-to-use",
  },
  EVENT_PAYLOAD: {
    dependencyType: null,
    direction: "forward",
    category: "schema-to-use",
  },
  IMPLEMENTS: {
    dependencyType: null,
    direction: "forward",
    category: "intra-spec",
  },
  COMPATIBLE_WITH: {
    dependencyType: null,
    direction: "forward",
    category: "intra-spec",
  },
  BREAKS: {
    dependencyType: null,
    direction: "forward",
    category: "intra-spec",
  },
  IMPACTS: {
    dependencyType: null,
    direction: "forward",
    category: "intra-spec",
  },
};

// ---------------------------------------------------------------------------
// Derived sets (used by impact analysis graph traversal)
// These replace the hard-coded Sets in impactEngine.ts.
// ---------------------------------------------------------------------------

function deriveKinds(category: SemanticRelMeta["category"]): ReadonlySet<SemanticRelationKind> {
  return new Set(
    (Object.entries(SEMANTIC_REL_META) as [SemanticRelationKind, SemanticRelMeta][])
      .filter(([, meta]) => meta.category === category)
      .map(([kind]) => kind)
  );
}

/** Kinds that represent a consumer depending on a producer (cross-repo). */
export const CONSUMER_TO_PRODUCER_KINDS: ReadonlySet<SemanticRelationKind> =
  deriveKinds("consumer-to-producer");

/** Kinds that go from a schema to the endpoint/event/schema that uses it. */
export const SCHEMA_TO_USE_KINDS: ReadonlySet<SemanticRelationKind> =
  deriveKinds("schema-to-use");

export function semanticRelationResolution(edge: Pick<SemanticRelationEdge, "kind" | "reason" | "confidence">): ConfidenceBand {
  if (edge.kind === "INTERNAL_CALL") return "exact";
  if (edge.confidence < 0.8) return "heuristic";
  const reason = edge.reason.toLowerCase();
  if (/\b(unspecified|mismatch|compatible|wildcard|path-only|fallback|probable)\b/.test(reason)) {
    return "probable";
  }
  if (/\bexact\b/.test(reason) || edge.confidence >= 0.95) return "exact";
  return confidenceBand(edge.confidence);
}

export function selectImpactRootIds(matchedSpecIds: Set<string>, relations: SemanticRelationEdge[]): Set<string> {
  const roots = new Set<string>();
  for (const edge of relations) {
    if (!matchedSpecIds.has(edge.fromSpecId) || !matchedSpecIds.has(edge.toSpecId)) continue;
    const meta = SEMANTIC_REL_META[edge.kind];
    if (!meta || (meta.category !== "consumer-to-producer" && meta.category !== "schema-to-use")) continue;
    roots.add(meta.direction === "forward" ? edge.toSpecId : edge.fromSpecId);
  }
  return roots.size > 0 ? roots : matchedSpecIds;
}
