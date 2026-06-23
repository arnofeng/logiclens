import type {
  ContractEntityEdge,
  ContractKind,
  ContractNode,
  ContractRole,
  EntityNode,
  EvidenceNode,
  OperationNode,
  OperationRepoEdge,
  ParsedGraphFile,
  RepoContractEdge,
  RepoDependencyEdge,
  RepoNode,
  WorkflowNode,
  WorkflowOperationEdge
} from "../parsers/types.js";
import { contractExtractorRegistry } from "../plugins/registry.js";
import type { ExtractContext, PostExtractContext } from "../plugins/types.js";
import { normalizeName } from "../utils/path.js";
import { builtinContractExtractors } from "./builtin/index.js";
import type { LogicLensConfig } from "../config/schema.js";
import { loadConfig, defaultConfig } from "../config/loadConfig.js";
import { detectFrameworks, isExtractorEnabled } from "../frameworks/detect.js";
import type { DetectedFramework } from "../frameworks/types.js";
import {
  canonicalContractKey as canonicalBuiltinContractKey,
  createCrossRepoExtraction,
  toBusinessEntityName,
  toFactBundle as crossRepoToFactBundle,
  uniqueById
} from "./builtin/shared.js";

export type ExtractedRelation =
  | ({ kind: "repo-contract" } & RepoContractEdge)
  | ({ kind: "repo-dependency" } & RepoDependencyEdge)
  | ({ kind: "package-usage" } & CrossRepoExtraction["packageUsages"][number])
  | ({ kind: "contract-entity" } & ContractEntityEdge)
  | ({ kind: "operation-repo" } & OperationRepoEdge)
  | ({ kind: "workflow-operation" } & WorkflowOperationEdge);

export type ExtractorFactBundle = {
  contracts: ContractNode[];
  evidence: EvidenceNode[];
  entities: EntityNode[];
  operations: OperationNode[];
  workflows: WorkflowNode[];
  relations: ExtractedRelation[];
};

export type CrossRepoExtraction = {
  contracts: ContractNode[];
  evidence: EvidenceNode[];
  entities: EntityNode[];
  repoContracts: RepoContractEdge[];
  repoDependencies: RepoDependencyEdge[];
  contractEntities: ContractEntityEdge[];
  operations: OperationNode[];
  workflows: WorkflowNode[];
  operationRepos: OperationRepoEdge[];
  workflowOperations: WorkflowOperationEdge[];
  packageUsages: {
    repoId: string;
    packageContractId: string;
    packageName: string;
    evidenceId: string;
    raw: string;
    confidence: number;
  }[];
};

export type ContractParticipant = RepoContractEdge & {
  contract: ContractNode;
  evidence: EvidenceNode;
};

export type AliasOverride = {
  alias: string;
  targetRepoId: string;
};

export function canonicalContractKey(kind: ContractKind, value: string): string {
  return canonicalBuiltinContractKey(kind, value);
}

export function dependencyEntries(packageJson: {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
} | undefined): [string, string][] {
  if (!packageJson) return [];
  return [
    ...Object.entries(packageJson.dependencies ?? {}),
    ...Object.entries(packageJson.devDependencies ?? {}),
    ...Object.entries(packageJson.peerDependencies ?? {})
  ];
}

export async function extractRepoContractFacts(
  repos: RepoNode[],
  parsedFiles: ParsedGraphFile[],
  options: { aliasOverrides?: AliasOverride[] } = {}
): Promise<Omit<CrossRepoExtraction, "repoDependencies">> {
  const result = createCrossRepoExtraction();
  const context: ExtractContext = {
    repos,
    parsedFiles,
    repoResolver: (repoId) => repos.find((repo) => repo.id === repoId),
    aliasOverrides: options.aliasOverrides
  };
  for (const extractor of builtinContractExtractors) {
    mergeFactBundle(result, await extractor.extract(context));
  }
  const facts = uniqueCrossRepoFacts(result);
  return {
    contracts: facts.contracts,
    evidence: facts.evidence,
    entities: facts.entities,
    contractEntities: facts.contractEntities,
    operations: facts.operations,
    workflows: [],
    operationRepos: facts.operationRepos,
    workflowOperations: [],
    repoContracts: facts.repoContracts,
    packageUsages: facts.packageUsages
  };
}

export function buildRepoDependenciesFromParticipants(participants: ContractParticipant[], targetRepoIds?: Set<string>): RepoDependencyEdge[] {
  const result: RepoDependencyEdge[] = [];
  const byContractId = new Map<string, ContractParticipant[]>();
  for (const participant of participants) {
    const list = byContractId.get(participant.contractId) ?? [];
    list.push(participant);
    byContractId.set(participant.contractId, list);
  }

  const push = (edge: RepoDependencyEdge): void => {
    if (edge.fromRepoId === edge.toRepoId) return;
    if (targetRepoIds && !targetRepoIds.has(edge.fromRepoId) && !targetRepoIds.has(edge.toRepoId)) return;
    result.push(edge);
  };

  for (const [contractId, contractParticipants] of byContractId) {
    const contractNode = contractParticipants[0]?.contract;
    if (!contractNode) continue;
    const producers = contractParticipants.filter((edge) => edge.role === "producer" || edge.role === "owner" || edge.role === "shared");
    const consumers = contractParticipants.filter((edge) => edge.role === "consumer" || edge.role === "shared");
    for (const consumer of consumers) {
      for (const producer of producers) {
        if (consumer.repoId === producer.repoId) continue;
        const evidenceNode = consumer.evidence ?? producer.evidence;
        const dependencyType: RepoDependencyEdge["dependencyType"] = contractNode.kind === "api"
          ? "api"
          : contractNode.kind === "event"
            ? "event"
            : contractNode.kind === "package"
              ? consumer.evidence.rule === "import-specifier-package-owner" ? "import" : "package"
              : "shared-contract";
        push({
          fromRepoId: consumer.repoId,
          toRepoId: producer.repoId,
          dependencyType,
          sourceContractId: contractId,
          targetContractId: contractId,
          evidenceId: evidenceNode.id,
          raw: evidenceNode.raw,
          confidence: evidenceNode.confidence
        });
      }
    }
  }

  return [...new Map(result.map((edge) => [`${edge.fromRepoId}:${edge.toRepoId}:${edge.dependencyType}:${edge.evidenceId}`, edge])).values()];
}

export async function extractCrossRepoContracts(
  repos: RepoNode[],
  parsedFiles: ParsedGraphFile[],
  options: { aliasOverrides?: AliasOverride[]; config?: LogicLensConfig } = {}
): Promise<CrossRepoExtraction> {
  registerBuiltinContractExtractors();
  let config = options.config;
  if (!config) {
    try {
      config = await loadConfig();
    } catch {
      config = defaultConfig();
    }
  }
  const facts = await extractContractFactsWithRegistry({
    repos,
    parsedFiles,
    repoResolver: (repoId) => repos.find((repo) => repo.id === repoId),
    aliasOverrides: options.aliasOverrides
  }, config);
  const contractsById = new Map(facts.contracts.map((contractNode) => [contractNode.id, contractNode]));
  const evidenceById = new Map(facts.evidence.map((evidenceNode) => [evidenceNode.id, evidenceNode]));
  const participants: ContractParticipant[] = facts.repoContracts.flatMap((edge) => {
    const contractNode = contractsById.get(edge.contractId);
    const evidenceNode = evidenceById.get(edge.evidenceId);
    return contractNode && evidenceNode ? [{ ...edge, contract: contractNode, evidence: evidenceNode }] : [];
  });
  const repoDependencies = buildRepoDependenciesFromParticipants(participants);
  const workflowMap = new Map<string, WorkflowNode>();
  const workflowOperations: WorkflowOperationEdge[] = [];
  for (const dependency of repoDependencies) {
    const contractNode = contractsById.get(dependency.sourceContractId);
    if (!contractNode || (contractNode.kind !== "api" && contractNode.kind !== "event")) continue;
    const entityName = toBusinessEntityName(contractNode);
    if (!entityName) continue;
    const workflowId = `workflow:${normalizeName(`${entityName}:${contractNode.kind}:${contractNode.key}`)}`;
    workflowMap.set(workflowId, {
      id: workflowId,
      name: `${entityName} ${contractNode.kind} flow`,
      description: `Cross-repo ${contractNode.kind} flow around ${contractNode.key}`
    });
    for (const operation of facts.operations.filter((item) => item.entityName === entityName && item.description.includes(contractNode.key))) {
      workflowOperations.push({
        workflowId,
        operationId: operation.id,
        step: operation.verb.includes("serve") || operation.verb.includes("publish") ? 1 : 2,
        evidenceId: dependency.evidenceId,
        confidence: dependency.confidence
      });
    }
  }

  return {
    ...facts,
    repoDependencies,
    workflows: [...workflowMap.values()],
    workflowOperations: [...new Map(workflowOperations.map((edge) => [`${edge.workflowId}:${edge.operationId}:${edge.step}`, edge])).values()]
  };
}

export async function extractCrossRepoFactBundle(
  repos: RepoNode[],
  parsedFiles: ParsedGraphFile[],
  options: { aliasOverrides?: AliasOverride[] } = {}
): Promise<ExtractorFactBundle> {
  return crossRepoToFactBundle(await extractCrossRepoContracts(repos, parsedFiles, options));
}

function mergeFactBundle(target: CrossRepoExtraction, bundle: ExtractorFactBundle): void {
  target.contracts.push(...bundle.contracts);
  target.evidence.push(...bundle.evidence);
  target.entities.push(...bundle.entities);
  target.operations.push(...bundle.operations);
  target.workflows.push(...bundle.workflows);
  for (const relation of bundle.relations) {
    if (relation.kind === "repo-contract") {
      const { kind: _kind, ...edge } = relation;
      target.repoContracts.push(edge);
    } else if (relation.kind === "repo-dependency") {
      const { kind: _kind, ...edge } = relation;
      target.repoDependencies.push(edge);
    } else if (relation.kind === "package-usage") {
      const { kind: _kind, ...edge } = relation;
      target.packageUsages.push(edge);
    } else if (relation.kind === "contract-entity") {
      const { kind: _kind, ...edge } = relation;
      target.contractEntities.push(edge);
    } else if (relation.kind === "operation-repo") {
      const { kind: _kind, ...edge } = relation;
      target.operationRepos.push(edge);
    } else if (relation.kind === "workflow-operation") {
      const { kind: _kind, ...edge } = relation;
      target.workflowOperations.push(edge);
    }
  }
}

function uniqueCrossRepoFacts(result: CrossRepoExtraction): CrossRepoExtraction {
  return {
    contracts: uniqueById(result.contracts),
    evidence: uniqueById(result.evidence),
    entities: uniqueById(result.entities),
    repoContracts: [...new Map(result.repoContracts.map((edge) => [`${edge.repoId}:${edge.contractId}:${edge.role}:${edge.evidenceId}`, edge])).values()],
    repoDependencies: [...new Map(result.repoDependencies.map((edge) => [`${edge.fromRepoId}:${edge.toRepoId}:${edge.dependencyType}:${edge.evidenceId}`, edge])).values()],
    contractEntities: [...new Map(result.contractEntities.map((edge) => [`${edge.contractId}:${edge.entityId}:${edge.evidenceId}`, edge])).values()],
    operations: uniqueById(result.operations),
    workflows: uniqueById(result.workflows),
    operationRepos: [...new Map(result.operationRepos.map((edge) => [`${edge.repoId}:${edge.operationId}:${edge.role}:${edge.evidenceId}`, edge])).values()],
    workflowOperations: [...new Map(result.workflowOperations.map((edge) => [`${edge.workflowId}:${edge.operationId}:${edge.step}:${edge.evidenceId}`, edge])).values()],
    packageUsages: [...new Map(result.packageUsages.map((edge) => [`${edge.repoId}:${edge.packageContractId}:${edge.evidenceId}`, edge])).values()]
  };
}

export async function extractContractFactsWithRegistry(
  context: ExtractContext,
  config?: LogicLensConfig
): Promise<CrossRepoExtraction> {
  let resolvedConfig = config;
  if (!resolvedConfig) {
    try {
      resolvedConfig = await loadConfig();
    } catch {
      resolvedConfig = defaultConfig();
    }
  }

  // Pre-detect frameworks for all repos in the context
  const detectedFrameworksMap = new Map<string, DetectedFramework[]>();
  await Promise.all(context.repos.map(async (repo) => {
    const dfs = await detectFrameworks(repo, context.parsedFiles);
    detectedFrameworksMap.set(repo.id, dfs);
  }));

  const result = createCrossRepoExtraction();
  const postExtractContexts = new Map<string, Omit<PostExtractContext, "mergedFacts">>();
  for (const extractor of contractExtractorRegistry.extractors()) {
    const started = Date.now();

    // Filter repos for which this extractor is enabled
    const enabledRepos = context.repos.filter((repo) => {
      const dfs = detectedFrameworksMap.get(repo.id) ?? [];
      return isExtractorEnabled(extractor, dfs, resolvedConfig!);
    });

    if (enabledRepos.length === 0) {
      continue; // Skip this extractor entirely if not enabled for any repo
    }

    // Filter parsedFiles to only include files belonging to enabled repos
    const enabledRepoIds = new Set(enabledRepos.map((r) => r.id));
    const enabledParsedFiles = context.parsedFiles.filter((file) => enabledRepoIds.has(file.repoId));

    const repoResolver = (repoId: string) => {
      if (!enabledRepoIds.has(repoId)) return undefined;
      return context.repoResolver(repoId);
    };

    const filteredContext: ExtractContext = {
      repos: enabledRepos,
      parsedFiles: enabledParsedFiles,
      repoResolver,
      aliasOverrides: context.aliasOverrides
    };
    postExtractContexts.set(extractor.name, {
      repos: enabledRepos,
      parsedFiles: enabledParsedFiles
    });

    const bundle = await extractor.extract(filteredContext);
    mergeFactBundle(result, bundle);
    const relationCount = bundle.relations.length;
    if (process.env.NODE_ENV !== "test" && !process.env.VITEST) {
      process.stderr.write(`Extractor ${extractor.name}: ${Date.now() - started}ms contracts=${bundle.contracts.length} evidence=${bundle.evidence.length} relations=${relationCount}\n`);
    }
  }

  // P1-1: postExtract phase — cross-file finalization.
  // Build a read-only view of the merged facts and let every extractor that
  // implements postExtract() amend the result (e.g. Spring Controller prefix merging).
  const mergedForPost = uniqueCrossRepoFacts(result);
  const mergedFactBundle: ExtractorFactBundle = {
    contracts: mergedForPost.contracts,
    evidence: mergedForPost.evidence,
    entities: mergedForPost.entities,
    operations: mergedForPost.operations,
    workflows: mergedForPost.workflows,
    relations: [
      ...mergedForPost.repoContracts.map((e) => ({ kind: "repo-contract" as const, ...e })),
      ...mergedForPost.repoDependencies.map((e) => ({ kind: "repo-dependency" as const, ...e })),
      ...mergedForPost.packageUsages.map((e) => ({ kind: "package-usage" as const, ...e })),
      ...mergedForPost.contractEntities.map((e) => ({ kind: "contract-entity" as const, ...e })),
      ...mergedForPost.operationRepos.map((e) => ({ kind: "operation-repo" as const, ...e })),
      ...mergedForPost.workflowOperations.map((e) => ({ kind: "workflow-operation" as const, ...e }))
    ]
  };
  for (const extractor of contractExtractorRegistry.extractors()) {
    if (!extractor.postExtract) continue;
    const filteredContext = postExtractContexts.get(extractor.name);
    if (!filteredContext) continue;
    const postCtx: PostExtractContext = {
      mergedFacts: mergedFactBundle,
      repos: filteredContext.repos,
      parsedFiles: filteredContext.parsedFiles
    };
    const postBundle = await extractor.postExtract(postCtx);
    mergeFactBundle(result, postBundle);
  }

  return uniqueCrossRepoFacts(result);
}

let builtinContractExtractorsRegistered = false;

export function registerBuiltinContractExtractors(): void {
  if (builtinContractExtractorsRegistered) return;
  for (const extractor of builtinContractExtractors) {
    contractExtractorRegistry.register(extractor);
  }
  builtinContractExtractorsRegistered = true;
}

registerBuiltinContractExtractors();
