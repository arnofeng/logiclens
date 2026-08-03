import type { ContractSpecNode, SemanticRelationEdge, SemanticRelationKind } from "../../parsing/types.js";
import type { SpecRoleMap } from "./types.js";
import { confidenceFor } from "../../../shared/confidence.js";
import type { HttpEndpointSpec, SchemaSpec } from "../spec.js";

type LegacyJavaSchemaIndex = Map<string, ContractSpecNode[]>;

function buildLegacyJavaSchemaIndex(specs: ContractSpecNode[]): LegacyJavaSchemaIndex {
  const index: LegacyJavaSchemaIndex = new Map();
  for (const spec of specs) {
    if (spec.specKind !== "schema") continue;
    const parsed = safeJsonParse<SchemaSpec>(spec.specJson);
    if (parsed?.languageId !== "java" || !parsed.displayName) continue;
    const key = parsed.displayName.toLowerCase();
    index.set(key, [...index.get(key) ?? [], spec]);
  }
  return index;
}

function lookupLegacyJavaSchemaId(
  index: LegacyJavaSchemaIndex,
  name: string,
  fromSpec?: ContractSpecNode
): string | undefined {
  const candidates = index.get(name.toLowerCase()) ?? [];
  const exact = candidates.filter((spec) => safeJsonParse<SchemaSpec>(spec.specJson)?.displayName === name);
  const pool = exact.length > 0 ? exact : candidates;
  const sameRepo = fromSpec ? pool.filter((spec) => spec.repoId === fromSpec.repoId) : [];
  const selected = sameRepo.length > 0 ? sameRepo : pool;
  return selected.length === 1 ? selected[0]!.id : undefined;
}

function resolveLegacyJavaHttpRelations(
  specs: ContractSpecNode[],
  index: LegacyJavaSchemaIndex
): SemanticRelationEdge[] {
  const edges: SemanticRelationEdge[] = [];
  const seen = new Set<string>();
  for (const spec of specs) {
    if (spec.specKind !== "http-endpoint") continue;
    const http = safeJsonParse<HttpEndpointSpec>(spec.specJson);
    if (!http) continue;
    for (const input of [
      http.requestBodyType ? { name: http.requestBodyType, kind: "REQUEST_SCHEMA" as const, reason: `@RequestBody type ${http.requestBodyType}`, confidence: confidenceFor("heuristic-request-body-type") } : undefined,
      http.responseBodyType ? { name: http.responseBodyType, kind: "RESPONSE_SCHEMA" as const, reason: `Response type ${http.responseBodyType}`, confidence: confidenceFor("heuristic-response-body-type") } : undefined
    ]) {
      if (!input) continue;
      const targetId = lookupLegacyJavaSchemaId(index, input.name, spec);
      if (!targetId) continue;
      const key = `${spec.id}\0${targetId}\0${input.kind}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({
        fromSpecId: spec.id,
        toSpecId: targetId,
        kind: input.kind,
        evidenceId: spec.evidenceId,
        reason: input.reason,
        confidence: input.confidence
      });
    }
  }
  return edges;
}

const LEGACY_JAVA_PENDING_KINDS = new Set<SemanticRelationKind>([
  "USES_SCHEMA"
]);

function resolveLegacyJavaPendingSchemaRefs(
  contractSpecs: ContractSpecNode[],
  existingRelations: SemanticRelationEdge[],
  index: LegacyJavaSchemaIndex
): SemanticRelationEdge[] {
  const edges: SemanticRelationEdge[] = [];
  const seen = new Set<string>();
  const specIds = new Set(contractSpecs.map((spec) => spec.id));
  const byContractId = new Map<string, string[]>();
  for (const spec of contractSpecs) byContractId.set(spec.contractId, [...byContractId.get(spec.contractId) ?? [], spec.id]);

  for (const relation of existingRelations) {
    if (!LEGACY_JAVA_PENDING_KINDS.has(relation.kind) || !relation.toSpecId.startsWith("schema-ref:")) continue;
    const pendingOwner = relation.fromSpecId.match(/^spec:(.+):pending$/u)?.[1];
    const ownerIds = specIds.has(relation.fromSpecId)
      ? [relation.fromSpecId]
      : pendingOwner ? byContractId.get(pendingOwner) ?? [] : [];
    const targetName = relation.toSpecId.slice("schema-ref:".length);
    for (const ownerId of ownerIds) {
      const owner = contractSpecs.find((spec) => spec.id === ownerId);
      const targetId = lookupLegacyJavaSchemaId(index, targetName, owner);
      if (!targetId || targetId === ownerId) continue;
      const key = `${ownerId}\0${targetId}\0${relation.kind}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ ...relation, fromSpecId: ownerId, toSpecId: targetId });
    }
  }
  return edges;
}

/**
 * Temporary pre-JS-008 bridge for the existing Java-only suffix/pending path.
 * Every non-Java typed relation is produced by the adapter reconciliation core.
 */
export function resolveSchemaRelations(
  allSpecs: ContractSpecNode[],
  _specRoles: SpecRoleMap,
  existingRelations: SemanticRelationEdge[]
): SemanticRelationEdge[] {
  const index = buildLegacyJavaSchemaIndex(allSpecs);
  if (index.size === 0) return [];
  return [
    ...resolveLegacyJavaHttpRelations(allSpecs, index),
    ...resolveLegacyJavaPendingSchemaRefs(allSpecs, existingRelations, index)
  ];
}

function safeJsonParse<T>(json: string): T | null {
  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}
