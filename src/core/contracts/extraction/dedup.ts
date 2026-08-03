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
  return JSON.stringify([e.fromSpecId, e.toSpecId, e.kind]);
}

/**
 * Selects the deterministic display/provenance attributes for one logical
 * relation. Evidence remains an attribute of the selected edge; it is never
 * part of the logical identity.
 */
export function preferredSemanticRelation(
  left: SemanticRelationEdge,
  right: SemanticRelationEdge
): SemanticRelationEdge {
  const activeDifference = Number(right.active !== false) - Number(left.active !== false);
  if (activeDifference !== 0) return activeDifference > 0 ? right : left;
  if (left.confidence !== right.confidence) return left.confidence > right.confidence ? left : right;
  const evidenceOrder = left.evidenceId.localeCompare(right.evidenceId);
  if (evidenceOrder !== 0) return evidenceOrder < 0 ? left : right;
  const reasonOrder = left.reason.localeCompare(right.reason);
  if (reasonOrder !== 0) return reasonOrder < 0 ? left : right;
  return (left.batchId ?? "").localeCompare(right.batchId ?? "") <= 0 ? left : right;
}

export function collapseSemanticRelations(
  items: readonly SemanticRelationEdge[]
): SemanticRelationEdge[] {
  const relations = new Map<string, SemanticRelationEdge>();
  for (const item of items) {
    const key = semanticRelationDedupKey(item);
    const current = relations.get(key);
    relations.set(key, current ? preferredSemanticRelation(current, item) : item);
  }
  return [...relations.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, relation]) => relation);
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
