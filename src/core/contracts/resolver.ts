import type { ContractSpecNode, RepoContractEdge, SemanticRelationEdge, ContractRole } from "../parsing/types.js";
import type { SpecRoleMap } from "./matching/types.js";
import { resolveHttpRelations } from "./matching/httpResolver.js";
import { resolveEventRelations } from "./matching/eventResolver.js";
import { resolveSchemaRelations } from "./matching/schemaResolver.js";
import { resolveGrpcRelations } from "./matching/grpcResolver.js";
import { resolveDubboRelations } from "./matching/dubboResolver.js";
import { resolveGraphqlRelations } from "./matching/graphqlResolver.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ResolveSemanticRelationsInput {
  /** All ContractSpec nodes from extractors + postExtract. */
  contractSpecs: ContractSpecNode[];
  /** Repo→Contract role edges (producer/consumer/owner/shared). */
  repoContracts: RepoContractEdge[];
  /**
   * Semantic relations already produced by extractors (e.g. pending
   * USES_SCHEMA edges with placeholder IDs). The schema resolver reads
   * these to resolve `schema-ref:` references.
   */
  existingSemanticRelations: SemanticRelationEdge[];
}

/**
 * Resolves semantic relations across all ContractSpecs.
 *
 * This is the language-independent resolver that runs after all extractors
 * finish. It produces SEMANTIC_REL edges for:
 *   - HTTP endpoint matching    (CALLS_ENDPOINT)
 *   - Event topic matching      (PUBLISHES_EVENT / SUBSCRIBES_EVENT)
 *   - Schema associations       (REQUEST_SCHEMA / RESPONSE_SCHEMA / EVENT_PAYLOAD / USES_SCHEMA)
 *
 * The resulting edges flow through the existing dual-track pipeline alongside
 * DEPENDS_ON edges. Phase 4.2 will use these to replace the coarse
 * contractId-based pairing in buildRepoDependenciesFromParticipants.
 */
export function resolveSemanticRelations(
  input: ResolveSemanticRelationsInput
): SemanticRelationEdge[] {
  const { contractSpecs, repoContracts, existingSemanticRelations } = input;

  if (contractSpecs.length === 0) return [];

  // Build role map: keyed by `${contractId}:${repoId}`
  const specRoles = buildSpecRoleMap(contractSpecs, repoContracts);

  // Run each domain resolver
  const httpEdges = resolveHttpRelations(contractSpecs, specRoles);
  const eventEdges = resolveEventRelations(contractSpecs, specRoles);
  const schemaEdges = resolveSchemaRelations(contractSpecs, specRoles, existingSemanticRelations);
  const grpcEdges = resolveGrpcRelations(contractSpecs, specRoles);
  const dubboEdges = resolveDubboRelations(contractSpecs, specRoles);
  const graphqlEdges = resolveGraphqlRelations(contractSpecs, specRoles);

  // Merge and deduplicate
  const allEdges = [...httpEdges, ...eventEdges, ...schemaEdges, ...grpcEdges, ...dubboEdges, ...graphqlEdges];
  return deduplicateEdges(allEdges);
}

// ---------------------------------------------------------------------------
// Role map construction
// ---------------------------------------------------------------------------

function buildSpecRoleMap(
  contractSpecs: ContractSpecNode[],
  repoContracts: RepoContractEdge[]
): SpecRoleMap {
  const map: SpecRoleMap = new Map();

  // Index repo contracts by contractId for fast lookup
  const byContractId = new Map<string, RepoContractEdge[]>();
  for (const edge of repoContracts) {
    const list = byContractId.get(edge.contractId);
    if (list) {
      list.push(edge);
    } else {
      byContractId.set(edge.contractId, [edge]);
    }
  }

  for (const spec of contractSpecs) {
    // Look up role by matching (contractId, repoId)
    const candidates = byContractId.get(spec.contractId) ?? [];
    const match = candidates.find((e) => e.repoId === spec.repoId);
    const role: ContractRole = match?.role ?? "shared";
    map.set(`${spec.contractId}:${spec.repoId}`, role);
  }

  return map;
}

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

function deduplicateEdges(edges: SemanticRelationEdge[]): SemanticRelationEdge[] {
  const seen = new Set<string>();
  const result: SemanticRelationEdge[] = [];
  for (const edge of edges) {
    const key = `${edge.fromSpecId}:${edge.toSpecId}:${edge.kind}:${edge.evidenceId}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(edge);
    }
  }
  return result;
}
