// ---------------------------------------------------------------------------
// Semantic relation metadata — centralized definition of properties for each
// SemanticRelationKind.  All usage sites (dependency materialization, impact
// analysis traversal) query this table instead of maintaining their own
// hard-coded switch / Set branches.
//
// Adding a new SemanticRelationKind only requires adding one entry here.
// ---------------------------------------------------------------------------

import type {
  SemanticRelationKind,
  RepoDependencyEdge
} from "../parsing/types.js";

export interface SemanticRelMeta {
  /**
   * Dependency type when materialized as a RepoDependencyEdge.
   * `null` means this kind is intra-spec and should NOT produce a
   * cross-repo dependency edge.
   */
  dependencyType: RepoDependencyEdge["dependencyType"] | null;

  /**
   * Dependency direction:
   *   "forward"  — fromSpec = consumer, toSpec = producer (e.g. CALLS_ENDPOINT)
   *   "reverse"  — fromSpec = producer, toSpec = consumer (e.g. PUBLISHES_EVENT)
   */
  direction: "forward" | "reverse";

  /**
   * Relationship category for impact-analysis graph traversal:
   *   "consumer-to-producer" — cross-repo consumption relationship
   *   "schema-to-use"        — schema used by endpoint / event / other schema
   *   "intra-spec"           — pure intra-spec association (no cross-repo dep)
   */
  category: "consumer-to-producer" | "schema-to-use" | "intra-spec";
}

/**
 * Canonical metadata table for every SemanticRelationKind.
 *
 * IMPORTANT: when adding a new kind, add one entry here and the derived sets
 * below (CONSUMER_TO_PRODUCER_KINDS / SCHEMA_TO_USE_KINDS) update
 * automatically.  No need to touch crossRepoContracts.ts or impactEngine.ts.
 */
export const SEMANTIC_REL_META: Record<SemanticRelationKind, SemanticRelMeta> = {
  CALLS_ENDPOINT: {
    dependencyType: "api",
    direction: "forward",
    category: "consumer-to-producer",
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
