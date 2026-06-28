// ---------------------------------------------------------------------------
// ExtractionBuilder — mutable FactCollector that produces ExtractedFacts.
//
// This is the sole FactCollector implementation.  Extractors write into it
// during Phase 1 and postExtract; build() deduplicates and returns a read-only
// ExtractedFacts view.  The caller can spread the result into a mutable
// CrossRepoExtraction for Phase 4.2 materialization if needed.
//
// Dedup-key helpers live in dedup.ts (P2-7).
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
import type { FactCollector, PackageUsageEntry } from "./factCollector.js";
import type { ExtractedFacts } from "./contracts.js";
import {
  dedupById,
  dedupBy,
  repoContractDedupKey,
  contractEntityDedupKey,
  operationRepoDedupKey,
  packageUsageDedupKey,
  contractSpecEdgeDedupKey,
  semanticRelationDedupKey
} from "./dedup.js";

export class ExtractionBuilder implements FactCollector {
  private contracts: ContractNode[] = [];
  private evidence: EvidenceNode[] = [];
  private entities: EntityNode[] = [];
  private operations: OperationNode[] = [];
  private repoContracts: RepoContractEdge[] = [];
  private contractEntities: ContractEntityEdge[] = [];
  private operationRepos: OperationRepoEdge[] = [];
  private packageUsages: PackageUsageEntry[] = [];
  private contractSpecs: ContractSpecNode[] = [];
  private contractSpecEdges: ContractSpecEdge[] = [];
  private semanticRelations: SemanticRelationEdge[] = [];

  // -- FactCollector implementation ------------------------------------------

  addContract(node: ContractNode): void { this.contracts.push(node); }
  addEvidence(node: EvidenceNode): void { this.evidence.push(node); }
  addEntity(node: EntityNode): void { this.entities.push(node); }
  addOperation(node: OperationNode): void { this.operations.push(node); }

  addRepoContract(edge: RepoContractEdge): void { this.repoContracts.push(edge); }
  addContractEntity(edge: ContractEntityEdge): void { this.contractEntities.push(edge); }
  addOperationRepo(edge: OperationRepoEdge): void { this.operationRepos.push(edge); }
  addPackageUsage(entry: PackageUsageEntry): void { this.packageUsages.push(entry); }
  addContractSpec(node: ContractSpecNode): void { this.contractSpecs.push(node); }
  addContractSpecEdge(edge: ContractSpecEdge): void { this.contractSpecEdges.push(edge); }
  addSemanticRelation(edge: SemanticRelationEdge): void { this.semanticRelations.push(edge); }

  // -- Deduplicate + return read-only view -----------------------------------

  /** Deduplicate and return a read-only ExtractedFacts view. */
  build(): ExtractedFacts {
    return {
      contracts: dedupById(this.contracts),
      evidence: dedupById(this.evidence),
      entities: dedupById(this.entities),
      operations: dedupById(this.operations),
      repoContracts: dedupBy(this.repoContracts, repoContractDedupKey),
      contractEntities: dedupBy(this.contractEntities, contractEntityDedupKey),
      operationRepos: dedupBy(this.operationRepos, operationRepoDedupKey),
      packageUsages: dedupBy(this.packageUsages, packageUsageDedupKey),
      contractSpecs: dedupById(this.contractSpecs),
      contractSpecEdges: dedupBy(this.contractSpecEdges, contractSpecEdgeDedupKey),
      semanticRelations: dedupBy(this.semanticRelations, semanticRelationDedupKey),
    };
  }
}
