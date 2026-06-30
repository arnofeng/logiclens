import type { ContractSpecNode, SemanticRelationEdge, SemanticRelationKind } from "../../parsing/types.js";
import type { SpecRoleMap } from "./types.js";
import { confidenceFor } from "../../../shared/confidence.js";
import { deserializeSpec } from "../spec.js";
import type { HttpEndpointSpec, EventSpec, SchemaSpec, GrpcMethodSpec, GraphQLOperationSpec } from "../spec.js";

// ---------------------------------------------------------------------------
// Schema name → specId index
// ---------------------------------------------------------------------------

/**
 * Builds a case-insensitive lookup from schema name to ContractSpec ID.
 * Scans all schema-kind specs in the batch.
 */
function buildSchemaIndex(specs: ContractSpecNode[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const spec of specs) {
    if (spec.specKind !== "schema") continue;
    const parsed = safeJsonParse<SchemaSpec>(spec.specJson);
    if (parsed?.name) {
      index.set(parsed.name.toLowerCase(), spec.id);
    }
  }
  return index;
}

// ---------------------------------------------------------------------------
// HTTP → Schema relations (REQUEST_SCHEMA / RESPONSE_SCHEMA)
// ---------------------------------------------------------------------------

function resolveHttpSchemaRelations(
  allSpecs: ContractSpecNode[],
  schemaIndex: Map<string, string>
): SemanticRelationEdge[] {
  const edges: SemanticRelationEdge[] = [];
  const seen = new Set<string>();

  for (const spec of allSpecs) {
    if (spec.specKind !== "http-endpoint") continue;
    const httpSpec = safeJsonParse<HttpEndpointSpec>(spec.specJson);
    if (!httpSpec) continue;

    // REQUEST_SCHEMA
    if (httpSpec.requestBodyType) {
      const schemaId = schemaIndex.get(httpSpec.requestBodyType.toLowerCase());
      if (schemaId) {
        const key = `${spec.id}:${schemaId}:REQUEST_SCHEMA`;
        if (!seen.has(key)) {
          seen.add(key);
          edges.push({
            fromSpecId: spec.id,
            toSpecId: schemaId,
            kind: "REQUEST_SCHEMA",
            evidenceId: spec.evidenceId,
            reason: `@RequestBody type ${httpSpec.requestBodyType}`,
            confidence: confidenceFor("heuristic-request-body-type")
          });
        }
      }
    }

    // RESPONSE_SCHEMA
    if (httpSpec.responseBodyType) {
      const schemaId = schemaIndex.get(httpSpec.responseBodyType.toLowerCase());
      if (schemaId) {
        const key = `${spec.id}:${schemaId}:RESPONSE_SCHEMA`;
        if (!seen.has(key)) {
          seen.add(key);
          edges.push({
            fromSpecId: spec.id,
            toSpecId: schemaId,
            kind: "RESPONSE_SCHEMA",
            evidenceId: spec.evidenceId,
            reason: `Response type ${httpSpec.responseBodyType}`,
            confidence: confidenceFor("heuristic-response-body-type")
          });
        }
      }
    }
  }

  return edges;
}

// ---------------------------------------------------------------------------
// gRPC → Schema relations (REQUEST_SCHEMA / RESPONSE_SCHEMA)
// ---------------------------------------------------------------------------

function resolveGrpcSchemaRelations(
  allSpecs: ContractSpecNode[],
  schemaIndex: Map<string, string>
): SemanticRelationEdge[] {
  const edges: SemanticRelationEdge[] = [];
  const seen = new Set<string>();

  for (const spec of allSpecs) {
    if (spec.specKind !== "grpc-method") continue;
    const grpcSpec = safeJsonParse<GrpcMethodSpec>(spec.specJson);
    if (!grpcSpec) continue;

    // REQUEST_SCHEMA
    if (grpcSpec.requestType) {
      const lookupKey = grpcSpec.package && !grpcSpec.requestType.includes(".")
        ? `${grpcSpec.package}.${grpcSpec.requestType}`
        : grpcSpec.requestType;
      const schemaId = schemaIndex.get(lookupKey.toLowerCase());
      if (schemaId) {
        const key = `${spec.id}:${schemaId}:REQUEST_SCHEMA`;
        if (!seen.has(key)) {
          seen.add(key);
          edges.push({
            fromSpecId: spec.id,
            toSpecId: schemaId,
            kind: "REQUEST_SCHEMA",
            evidenceId: spec.evidenceId,
            reason: `RPC request type ${grpcSpec.requestType}`,
            confidence: 1.0
          });
        }
      }
    }

    // RESPONSE_SCHEMA
    if (grpcSpec.responseType) {
      const lookupKey = grpcSpec.package && !grpcSpec.responseType.includes(".")
        ? `${grpcSpec.package}.${grpcSpec.responseType}`
        : grpcSpec.responseType;
      const schemaId = schemaIndex.get(lookupKey.toLowerCase());
      if (schemaId) {
        const key = `${spec.id}:${schemaId}:RESPONSE_SCHEMA`;
        if (!seen.has(key)) {
          seen.add(key);
          edges.push({
            fromSpecId: spec.id,
            toSpecId: schemaId,
            kind: "RESPONSE_SCHEMA",
            evidenceId: spec.evidenceId,
            reason: `RPC response type ${grpcSpec.responseType}`,
            confidence: 1.0
          });
        }
      }
    }
  }

  return edges;
}

function resolveGraphqlSchemaRelations(
  allSpecs: ContractSpecNode[],
  schemaIndex: Map<string, string>
): SemanticRelationEdge[] {
  const edges: SemanticRelationEdge[] = [];
  const seen = new Set<string>();

  for (const spec of allSpecs) {
    if (spec.specKind !== "graphql-operation") continue;
    const gqlSpec = safeJsonParse<GraphQLOperationSpec>(spec.specJson);
    if (!gqlSpec) continue;

    // REQUEST_SCHEMA
    if (gqlSpec.requestType) {
      const schemaId = schemaIndex.get(gqlSpec.requestType.toLowerCase());
      if (schemaId) {
        const key = `${spec.id}:${schemaId}:REQUEST_SCHEMA`;
        if (!seen.has(key)) {
          seen.add(key);
          edges.push({
            fromSpecId: spec.id,
            toSpecId: schemaId,
            kind: "REQUEST_SCHEMA",
            evidenceId: spec.evidenceId,
            reason: `GraphQL request type ${gqlSpec.requestType}`,
            confidence: 1.0
          });
        }
      }
    }

    // RESPONSE_SCHEMA
    if (gqlSpec.responseType) {
      const schemaId = schemaIndex.get(gqlSpec.responseType.toLowerCase());
      if (schemaId) {
        const key = `${spec.id}:${schemaId}:RESPONSE_SCHEMA`;
        if (!seen.has(key)) {
          seen.add(key);
          edges.push({
            fromSpecId: spec.id,
            toSpecId: schemaId,
            kind: "RESPONSE_SCHEMA",
            evidenceId: spec.evidenceId,
            reason: `GraphQL response type ${gqlSpec.responseType}`,
            confidence: 1.0
          });
        }
      }
    }
  }

  return edges;
}

// ---------------------------------------------------------------------------
// Event → Schema relations (EVENT_PAYLOAD)
// ---------------------------------------------------------------------------

function resolveEventPayloadRelations(
  allSpecs: ContractSpecNode[],
  schemaIndex: Map<string, string>
): SemanticRelationEdge[] {
  const edges: SemanticRelationEdge[] = [];
  const seen = new Set<string>();

  for (const spec of allSpecs) {
    if (spec.specKind !== "event") continue;
    const eventSpec = safeJsonParse<EventSpec>(spec.specJson);
    if (!eventSpec?.payloadType) continue;

    const schemaId = schemaIndex.get(eventSpec.payloadType.toLowerCase());
    if (!schemaId) continue;

    const key = `${spec.id}:${schemaId}:EVENT_PAYLOAD`;
    if (!seen.has(key)) {
      seen.add(key);
      edges.push({
        fromSpecId: spec.id,
        toSpecId: schemaId,
        kind: "EVENT_PAYLOAD",
        evidenceId: spec.evidenceId,
        reason: `Event payload type ${eventSpec.payloadType}`,
        confidence: confidenceFor("heuristic-generic-type-param")
      });
    }
  }

  return edges;
}

// ---------------------------------------------------------------------------
// USES_SCHEMA — resolve pending `schema-ref:` references
// ---------------------------------------------------------------------------

/**
 * Resolves pending USES_SCHEMA edges that carry placeholder IDs:
 *   fromSpecId: `spec:<contractId>:pending`
 *   toSpecId:   `schema-ref:<TypeName>`
 *
 * The extractors (tsSchemaExtractor, javaSchemaExtractor) emit these during
 * extract() so that schema inheritance / utility-type wrapping is captured.
 * This function resolves them once all ContractSpecs are available.
 */
const PENDING_SCHEMA_REF_KINDS = new Set<SemanticRelationKind>([
  "USES_SCHEMA",
  "REQUEST_SCHEMA",
  "RESPONSE_SCHEMA",
  "EVENT_PAYLOAD"
]);

function resolvePendingSchemaRefs(
  contractSpecs: ContractSpecNode[],
  existingRelations: SemanticRelationEdge[],
  schemaIndex: Map<string, string>
): SemanticRelationEdge[] {
  const edges: SemanticRelationEdge[] = [];
  const seen = new Set<string>();

  // Build lookup: contractId → specId (for resolving the `fromSpecId` side)
  const specIds = new Set(contractSpecs.map((spec) => spec.id));
  const contractIdToSpecId = new Map<string, string>();
  for (const spec of contractSpecs) {
    if (!contractIdToSpecId.has(spec.contractId)) {
      contractIdToSpecId.set(spec.contractId, spec.id);
    }
  }

  for (const rel of existingRelations) {
    if (!PENDING_SCHEMA_REF_KINDS.has(rel.kind)) continue;
    if (!rel.toSpecId.startsWith("schema-ref:")) continue;

    let resolvedFromSpecId = specIds.has(rel.fromSpecId) ? rel.fromSpecId : undefined;
    if (!resolvedFromSpecId) {
      const fromMatch = rel.fromSpecId.match(/^spec:(.+):pending$/);
      if (!fromMatch) continue;
      const fromContractId = fromMatch[1]!;
      resolvedFromSpecId = contractIdToSpecId.get(fromContractId);
    }
    if (!resolvedFromSpecId) continue;

    // Resolve toSpecId: strip `schema-ref:` prefix, look up schema name
    const baseTypeName = rel.toSpecId.slice("schema-ref:".length).toLowerCase();
    const resolvedToSpecId = schemaIndex.get(baseTypeName);
    if (!resolvedToSpecId) continue;

    // Skip self-references
    if (resolvedFromSpecId === resolvedToSpecId) continue;

    const key = `${resolvedFromSpecId}:${resolvedToSpecId}:${rel.kind}`;
    if (!seen.has(key)) {
      seen.add(key);
      edges.push({
        fromSpecId: resolvedFromSpecId,
        toSpecId: resolvedToSpecId,
        kind: rel.kind,
        evidenceId: rel.evidenceId,
        reason: rel.reason,
        confidence: rel.confidence
      });
    }
  }

  return edges;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Resolves schema-level semantic relations:
 *   - REQUEST_SCHEMA  (http-endpoint → schema)
 *   - RESPONSE_SCHEMA (http-endpoint → schema)
 *   - EVENT_PAYLOAD   (event → schema)
 *   - USES_SCHEMA     (schema → schema, from pending extractor references)
 */
export function resolveSchemaRelations(
  allSpecs: ContractSpecNode[],
  _specRoles: SpecRoleMap,
  existingRelations: SemanticRelationEdge[]
): SemanticRelationEdge[] {
  const schemaIndex = buildSchemaIndex(allSpecs);
  if (schemaIndex.size === 0) return [];

  const edges: SemanticRelationEdge[] = [
    ...resolveHttpSchemaRelations(allSpecs, schemaIndex),
    ...resolveGrpcSchemaRelations(allSpecs, schemaIndex),
    ...resolveGraphqlSchemaRelations(allSpecs, schemaIndex),
    ...resolveEventPayloadRelations(allSpecs, schemaIndex),
    ...resolvePendingSchemaRefs(allSpecs, existingRelations, schemaIndex)
  ];

  return edges;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeJsonParse<T>(json: string): T | null {
  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}
