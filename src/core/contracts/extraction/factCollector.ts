// ---------------------------------------------------------------------------
// FactCollector — write-only interface for extractors to emit contract facts.
//
// Extractor implementations depend on this interface instead of the mutable
// CrossRepoExtraction aggregate.  The ExtractionBuilder (internal) implements
// this interface and deduplicates results into ExtractedFacts on build().
//
// NOTE: addWorkflow / addWorkflowOperation / addRepoDependency are deliberately
// absent — those are populated by Phase 4.2 dependency materialization, not
// by extractors.
// ---------------------------------------------------------------------------

import type {
  ContractNode,
  EvidenceNode,
  EntityNode,
  OperationNode,
  RepoContractEdge,
  ContractEntityEdge,
  OperationRepoEdge,
  ContractSpecNode,
  ContractSpecEdge,
  SemanticRelationEdge
} from "../../parsing/types.js";

export interface PackageUsageEntry {
  repoId: string;
  packageContractId: string;
  packageName: string;
  evidenceId: string;
  raw: string;
  confidence: number;
}

/**
 * Write-only collector that extractors push facts into.
 * ExtractionBuilder (the sole implementation) deduplicates and returns a
 * read-only ExtractedFacts view on build().
 */
export interface FactCollector {
  addContract(node: ContractNode): void;
  addEvidence(node: EvidenceNode): void;
  addEntity(node: EntityNode): void;
  addOperation(node: OperationNode): void;
  addRepoContract(edge: RepoContractEdge): void;
  addContractEntity(edge: ContractEntityEdge): void;
  addOperationRepo(edge: OperationRepoEdge): void;
  addPackageUsage(entry: PackageUsageEntry): void;
  addContractSpec(node: ContractSpecNode): void;
  addContractSpecEdge(edge: ContractSpecEdge): void;
  addSemanticRelation(edge: SemanticRelationEdge): void;
}
