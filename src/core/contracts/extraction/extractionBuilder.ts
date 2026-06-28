// ---------------------------------------------------------------------------
// ExtractionBuilder — mutable FactCollector that produces ExtractedFacts.
//
// This is the sole FactCollector implementation.  Extractors write into it
// during Phase 1 and postExtract; build() deduplicates and returns a read-only
// ExtractedFacts view.  The caller can spread the result into a mutable
// CrossRepoExtraction for Phase 4.2 materialization if needed.
// TODO(Phase F): extract dedup-key helpers from here into dedup.ts (P2-7).
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

// TODO(Phase F): extract these dedup helpers into dedup.ts

function repoContractKey(e: RepoContractEdge): string {
  return `${e.repoId}:${e.contractId}:${e.role}:${e.evidenceId}`;
}

function contractEntityKey(e: ContractEntityEdge): string {
  return `${e.contractId}:${e.entityId}:${e.evidenceId}`;
}

function operationRepoKey(e: OperationRepoEdge): string {
  return `${e.repoId}:${e.operationId}:${e.role}:${e.evidenceId}`;
}

function packageUsageKey(e: PackageUsageEntry): string {
  return `${e.repoId}:${e.packageContractId}:${e.evidenceId}`;
}

function contractSpecEdgeKey(e: ContractSpecEdge): string {
  return `${e.contractId}:${e.specId}:${e.evidenceId}`;
}

function semanticRelationKey(e: SemanticRelationEdge): string {
  return `${e.fromSpecId}:${e.toSpecId}:${e.kind}:${e.evidenceId}`;
}

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
      repoContracts: dedupBy(this.repoContracts, repoContractKey),
      contractEntities: dedupBy(this.contractEntities, contractEntityKey),
      operationRepos: dedupBy(this.operationRepos, operationRepoKey),
      packageUsages: dedupBy(this.packageUsages, packageUsageKey),
      contractSpecs: dedupById(this.contractSpecs),
      contractSpecEdges: dedupBy(this.contractSpecEdges, contractSpecEdgeKey),
      semanticRelations: dedupBy(this.semanticRelations, semanticRelationKey),
    };
  }
}

// -- Shared dedup helpers ----------------------------------------------------

function dedupById<T extends { id: string }>(items: T[]): T[] {
  return [...new Map(items.map((item) => [item.id, item])).values()];
}

function dedupBy<T>(items: T[], keyFn: (item: T) => string): T[] {
  return [...new Map(items.map((item) => [keyFn(item), item])).values()];
}
