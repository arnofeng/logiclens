import type { ContractSpecNode, SemanticRelationEdge } from "../../parsing/types.js";
import type { SpecRoleMap } from "./types.js";
import { confidenceFor } from "../../../shared/confidence.js";
import { deserializeSpec } from "../spec.js";
import type { HttpEndpointSpec, EventSpec, SchemaSpec } from "../spec.js";

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
function resolvePendingUsesSchema(
  contractSpecs: ContractSpecNode[],
  existingRelations: SemanticRelationEdge[],
  schemaIndex: Map<string, string>
): SemanticRelationEdge[] {
  const edges: SemanticRelationEdge[] = [];
  const seen = new Set<string>();

  // Build lookup: contractId → specId (for resolving the `fromSpecId` side)
  const contractIdToSpecId = new Map<string, string>();
  for (const spec of contractSpecs) {
    if (!contractIdToSpecId.has(spec.contractId)) {
      contractIdToSpecId.set(spec.contractId, spec.id);
    }
  }

  for (const rel of existingRelations) {
    if (rel.kind !== "USES_SCHEMA") continue;
    if (!rel.toSpecId.startsWith("schema-ref:")) continue;

    // Resolve fromSpecId: extract contractId from `spec:<contractId>:pending`
    const fromMatch = rel.fromSpecId.match(/^spec:(.+):pending$/);
    if (!fromMatch) continue;
    const fromContractId = fromMatch[1]!;
    const resolvedFromSpecId = contractIdToSpecId.get(fromContractId);
    if (!resolvedFromSpecId) continue;

    // Resolve toSpecId: strip `schema-ref:` prefix, look up schema name
    const baseTypeName = rel.toSpecId.slice("schema-ref:".length).toLowerCase();
    const resolvedToSpecId = schemaIndex.get(baseTypeName);
    if (!resolvedToSpecId) continue;

    // Skip self-references
    if (resolvedFromSpecId === resolvedToSpecId) continue;

    const key = `${resolvedFromSpecId}:${resolvedToSpecId}:USES_SCHEMA`;
    if (!seen.has(key)) {
      seen.add(key);
      edges.push({
        fromSpecId: resolvedFromSpecId,
        toSpecId: resolvedToSpecId,
        kind: "USES_SCHEMA",
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
    ...resolveEventPayloadRelations(allSpecs, schemaIndex),
    ...resolvePendingUsesSchema(allSpecs, existingRelations, schemaIndex)
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
