import type {
  RepoContractEdge,
  ContractEntityEdge,
  OperationRepoEdge,
  ContractSpecEdge,
  SemanticRelationEdge,
  RepoDependencyEdge,
  WorkflowOperationEdge
} from "../../parsing/types.js";
import type { PackageUsageEntry } from "./factCollector.js";

export function repoContractDedupKey(e: RepoContractEdge): string {
  return `${e.repoId}:${e.contractId}:${e.role}:${e.evidenceId}`;
}

export function contractEntityDedupKey(e: ContractEntityEdge): string {
  return `${e.contractId}:${e.entityId}:${e.evidenceId}`;
}

export function operationRepoDedupKey(e: OperationRepoEdge): string {
  return `${e.repoId}:${e.operationId}:${e.role}:${e.evidenceId}`;
}

export function packageUsageDedupKey(e: PackageUsageEntry): string {
  return `${e.repoId}:${e.packageContractId}:${e.evidenceId}`;
}

export function contractSpecEdgeDedupKey(e: ContractSpecEdge): string {
  return `${e.contractId}:${e.specId}:${e.evidenceId}`;
}

export function semanticRelationDedupKey(e: SemanticRelationEdge): string {
  return `${e.fromSpecId}:${e.toSpecId}:${e.kind}:${e.evidenceId}`;
}

export function materializedRepoDependencyDedupKey(e: RepoDependencyEdge): string {
  return `${e.fromRepoId}:${e.toRepoId}:${e.dependencyType}:${e.evidenceId}`;
}

export function materializedWorkflowOperationDedupKey(e: WorkflowOperationEdge): string {
  return `${e.workflowId}:${e.operationId}:${e.step}`;
}

export function dedupById<T extends { id: string }>(items: T[]): T[] {
  return [...new Map(items.map((item) => [item.id, item])).values()];
}

export function dedupBy<T>(items: T[], keyFn: (item: T) => string): T[] {
  return [...new Map(items.map((item) => [keyFn(item), item])).values()];
}
