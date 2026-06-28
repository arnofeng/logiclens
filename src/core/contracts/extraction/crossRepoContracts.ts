import type {
  ContractEntityEdge,
  ContractKind,
  ContractNode,
  ContractRole,
  ContractSpecEdge,
  ContractSpecNode,
  EntityNode,
  EvidenceNode,
  OperationNode,
  OperationRepoEdge,
  ParsedGraphFile,
  RepoContractEdge,
  RepoDependencyEdge,
  RepoNode,
  SemanticRelationEdge,
  WorkflowNode,
  WorkflowOperationEdge
} from "../../parsing/types.js";
import type { ContractExtractor, ExtractContext, PostExtractContext } from "../../registries/types.js";
import { normalizeName } from "../../../shared/path.js";
import { builtinContractExtractors } from "./builtin/index.js";
import {
  dedupBy,
  materializedRepoDependencyDedupKey,
  materializedWorkflowOperationDedupKey
} from "./dedup.js";
import type { LogicLensConfig } from "../../../config/schema.js";
import { loadConfig, defaultConfig } from "../../../config/loadConfig.js";
import { detectFrameworks, isExtractorEnabled } from "../../frameworks/detect.js";
import type { DetectedFramework } from "../../frameworks/types.js";
import {
  canonicalContractKey as canonicalBuiltinContractKey,
  toBusinessEntityName
} from "./builtin/shared.js";
import { mergeAndDedupeDeps } from "../depsMerge.js";
import { SEMANTIC_REL_META } from "../semanticRelations.js";
import { ExtractionBuilder } from "./extractionBuilder.js";
import type { FactCollector } from "./factCollector.js";
import type { ExtractedFacts } from "./contracts.js";

// -- Deprecated type aliases for backward test compatibility -------------------

/** @deprecated Use ExtractedFacts instead. */
export type ExtractorFactBundle = ExtractedFacts;

/** @deprecated Use specific edge arrays (repoContracts, etc.) instead. */
export type ExtractedRelation =
  | ({ kind: "repo-contract" } & RepoContractEdge)
  | ({ kind: "repo-dependency" } & RepoDependencyEdge)
  | ({ kind: "package-usage" } & CrossRepoExtraction["packageUsages"][number])
  | ({ kind: "contract-entity" } & ContractEntityEdge)
  | ({ kind: "operation-repo" } & OperationRepoEdge)
  | ({ kind: "workflow-operation" } & WorkflowOperationEdge);

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
  contractSpecs: ContractSpecNode[];
  contractSpecEdges: ContractSpecEdge[];
  semanticRelations: SemanticRelationEdge[];
};

export type ContractParticipant = RepoContractEdge & {
  contract: ContractNode;
  evidence: EvidenceNode;
};

export type AliasOverride = {
  alias: string;
  targetRepoId: string;
};

export function canonicalContractKey(kind: ContractKind, value: string, method?: string): string {
  return canonicalBuiltinContractKey(kind, value, method);
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
): Promise<ExtractedFacts> {
  const builder = new ExtractionBuilder();
  const context: ExtractContext = {
    repos,
    parsedFiles,
    repoResolver: (repoId) => repos.find((repo) => repo.id === repoId),
    aliasOverrides: options.aliasOverrides
  };
  for (const extractor of builtinContractExtractors) {
    await extractor.extract(context, builder);
  }
  return builder.build();
}

function hasHttpMethodPrefix(key: string): boolean {
  return /^[A-Z]+:/.test(key);
}

function extractApiPath(key: string): string {
  const match = key.match(/^[A-Z]+:(.*)$/);
  return match ? match[1] : key;
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

  const apiPathIndex = new Map<string, ContractParticipant[]>();

  for (const [contractId, contractParticipants] of byContractId) {
    const contractNode = contractParticipants[0]?.contract;
    if (!contractNode) continue;

    if (contractNode.kind === "api") {
      const pathPart = extractApiPath(contractNode.key);
      const existing = apiPathIndex.get(pathPart) ?? [];
      existing.push(...contractParticipants);
      apiPathIndex.set(pathPart, existing);
    }

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

  for (const [contractId, contractParticipants] of byContractId) {
    const contractNode = contractParticipants[0]?.contract;
    if (!contractNode || contractNode.kind !== "api") continue;
    if (hasHttpMethodPrefix(contractNode.key)) continue;
    const pathOnlyKey = contractNode.key;
    const allParticipantsForPath = apiPathIndex.get(pathOnlyKey) ?? [];

    const pathOnlyConsumers = contractParticipants.filter((p) => p.role === "consumer" || p.role === "shared");
    const methodProducers = allParticipantsForPath.filter(
      (p) => (p.role === "producer" || p.role === "owner" || p.role === "shared") && hasHttpMethodPrefix(p.contract.key)
    );
    for (const consumer of pathOnlyConsumers) {
      for (const producer of methodProducers) {
        if (consumer.repoId === producer.repoId) continue;
        const evidenceNode = consumer.evidence ?? producer.evidence;
        push({
          fromRepoId: consumer.repoId,
          toRepoId: producer.repoId,
          dependencyType: "api",
          sourceContractId: contractId,
          targetContractId: producer.contractId,
          evidenceId: evidenceNode.id,
          raw: evidenceNode.raw,
          confidence: Math.min(evidenceNode.confidence, 0.6)
        });
      }
    }

    const pathOnlyProducers = contractParticipants.filter((p) => p.role === "producer" || p.role === "owner" || p.role === "shared");
    const methodConsumers = allParticipantsForPath.filter(
      (p) => (p.role === "consumer" || p.role === "shared") && hasHttpMethodPrefix(p.contract.key)
    );
    for (const consumer of methodConsumers) {
      for (const producer of pathOnlyProducers) {
        if (consumer.repoId === producer.repoId) continue;
        const evidenceNode = consumer.evidence ?? producer.evidence;
        push({
          fromRepoId: consumer.repoId,
          toRepoId: producer.repoId,
          dependencyType: "api",
          sourceContractId: consumer.contractId,
          targetContractId: contractId,
          evidenceId: evidenceNode.id,
          raw: evidenceNode.raw,
          confidence: Math.min(evidenceNode.confidence, 0.6)
        });
      }
    }
  }

  return dedupBy(result, materializedRepoDependencyDedupKey);
}

// ---------------------------------------------------------------------------
// Phase 4.2: Materialize DEPENDS_ON edges from SEMANTIC_REL edges
// ---------------------------------------------------------------------------

/**
 * Converts SEMANTIC_REL edges into RepoDependencyEdge[] by mapping each
 * semantic relation kind to the appropriate dependency type and direction.
 *
 * This replaces the coarse contractId-based matching in
 * `buildRepoDependenciesFromParticipants` for API and event contracts.
 *
 * Mapping:
 *   CALLS_ENDPOINT     (consumer→producer) → api dependency (consumer→producer)
 *   PUBLISHES_EVENT    (producer→consumer)  → event dependency (consumer→producer, reversed)
 *   SUBSCRIBES_EVENT   (consumer→producer)  → event dependency (consumer→producer)
 *   USES_SCHEMA        (user→provider)      → shared-contract dependency (user→provider)
 *
 * REQUEST_SCHEMA, RESPONSE_SCHEMA, and EVENT_PAYLOAD are skipped — they
 * represent intra-spec associations, not cross-repo dependencies.
 *
 * Same-repo edges are excluded.
 */
export function materializeDependenciesFromSemanticRelations(
  semanticRelations: SemanticRelationEdge[],
  contractSpecs: ContractSpecNode[]
): RepoDependencyEdge[] {
  const specsById = new Map<string, ContractSpecNode>();
  for (const spec of contractSpecs) {
    specsById.set(spec.id, spec);
  }

  const result: RepoDependencyEdge[] = [];
  const seen = new Set<string>();

  for (const rel of semanticRelations) {
    const meta = SEMANTIC_REL_META[rel.kind];
    if (!meta || meta.dependencyType === null) continue; // intra-spec, skip

    const fromSpec = specsById.get(rel.fromSpecId);
    const toSpec = specsById.get(rel.toSpecId);
    if (!fromSpec || !toSpec) continue;

    // Resolve consumer/producer from direction metadata
    const [consumerSpec, producerSpec] = meta.direction === "forward"
      ? [fromSpec, toSpec]
      : [toSpec, fromSpec];

    // Skip same-repo edges
    if (consumerSpec.repoId === producerSpec.repoId) continue;

    const key = `${consumerSpec.repoId}:${producerSpec.repoId}:${meta.dependencyType}:${consumerSpec.contractId}:${producerSpec.contractId}:${rel.evidenceId}`;
    if (seen.has(key)) continue;
    seen.add(key);

    result.push({
      fromRepoId: consumerSpec.repoId,
      toRepoId: producerSpec.repoId,
      dependencyType: meta.dependencyType,
      sourceContractId: consumerSpec.contractId,
      targetContractId: producerSpec.contractId,
      evidenceId: rel.evidenceId,
      raw: rel.reason,
      confidence: rel.confidence
    });
  }

  return result;
}

export async function extractCrossRepoContracts(
  repos: RepoNode[],
  parsedFiles: ParsedGraphFile[],
  options: { aliasOverrides?: AliasOverride[]; config?: LogicLensConfig } = {}
): Promise<CrossRepoExtraction> {
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

  // Filter out pending placeholder edges that carry IDs (schema-ref:<Type>,
  // spec:<id>:pending) which cannot be written to the graph (no matching
  // ContractSpec nodes).  Cross-repo SEMANTIC_REL resolution now runs in the
  // post-indexing rebuildRepoDependencies phase with full multi-repo visibility.
  const semanticRelations = facts.semanticRelations.filter(
    (rel) => !rel.toSpecId.startsWith("schema-ref:") && !rel.fromSpecId.endsWith(":pending")
  );

  const contractsById = new Map(facts.contracts.map((c) => [c.id, c]));
  const evidenceById = new Map(facts.evidence.map((e) => [e.id, e]));
  const participants: ContractParticipant[] = facts.repoContracts.flatMap((edge) => {
    const contractNode = contractsById.get(edge.contractId);
    const evidenceNode = evidenceById.get(edge.evidenceId);
    return contractNode && evidenceNode ? [{ ...edge, contract: contractNode, evidence: evidenceNode }] : [];
  });

  // Phase 4.2: Materialize API and event dependencies from SEMANTIC_REL edges.
  const semanticDeps = materializeDependenciesFromSemanticRelations(
    semanticRelations,
    [...facts.contractSpecs]
  );

  // Legacy matcher runs for ALL kinds as fallback.
  const legacyDeps = buildRepoDependenciesFromParticipants(participants);

  // Merge: semantic deps first → legacy deps fill gaps (structural dedup).
  const repoDependencies = mergeAndDedupeDeps(semanticDeps, legacyDeps);

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
    contracts: [...facts.contracts],
    evidence: [...facts.evidence],
    entities: [...facts.entities],
    repoContracts: [...facts.repoContracts],
    repoDependencies,
    contractEntities: [...facts.contractEntities],
    operations: [...facts.operations],
    workflows: [...workflowMap.values()],
    operationRepos: [...facts.operationRepos],
    workflowOperations: dedupBy(workflowOperations, materializedWorkflowOperationDedupKey),
    packageUsages: [...facts.packageUsages],
    contractSpecs: [...facts.contractSpecs],
    contractSpecEdges: [...facts.contractSpecEdges],
    semanticRelations,
  };
}

function buildExtractContext(
  extractor: ContractExtractor,
  baseContext: ExtractContext,
  enabledRepoIds: Set<string>,
  enabledRepos: RepoNode[]
): ExtractContext {
  const needs = extractor.needs ?? {};
  const context: ExtractContext = {
    repos: enabledRepos,
    parsedFiles: needs.parsedFiles !== false
      ? baseContext.parsedFiles.filter((file) => enabledRepoIds.has(file.repoId))
      : [],
    repoResolver: needs.repoResolver && baseContext.repoResolver
      ? (repoId: string) => {
          if (!enabledRepoIds.has(repoId)) return undefined;
          return baseContext.repoResolver!(repoId);
        }
      : undefined,
    aliasOverrides: needs.aliasOverrides
      ? baseContext.aliasOverrides
      : undefined
  };

  // Development/Testing Proxy guard to catch undeclared context dependencies
  if (process.env.NODE_ENV === "test" || process.env.VITEST || process.env.NODE_ENV === "development") {
    return new Proxy(context, {
      get(target, prop, receiver) {
        if (prop === "repoResolver" && !needs.repoResolver) {
          console.warn(
            `[LogicLens Warning] Extractor "${extractor.name}" accessed "context.repoResolver" but did not declare it in "needs.repoResolver".`
          );
        }
        if (prop === "aliasOverrides" && !needs.aliasOverrides) {
          console.warn(
            `[LogicLens Warning] Extractor "${extractor.name}" accessed "context.aliasOverrides" but did not declare it in "needs.aliasOverrides".`
          );
        }
        if (prop === "parsedFiles" && needs.parsedFiles === false) {
          console.warn(
            `[LogicLens Warning] Extractor "${extractor.name}" accessed "context.parsedFiles" but declared "needs.parsedFiles: false".`
          );
        }
        return Reflect.get(target, prop, receiver);
      }
    });
  }

  return context;
}

export async function extractContractFactsWithRegistry(
  context: ExtractContext,
  config?: LogicLensConfig
): Promise<ExtractedFacts> {
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

  const builder = new ExtractionBuilder();
  const postExtractContexts = new Map<string, { repos: RepoNode[]; parsedFiles: ParsedGraphFile[] }>();
  for (const extractor of builtinContractExtractors) {
    const started = Date.now();

    // Filter repos for which this extractor is enabled
    const enabledRepos = context.repos.filter((repo) => {
      const dfs = detectedFrameworksMap.get(repo.id) ?? [];
      return isExtractorEnabled(extractor, dfs, resolvedConfig!);
    });

    if (enabledRepos.length === 0) {
      continue; // Skip this extractor entirely if not enabled for any repo
    }

    const enabledRepoIds = new Set(enabledRepos.map((r) => r.id));
    const filteredContext = buildExtractContext(extractor, context, enabledRepoIds, enabledRepos);

    postExtractContexts.set(extractor.name, {
      repos: enabledRepos,
      parsedFiles: extractor.needs?.parsedFiles !== false
        ? context.parsedFiles.filter((file) => enabledRepoIds.has(file.repoId))
        : []
    });

    await extractor.extract(filteredContext, builder);
    if (process.env.NODE_ENV !== "test" && !process.env.VITEST) {
      process.stderr.write(`Extractor ${extractor.name}: ${Date.now() - started}ms\n`);
    }
  }

  // P1-1: postExtract phase — cross-file finalization.
  // Freeze a read-only view for postExtract readers, then let extractors
  // amend by writing into the same builder.
  const mergedForPost = builder.build();
  for (const extractor of builtinContractExtractors) {
    if (!extractor.postExtract) continue;
    const filteredContext = postExtractContexts.get(extractor.name);
    if (!filteredContext) continue;
    const postCtx: PostExtractContext = {
      mergedFacts: mergedForPost,
      repos: filteredContext.repos,
      parsedFiles: filteredContext.parsedFiles
    };
    await extractor.postExtract(postCtx, builder);
  }

  return builder.build();
}
