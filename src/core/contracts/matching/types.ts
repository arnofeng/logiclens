import type { ContractRole, ContractSpecNode, SemanticRelationEdge } from "../../parsing/types.js";

/**
 * Maps a ContractSpec to its role (producer/consumer/owner/shared).
 * Key: `${contractId}:${repoId}` — reflects the fact that the same contract
 * can play different roles in different repos.
 */
export type SpecRoleMap = Map<string, ContractRole>;

/** Context provided to each domain resolver. */
export interface ResolutionContext {
  /** All ContractSpec nodes from all extractors + postExtract. */
  specs: ContractSpecNode[];
  /** Role lookup keyed by `${contractId}:${repoId}`. */
  specRoles: SpecRoleMap;
  /**
   * Semantic relations already produced by extractors (e.g. pending
   * USES_SCHEMA edges with placeholder IDs).  The schema resolver reads
   * these to resolve `schema-ref:` references.
   */
  existingRelations: SemanticRelationEdge[];
}

/**
 * Internal match result returned by domain resolvers before being
 * converted to a SemanticRelationEdge.
 */
export interface MatchResult {
  fromSpecId: string;
  toSpecId: string;
  kind: SemanticRelationEdge["kind"];
  reason: string;
  confidence: number;
}
