// ---------------------------------------------------------------------------
// Immutable contract-facts value objects.
//
// ExtractedFacts  — frozen read-only view after Phase 1 extract + postExtract.
//                   Also serves as PostExtractContext.mergedFacts.
// MaterializedContracts — Phase 4.2 output with cross-repo dependencies and
//                         workflows materialized.
// ---------------------------------------------------------------------------

import type {
  ContractNode,
  EvidenceNode,
  EntityNode,
  OperationNode,
  RepoContractEdge,
  RepoDependencyEdge,
  ContractEntityEdge,
  OperationRepoEdge,
  WorkflowOperationEdge,
  ContractSpecNode,
  ContractSpecEdge,
  SemanticRelationEdge,
  WorkflowNode
} from "../../parsing/types.js";
import type { PackageUsageEntry } from "./factCollector.js";

/**
 * Frozen read-only facts produced by extraction (Phase 1 + postExtract).
 */
export interface ExtractedFacts {
  readonly contracts: readonly ContractNode[];
  readonly evidence: readonly EvidenceNode[];
  readonly entities: readonly EntityNode[];
  readonly repoContracts: readonly RepoContractEdge[];
  readonly contractEntities: readonly ContractEntityEdge[];
  readonly operations: readonly OperationNode[];
  readonly operationRepos: readonly OperationRepoEdge[];
  readonly packageUsages: readonly PackageUsageEntry[];
  readonly contractSpecs: readonly ContractSpecNode[];
  readonly contractSpecEdges: readonly ContractSpecEdge[];
  readonly semanticRelations: readonly SemanticRelationEdge[];
}

/**
 * Full output after Phase 4.2 dependency materialization.
 */
export interface MaterializedContracts extends ExtractedFacts {
  readonly repoDependencies: readonly RepoDependencyEdge[];
  readonly workflows: readonly WorkflowNode[];
  readonly workflowOperations: readonly WorkflowOperationEdge[];
}
