import { createBatchId } from "../graph-model/batchWriter.js";
import type { GraphDB } from "../graph-model/db.js";
import type { AppConfig } from "../../config/schema.js";
import type { ParsedGraphFile, RepoNode } from "../parsing/types.js";
import { toRepoNode } from "../workspace/repoRegistry.js";
import type { IndexOptions } from "./types.js";
import type { IndexRunContext } from "./context.js";
import type { IndexPlanningResult } from "./planning.js";
import { scanAndParseRepo, type ScanParseRepoResult } from "./scanParse.js";
import {
  getGraphWriteFailureDetails,
  prepareGraphSummaries,
  prepareIncrementalPublicGraphReplacement,
  runFactBuildPhase,
  runGraphWritePhase,
  selectGraphWriter,
  type GraphWriteResult
} from "./graphWrite.js";
import { runLexicalProjectionPhase, type LexicalProjectionResult } from "./lexicalProjection.js";
import { runLexicalWritePhase, type LexicalWriteResult } from "./lexicalWrite.js";
import { runLlmSummaryPhase, shouldSummarizeGraphWithLlm, type SummaryFailureState } from "./summaries.js";
import { runIndexStateCommitPhase } from "./stateCommit.js";
import { runRelationRebuildPhase, runSemanticWritePhase, runStaleMarkPhase } from "./semanticWrite.js";
import type { ProgressReporter } from "../../shared/progress.js";
import { SchemaGenerationStore } from "../schema/generationStore.js";
import {
  applyIncrementalSchemaMutation,
  buildIncrementalSchemaMutation,
  stageSchemaGenerationFacts
} from "../schema/staging.js";
import { reconcileNonJavaSchemaFacts } from "../contracts/extraction/nonJavaSchemaReconciler.js";
import type { ContractSpecNode } from "../parsing/types.js";
import { canonicalSerialize, schemaSpecId } from "../schema/model.js";
import { schemaScopeDependencySetChanged } from "../schema/typeSystem.js";
import type {
  ResolutionContextFact,
  ResolutionScopeIdentity,
  SchemaDependencyFact,
  SchemaRootReference,
  TypeDeclarationFact
} from "../schema/model.js";
import { publicNodeStorageId, type PublicGraphGenerationScope } from "../graph-model/publicGraphGeneration.js";
import { schemaDeclarationVisibilityTarget } from "../schema/sourceScopes.js";
import {
  addIncrementalRepoMutation,
  type IncrementalRepoMutation
} from "./incrementalMutation.js";
import { prepareIncrementalPublicGraphStatsDelta } from "./publicGraphStats.js";

type ProgressBarLike = {
  tick(label?: string): void;
  update(current: number, label?: string, total?: number, stepMs?: number): void;
  complete(label?: string): void;
  reporter(): ProgressReporter;
};

export type IndexCounters = {
  filesScanned: number;
  filesChanged: number;
};

export type IndexPathResult = IndexCounters & {
  repos: RepoNode[];
  batchId: string;
  lexicalProjectionDurationMs: number;
  lexicalWriteDurationMs: number;
  batchIds?: string[];
};

type BatchCounts = Map<string, { scanned: number; changed: number }>;
type SummaryFailuresByRepo = Map<string, SummaryFailureState>;

export type PreparedRepoIndex = {
  repoConfig: AppConfig["repos"][number];
  repo: RepoNode;
  batchId: string;
  indexedAt: string;
  scanParse: ScanParseRepoResult;
  summaryFailures?: SummaryFailureState;
};

function createProgressBar(ctx: IndexRunContext): (label: string, total: number) => ProgressBarLike {
  return ctx.logger.createProgressBar ?? (() => ({
    tick: () => {},
    update: () => {},
    complete: () => {},
    reporter: () => () => {}
  }));
}

function log(ctx: IndexRunContext): (message: string) => void {
  return ctx.logger.log ?? (() => {});
}

function warn(ctx: IndexRunContext): (message: string) => void {
  return ctx.logger.warn ?? (() => {});
}

function activePublicGraphScope(ctx: IndexRunContext): PublicGraphGenerationScope | undefined {
  return ctx.activeGeneration
    ? { workspaceId: ctx.workspaceId, generation: ctx.activeGeneration }
    : undefined;
}

function pendingPublicGraphScope(ctx: IndexRunContext): PublicGraphGenerationScope {
  const generation = ctx.targetGeneration ?? ctx.schemaGeneration;
  if (!generation) throw new Error("Index graph writes require a target physical generation.");
  return { workspaceId: ctx.workspaceId, generation };
}

function errorLogger(ctx: IndexRunContext): (...args: any[]) => void {
  return ctx.logger.error ?? (() => {});
}

export function logStage(ctx: IndexRunContext, label: string, timeStarted: number): void {
  log(ctx)(`${label}: ${((Date.now() - timeStarted) / 1000).toFixed(2)}s`);
}

export function sumCounts(results: ScanParseRepoResult[]): IndexCounters {
  return results.reduce((counts, result) => {
    counts.filesScanned += result.filesScanned;
    counts.filesChanged += result.filesChanged;
    return counts;
  }, { filesScanned: 0, filesChanged: 0 });
}

function countsByRepo(results: ScanParseRepoResult[]): BatchCounts {
  return new Map(results.map((result) => [
    result.repo.id,
    { scanned: result.filesScanned, changed: result.filesChanged }
  ]));
}

async function scanParseRepos(input: {
  db?: GraphDB;
  ctx: IndexRunContext;
  repoConfigs: AppConfig["repos"];
  options: IndexOptions;
  changedOnly?: boolean;
}): Promise<ScanParseRepoResult[]> {
  const { db, ctx, repoConfigs, options, changedOnly } = input;
  const results: ScanParseRepoResult[] = [];
  for (const repoConfig of repoConfigs) {
    const repo = toRepoNode(repoConfig, ctx.cwd);
    results.push(await scanAndParseRepo({
      db,
      repo,
      config: ctx.config,
      publicGraphScope: activePublicGraphScope(ctx),
      changedOnly,
      maxFiles: options.maxFiles,
      additionalIndexFiles: ctx.additionalIndexFilesByRepo.get(repo.path),
      activePluginSourceGlobs: ctx.activePluginSourceGlobsByRepo.get(repo.path),
      createProgressBar: createProgressBar(ctx)
    }));
  }
  return results;
}

export async function prepareRepoIndex(input: {
  db: GraphDB;
  ctx: IndexRunContext;
  repoConfig: AppConfig["repos"][number];
  options: IndexOptions;
}): Promise<PreparedRepoIndex> {
  const { db, ctx, repoConfig, options } = input;
  const repo = toRepoNode(repoConfig, ctx.cwd);
  const batchId = createBatchId(`repo:${repo.name}`);
  const indexedAt = new Date().toISOString();
  const scanStarted = Date.now();
  const scanParse = await scanAndParseRepo({
    db,
    repo,
    config: ctx.config,
    publicGraphScope: activePublicGraphScope(ctx),
    changedOnly: options.changedOnly,
    trackRemovedFiles: ctx.publicationMode === "incremental",
    maxFiles: options.maxFiles,
    additionalIndexFiles: ctx.additionalIndexFilesByRepo.get(repo.path),
    activePluginSourceGlobs: ctx.activePluginSourceGlobsByRepo.get(repo.path),
    createProgressBar: createProgressBar(ctx)
  });
  const summaryFailuresByRepo = await runSummaryPipeline({
    ctx,
    batchId,
    repos: [repo],
    parsedFiles: scanParse.parsedFiles,
    label: repo.name
  });
  logStage(ctx, `Scan/parse/summarize ${repo.name}`, scanStarted);
  return {
    repoConfig,
    repo,
    batchId,
    indexedAt,
    scanParse,
    summaryFailures: summaryFailuresByRepo.get(repo.id)
  };
}

async function runGraphPipeline(input: {
  db: GraphDB;
  ctx: IndexRunContext;
  batchId: string;
  indexedAt: string;
  repos: RepoNode[];
  parsedFiles: ParsedGraphFile[];
  label: string;
  stageLabel?: string;
  repoName?: string;
  reconcileLexicalRepos?: boolean;
  lexicalReconcileReason?: string;
  activeFileIdsByRepo?: ReadonlyMap<string, readonly string[]>;
  removedFileIds?: readonly string[];
  removedFileIdsByRepo?: ReadonlyMap<string, readonly string[]>;
  lexicalReconcileOnly?: boolean;
  selection: ReturnType<typeof selectGraphWriter>;
}): Promise<GraphPipelineResult> {
  const { db, ctx, batchId, indexedAt, repos, parsedFiles, label, stageLabel, repoName, selection, reconcileLexicalRepos, lexicalReconcileReason, activeFileIdsByRepo, removedFileIds = [], removedFileIdsByRepo, lexicalReconcileOnly = false } = input;
  const logPrefix = stageLabel ?? (repoName ? undefined : "");
  // Keep fact construction and graph writes as one reusable phase bundle so
  // full, batched, and per-repo paths share the same writer semantics.
  const factsStarted = Date.now();
  log(ctx)(repoName ? `Facts build start ${repoName}` : logPrefix ? `${logPrefix} facts build start` : "Facts build start");
  const factBuild = await runFactBuildPhase({
    batchId,
    workspaceId: ctx.workspaceId,
    generation: pendingPublicGraphScope(ctx).generation,
    systemName: ctx.config.systemName,
    indexedAt,
    repos,
    parsedFiles,
    config: ctx.config,
    repoName,
    createProgressBar: createProgressBar(ctx)
  });
  logStage(ctx, repoName ? `Facts build ${repoName}` : logPrefix ? `${logPrefix} facts build` : "Facts build", factsStarted);
  const removedSources = removedFileIdsByRepo
    ? [...removedFileIdsByRepo.entries()].flatMap(([repoId, fileIds]) =>
      fileIds.map((fileId) => ({ repoId, fileId })))
    : repos.length === 1 && repos[0]
      ? removedFileIds.map((fileId) => ({ repoId: repos[0]!.id, fileId }))
      : [];
  if (ctx.schemaGeneration) {
    await reconcileWithActiveSchemaCatalog(db, ctx.workspaceId, factBuild.facts, parsedFiles, {
      incremental: ctx.publicationMode === "incremental",
      removedSources,
      repoPaths: new Map(repos.map((repo) => [repo.id, repo.path]))
    });
  }
  const publicGraphReplacement = ctx.incrementalMutationSet
    ? await prepareIncrementalPublicGraphReplacement(db, factBuild.facts, parsedFiles, removedSources.map((source) => source.fileId))
    : undefined;
  if (ctx.incrementalMutationSet && publicGraphReplacement) {
    if (ctx.incrementalMutationSet.publicGraphStatsDelta) {
      throw new Error("Incremental workspace prepared more than one public graph stats delta.");
    }
    const preparedStats = await prepareIncrementalPublicGraphStatsDelta({
      db,
      scope: pendingPublicGraphScope(ctx),
      facts: factBuild.facts,
      replacement: publicGraphReplacement,
      expectedRevision: ctx.incrementalMutationSet.expectedActiveRevision
    });
    ctx.incrementalMutationSet.publicGraphStatsDelta = preparedStats.delta;
  }

  const lexicalLabel = repoName ? `Lexical projection ${repoName}` : logPrefix ? `${logPrefix} lexical projection` : "Lexical projection";
  const projectionFacts = lexicalReconcileOnly ? { ...factBuild.facts, repos: [] } : factBuild.facts;
  log(ctx)(`${lexicalLabel} start: repos=${projectionFacts.repos.length} files=${projectionFacts.files.length} evidence=${projectionFacts.evidence.length}`);
  const lexicalProjection = await runLexicalProjectionPhase({
    facts: projectionFacts,
    workspaceId: ctx.workspaceId,
    repoName,
    repoId: repos.length === 1 ? repos[0]?.id : undefined,
    createProgressBar: createProgressBar(ctx)
  });
  log(ctx)(`${lexicalLabel} complete: documents=${lexicalProjection.documentCount} duration=${(lexicalProjection.durationMs / 1000).toFixed(2)}s`);

  if (ctx.incrementalMutationSet) {
    if (repos.length === 0) throw new Error("Incremental graph mutation has no repository owner.");
    const touchedFileIds = [...new Set([
      ...parsedFiles.map((file) => file.fileId),
      ...removedSources.map((source) => source.fileId)
    ])].sort((left, right) => left.localeCompare(right));
    const schema = await buildIncrementalSchemaMutation({
      store: new SchemaGenerationStore(db, ctx.workspaceId),
      generation: pendingPublicGraphScope(ctx).generation,
      parsedFiles,
      removedSources,
      extraction: factBuild.facts.crossRepo,
      lexicalDocuments: lexicalProjection.documents,
      activeFileIdsByRepo: activeFileIdsByRepo ?? new Map()
    });
    const previousDocumentIds = (await Promise.all(repos.map((repo) => ctx.lexicalStore.documentIdsForSources({
      workspaceId: ctx.workspaceId,
      generation: pendingPublicGraphScope(ctx).generation,
      repoId: repo.id,
      fileIds: [...new Set([
        ...parsedFiles.filter((file) => file.repoId === repo.id).map((file) => file.fileId),
        ...(removedFileIdsByRepo?.get(repo.id) ?? (repos.length === 1 ? removedFileIds : []))
      ])]
    })))).flat();
    const nextDocumentIds = new Set(lexicalProjection.documents.map((document) => document.id));
    const deleteDocumentIds = [...new Set([
      ...previousDocumentIds.filter((documentId) => !nextDocumentIds.has(documentId)),
      ...schema.deleteLexicalDocumentIds
    ])].sort((left, right) => left.localeCompare(right));
    const summaries = shouldSummarizeGraphWithLlm(ctx.llm.summaryLevel)
      ? {
        kind: "prepared" as const,
        payload: await prepareGraphSummaries({
          repos,
          parsedFiles,
          crossRepo: factBuild.facts.crossRepo,
          config: ctx.config,
          llmSummaryLevel: ctx.llm.summaryLevel,
          openAiApiKey: ctx.llm.apiKey,
          openAiBaseUrl: ctx.llm.baseUrl,
          label,
          createProgressBar: createProgressBar(ctx)
        })
      }
      : { kind: "none" as const };
    const mutation: IncrementalRepoMutation = {
      batchId,
      indexedAt,
      repos,
      parsedFiles,
      selection,
      publicGraph: {
        facts: factBuild.facts,
        touchedFileIds,
        deletedFileIds: removedSources.map((source) => source.fileId).sort((left, right) => left.localeCompare(right)),
        activeFileIdsByRepo: new Map(repos.map((repo) => [
          repo.id,
          [...(activeFileIdsByRepo?.get(repo.id) ?? [])].sort((left, right) => left.localeCompare(right))
        ])),
        replacement: publicGraphReplacement!
      },
      schema,
      lexical: {
        upsertDocuments: lexicalProjection.documents,
        deleteDocumentIds
      },
      summaries,
      reconcileLexicalRepos: reconcileLexicalRepos ?? false,
      lexicalProjectionDurationMs: lexicalProjection.durationMs
    };
    addIncrementalRepoMutation(ctx.incrementalMutationSet, mutation);
    const providerHealth = await ctx.lexicalStore.health(pendingPublicGraphScope(ctx));
    log(ctx)(`${repoName ? `Incremental mutation ${repoName}` : "Incremental mutation"} prepared: ` +
      `files=${touchedFileIds.length} graphNodes=${factBuild.facts.files.length + factBuild.facts.code.length + factBuild.facts.contractSpecs.length} ` +
      `lexicalUpserts=${lexicalProjection.documents.length} lexicalDeletes=${deleteDocumentIds.length}`);
    return {
      graphWrite: {
        writerMode: selection.mode,
        batchId,
        repoNames: repos.map((repo) => repo.name),
        repoIds: repos.map((repo) => repo.id),
        atomicityMode: "transactional",
        journalStatus: "started",
        recoveredBatchIds: [],
        fallback: false
      },
      lexicalProjection,
      lexicalWrite: {
        phase: "lexical-write",
        durationMs: 0,
        documentCount: lexicalProjection.documentCount,
        reconciledRepoIds: [],
        providerHealth,
        projectionSchemaVersion: providerHealth.projectionSchemaVersion,
        tokenizerVersion: providerHealth.tokenizerVersion,
        indexStatus: providerHealth.status,
        indexReasons: [...providerHealth.reasons]
      }
    };
  }

  const writeStarted = Date.now();
  const graphLabel = repoName ? `Graph write ${repoName}` : logPrefix ? `${logPrefix} graph write` : "Graph write";
  log(ctx)(`${graphLabel} start: writer=${selection.mode} files=${factBuild.facts.files.length} code=${factBuild.facts.code.length} relations=${factBuild.facts.imports.length + factBuild.facts.calls.length}`);
  let lexicalWrite: LexicalWriteResult | undefined;
  let contributionGcLexicalDocumentIds: string[] = [];
  const graphWrite = await runGraphWritePhase({
    db,
    cwd: ctx.cwd,
    selection,
    facts: factBuild.facts,
    repos,
    parsedFiles,
    config: ctx.config,
    llmSummaryLevel: ctx.llm.summaryLevel,
    openAiApiKey: ctx.llm.apiKey,
    openAiBaseUrl: ctx.llm.baseUrl,
    label,
    repoName,
    createProgressBar: createProgressBar(ctx),
    log: log(ctx),
    warn: warn(ctx),
    skipGraphWrite: lexicalReconcileOnly,
    deferWorkspaceCommit: Boolean(ctx.schemaGeneration),
    skipRecovery: Boolean(ctx.schemaGeneration),
    parentGeneration: ctx.activeGeneration,
    beforeWrite: ctx.schemaGeneration
      ? async () => {
        contributionGcLexicalDocumentIds = await stageSchemaGenerationFacts({
          store: new SchemaGenerationStore(db, ctx.workspaceId),
          generation: ctx.schemaGeneration!,
          parsedFiles,
          extraction: factBuild.facts.crossRepo,
          lexicalDocuments: lexicalProjection.documents
        });
      }
      : undefined,
    lexical: {
      store: ctx.lexicalStore,
      workspaceId: ctx.workspaceId,
      write: async () => {
        const lexicalWriteLabel = repoName ? `Lexical write ${repoName}` : logPrefix ? `${logPrefix} lexical write` : "Lexical write";
        log(ctx)(`${lexicalWriteLabel} start: documents=${lexicalProjection.documentCount}`);
        lexicalWrite = await runLexicalWritePhase({
          store: ctx.lexicalStore,
          workspaceId: ctx.workspaceId,
          generation: pendingPublicGraphScope(ctx).generation,
          batchId,
          repos,
          documents: lexicalProjection.documents,
          repoName,
          repoId: repos.length === 1 ? repos[0]?.id : undefined,
          reconcileRepos: reconcileLexicalRepos,
          reconcileReason: lexicalReconcileReason,
          activeFileIdsByRepo,
          touchedFileIdsByRepo: new Map(repos.map((repo) => [repo.id, parsedFiles.filter((file) => file.repoId === repo.id).map((file) => file.fileId)])),
          deleteDocumentIds: contributionGcLexicalDocumentIds
        });
        log(ctx)(`${lexicalWriteLabel} complete: documents=${lexicalWrite.documentCount} indexSizeBytes=${lexicalWrite.providerHealth.metrics.indexSizeBytes} status=${lexicalWrite.indexStatus} duration=${(lexicalWrite.durationMs / 1000).toFixed(2)}s`);
      }
    }
  });
  if (!lexicalWrite) throw new Error("Graph write completed without executing its lexical write callback.");
  log(ctx)(`${graphLabel} complete: writer=${graphWrite.writerMode} duration=${((Date.now() - writeStarted) / 1000).toFixed(2)}s`);
  return { graphWrite, lexicalProjection, lexicalWrite };
}

export async function reconcileWithActiveSchemaCatalog(
  db: GraphDB,
  workspaceId: string,
  facts: import("../graph-model/facts.js").GraphFactsBatch,
  parsedFiles: readonly ParsedGraphFile[],
  options: {
    incremental: boolean;
    removedSources: readonly { repoId: string; fileId: string }[];
    repoPaths: ReadonlyMap<string, string>;
  }
): Promise<void> {
  const touchedSources = [...new Map([
    ...parsedFiles.map((file) => ({ repoId: file.repoId, fileId: file.fileId })),
    ...options.removedSources
  ].map((source) => [`${source.repoId}\0${source.fileId}`, source])).values()];
  const touchedSourceKeys = new Set(touchedSources.map((source) => `${source.repoId}\0${source.fileId}`));
  const touchedFileIds = new Set(touchedSources.map((source) => source.fileId));
  let activeDeclarations: TypeDeclarationFact[] = [];
  let activeResolutionContexts: ResolutionContextFact[] = [];
  let activeSchemas: ContractSpecNode[] = [];
  let activeRootOwners: ContractSpecNode[] = [];

  if (options.incremental) {
    const store = new SchemaGenerationStore(db, workspaceId);
    const oldTouchedDeclarations = await store.factsBySources<TypeDeclarationFact>(
      "declarations",
      touchedSources,
      facts.generation
    );
    const changedDeclarationIds = [...new Set([
      ...oldTouchedDeclarations.map((declaration) => declaration.id),
      ...facts.crossRepo.schemaInternalFacts.declarations.map((declaration) => declaration.id)
    ])].sort((left, right) => left.localeCompare(right));
    const [oldTouchedContexts, oldTouchedScopeDependencies] = await Promise.all([
      store.factsBySources<ResolutionContextFact>("resolutionContexts", touchedSources, facts.generation),
      store.factsBySources<import("../schema/model.js").ResolutionScopeDependencyFact>(
        "resolutionScopeDependencies",
        touchedSources,
        facts.generation
      )
    ]);
    const pendingTouchedContexts = facts.crossRepo.schemaInternalFacts.resolutionContexts
      .filter((context) => touchedSourceKeys.has(`${context.repoId}\0${context.fileId}`));
    const contextsChanged = canonicalSerialize(oldTouchedContexts.map(schemaScopeKey).sort())
      !== canonicalSerialize(pendingTouchedContexts.map(schemaScopeKey).sort());
    const touchedScopeKeys = new Set([...oldTouchedContexts, ...pendingTouchedContexts].map(schemaScopeKey));
    const pendingTouchedScopeDependencies = facts.crossRepo.schemaInternalFacts.resolutionScopeDependencies
      .filter((dependency) => touchedScopeKeys.has(schemaScopeKey(dependency.from)));
    const scopeDependenciesChanged = schemaScopeDependencySetChanged(
      oldTouchedScopeDependencies,
      pendingTouchedScopeDependencies
    );
    const changedResolutionScopes = [...new Map([
      ...(contextsChanged ? [...oldTouchedContexts, ...pendingTouchedContexts] : []),
      ...(scopeDependenciesChanged ? [
        ...oldTouchedScopeDependencies.flatMap((dependency) => [dependency.from, dependency.to]),
        ...pendingTouchedScopeDependencies.flatMap((dependency) => [dependency.from, dependency.to])
      ] : [])
    ].map((scope) => [schemaScopeKey(scope), {
      languageId: scope.languageId,
      repoId: scope.repoId,
      resolutionScopeId: scope.resolutionScopeId
    }])).values()].sort((left, right) => schemaScopeKey(left).localeCompare(schemaScopeKey(right)));
    const dependentRoots = await store.affectedRoots<SchemaRootReference>({
      generation: facts.generation,
      // Touched owners are already replaced directly by the pending roots and
      // public source replacement. Reverse planning here recovers only
      // unchanged owners that are absent from the parsed batch.
      touchedSources: [],
      changedDeclarationIds,
      changedResolutionScopes,
      pendingRoots: facts.crossRepo.schemaInternalFacts.roots
    });
    const dependentRootIds = dependentRoots.map((root) => root.id);
    const dependentOwnerSpecIds = [...new Set(dependentRoots.map((root) => root.ownerSpecId))]
      .sort((left, right) => left.localeCompare(right));
    activeRootOwners = await contractSpecsByIds({
      db,
      workspaceId,
      generation: facts.generation,
      ids: dependentOwnerSpecIds,
      kinds: ["event", "http-endpoint", "grpc-method", "graphql-operation"]
    });

    const dependentFacts = await store.dependenciesByRoots<SchemaDependencyFact>(dependentRootIds, facts.generation);
    const dependentContexts = await store.factsByIds<ResolutionContextFact>(
      "resolutionContexts",
      dependentRoots.map((root) => root.resolutionContextId),
      facts.generation
    );
    const visibilityTarget = await schemaDeclarationVisibilityTarget({
      files: parsedFiles,
      candidates: facts.crossRepo.schemaDeclarations,
      repoPaths: options.repoPaths
    });
    const selectedDeclarations = new Map<string, TypeDeclarationFact>();
    const selectedContexts = new Map<string, ResolutionContextFact>();
    const declarationIds = new Set<string>(dependentFacts.map((dependency) => dependency.declarationId));
    const exactScopes = new Map<string, ResolutionScopeIdentity>();
    const scopePrefixes = new Map<string, {
      languageId: string;
      repoId: string;
      resolutionScopePrefix: string;
    }>();
    const declarationSources = new Map(visibilityTarget.sources.map((source) => [
      `${source.repoId}\0${source.fileId}`,
      source
    ]));
    const contextSources = new Map<string, { repoId: string; fileId: string }>();
    const queriedDeclarationIds = new Set<string>();
    const queriedExactScopes = new Set<string>();
    const queriedScopePrefixes = new Set<string>();
    const queriedDeclarationSources = new Set<string>();
    const queriedContextSources = new Set<string>();
    const addScope = (scope: ResolutionScopeIdentity): void => {
      exactScopes.set(schemaScopeKey(scope), scope);
    };
    const addContext = (context: ResolutionContextFact): void => {
      selectedContexts.set(context.id, context);
      addScope(context);
      for (const binding of context.imports) declarationIds.add(binding.declarationId);
    };
    const addDeclaration = (declaration: TypeDeclarationFact): void => {
      if (touchedSourceKeys.has(`${declaration.identity.repoId}\0${declaration.fileId}`)) return;
      selectedDeclarations.set(declaration.id, declaration);
      addScope(declaration.identity);
      contextSources.set(`${declaration.identity.repoId}\0${declaration.fileId}`, {
        repoId: declaration.identity.repoId,
        fileId: declaration.fileId
      });
    };
    for (const scope of visibilityTarget.exactScopes) addScope(scope);
    for (const prefix of visibilityTarget.scopePrefixes) {
      scopePrefixes.set(schemaScopePrefixKey(prefix), prefix);
    }
    for (const context of [...dependentContexts, ...oldTouchedContexts]) addContext(context);
    for (const context of facts.crossRepo.schemaInternalFacts.resolutionContexts) {
      for (const binding of context.imports) declarationIds.add(binding.declarationId);
    }

    while (true) {
      const sourceBatch = [...declarationSources.entries()]
        .filter(([key]) => !queriedDeclarationSources.has(key));
      const scopeBatch = [...exactScopes.entries()]
        .filter(([key]) => !queriedExactScopes.has(key));
      const prefixBatch = [...scopePrefixes.entries()]
        .filter(([key]) => !queriedScopePrefixes.has(key));
      const idBatch = [...declarationIds].filter((id) => !queriedDeclarationIds.has(id));
      for (const [key] of sourceBatch) queriedDeclarationSources.add(key);
      for (const [key] of scopeBatch) queriedExactScopes.add(key);
      for (const [key] of prefixBatch) queriedScopePrefixes.add(key);
      for (const id of idBatch) queriedDeclarationIds.add(id);
      const declarations = [
        ...await store.factsBySources<TypeDeclarationFact>(
          "declarations",
          sourceBatch.map(([, source]) => source),
          facts.generation
        ),
        ...await store.declarationsByScopes<TypeDeclarationFact>({
          exactScopes: scopeBatch.map(([, scope]) => scope),
          scopePrefixes: prefixBatch.map(([, prefix]) => prefix),
          generation: facts.generation
        }),
        ...await store.factsByIds<TypeDeclarationFact>("declarations", idBatch, facts.generation)
      ];
      for (const declaration of declarations) addDeclaration(declaration);

      const contextSourceBatch = [...contextSources.entries()]
        .filter(([key]) => !queriedContextSources.has(key));
      for (const [key] of contextSourceBatch) queriedContextSources.add(key);
      const contexts = await store.factsBySources<ResolutionContextFact>(
        "resolutionContexts",
        contextSourceBatch.map(([, source]) => source),
        facts.generation
      );
      for (const context of contexts) addContext(context);
      if (sourceBatch.length === 0 && scopeBatch.length === 0 && prefixBatch.length === 0
        && idBatch.length === 0 && contextSourceBatch.length === 0) break;
    }

    activeDeclarations = [...selectedDeclarations.values()]
      .sort((left, right) => left.id.localeCompare(right.id));
    activeResolutionContexts = [...selectedContexts.values()]
      .filter((context) => !touchedSourceKeys.has(`${context.repoId}\0${context.fileId}`))
      .sort((left, right) => left.id.localeCompare(right.id));
    const rootContributions = await store.contributionsByRoots(dependentRootIds, facts.generation);
    const schemaIds = new Set(rootContributions
      .filter((contribution) => contribution.entityKind === "schema-spec")
      .map((contribution) => contribution.entityId));
    for (const declaration of activeDeclarations) {
      if (!declaration.candidate) {
        schemaIds.add(schemaSpecId({ declarationId: declaration.id, canonicalTypeArguments: [] }));
      }
    }
    const candidateDeclarationIds = new Set([
      ...activeDeclarations.filter((declaration) => declaration.candidate).map((declaration) => declaration.id),
      ...facts.crossRepo.schemaInternalFacts.declarations
        .filter((declaration) => declaration.candidate)
        .map((declaration) => declaration.id)
    ]);
    activeSchemas = (await contractSpecsByIds({
      db,
      workspaceId,
      generation: facts.generation,
      ids: [...schemaIds],
      kinds: ["schema"]
    })).filter((spec) => {
      const declarationId = schemaDeclarationId(spec);
      return !declarationId || !candidateDeclarationIds.has(declarationId);
    });
  }

  const eligibleActiveSchemas = activeSchemas.filter((spec) =>
    !touchedSourceKeys.has(`${spec.repoId}\0${spec.fileId}`));
  const eligibleActiveRootOwners = activeRootOwners.filter((spec) =>
    !touchedSourceKeys.has(`${spec.repoId}\0${spec.fileId}`));
  const changedIds = new Set(facts.contractSpecs.map((spec) => spec.id));
  const catalog = [...new Map([
    ...eligibleActiveSchemas.filter((spec) => !changedIds.has(spec.id)),
    ...eligibleActiveRootOwners.filter((spec) => !changedIds.has(spec.id)),
    ...facts.contractSpecs
  ].map((spec) => [spec.id, spec])).values()];
  const activeCandidates = activeDeclarations.flatMap((fact) => fact.candidate ? [fact.candidate] : []);
  const declarationCandidates = [...new Map([...activeCandidates, ...facts.crossRepo.schemaDeclarations].map((candidate) => [
    `${candidate.declaration.languageId}\0${candidate.declaration.repoId}\0${candidate.declaration.resolutionScopeId}\0${candidate.declaration.canonicalName}`,
    candidate
  ])).values()];
  const reconciled = reconcileNonJavaSchemaFacts(catalog, facts.semanticRelations, declarationCandidates, {
    sourceFiles: parsedFiles,
    resolutionContexts: activeResolutionContexts
  });
  const materializedIds = new Set(reconciled.materialized.contractSpecEdges.map((edge) => edge.specId));
  const affectedOwnerIds = new Set([
    ...activeRootOwners.map((spec) => spec.id),
    ...facts.contractSpecs
      .filter((spec) => touchedFileIds.has(spec.fileId))
      .map((spec) => spec.id)
  ]);
  const reconciledRootOwnerIds = new Set(reconciled.internal.roots
    .filter((root) => affectedOwnerIds.has(root.ownerSpecId))
    .map((root) => root.ownerSpecId));
  const changedSpecs = reconciled.contractSpecs
    .filter((spec) => changedIds.has(spec.id) || touchedFileIds.has(spec.fileId)
      || materializedIds.has(spec.id) || reconciledRootOwnerIds.has(spec.id))
    .map((spec) => ({ ...spec, batchId: facts.batchId, indexedAt: facts.indexedAt, active: true }));
  const changedSpecIds = new Set(changedSpecs.map((spec) => spec.id));
  const changedRelations = reconciled.semanticRelations.filter((relation) => changedSpecIds.has(relation.fromSpecId) || changedSpecIds.has(relation.toSpecId));
  facts.contracts = [...new Map([...facts.contracts, ...reconciled.materialized.contracts].map((item) => [item.id, item])).values()];
  facts.entities = [...new Map([...facts.entities, ...reconciled.materialized.entities].map((item) => [item.id, item])).values()];
  const materializedEvidence = reconciled.materialized.evidence.map((item) => ({
    ...item, batchId: facts.batchId, indexedAt: facts.indexedAt, active: true
  }));
  const materializedRepoContracts = reconciled.materialized.repoContracts.map((item) => ({
    ...item, batchId: facts.batchId, active: true
  }));
  const materializedSpecEdges = reconciled.materialized.contractSpecEdges.map((item) => ({
    ...item, batchId: facts.batchId, active: true
  }));
  const materializedContractEntities = reconciled.materialized.contractEntities.map((item) => ({
    ...item, batchId: facts.batchId, active: true
  }));
  facts.evidence = [...new Map([...facts.evidence, ...materializedEvidence].map((item) => [item.id, item])).values()];
  facts.repoContracts = [...new Map([...facts.repoContracts, ...materializedRepoContracts].map((item) => [`${item.repoId}\0${item.contractId}\0${item.role}\0${item.evidenceId}`, item])).values()];
  facts.contractSpecEdges = [...new Map([...facts.contractSpecEdges, ...materializedSpecEdges].map((item) => [`${item.contractId}\0${item.specId}\0${item.evidenceId}`, item])).values()];
  facts.contractEntities = [...new Map([...facts.contractEntities, ...materializedContractEntities].map((item) => [`${item.contractId}\0${item.entityId}\0${item.evidenceId}`, item])).values()];
  facts.contractSpecs = changedSpecs;
  facts.semanticRelations = changedRelations.map((relation) => ({ ...relation, batchId: facts.batchId, active: true }));
  facts.crossRepo.contractSpecs = changedSpecs;
  facts.crossRepo.semanticRelations = changedRelations;
  facts.crossRepo.schemaInternalFacts = reconciled.internal;
  facts.crossRepo.schemaDeclarations = [...facts.crossRepo.schemaDeclarations];
}

async function contractSpecsByIds(input: {
  db: GraphDB;
  workspaceId: string;
  generation: string;
  ids: readonly string[];
  kinds: readonly ContractSpecNode["specKind"][];
}): Promise<ContractSpecNode[]> {
  const ids = [...new Set(input.ids)].sort((left, right) => left.localeCompare(right));
  if (ids.length === 0) return [];
  const rows = await input.db.query<ContractSpecNode>(
    "MATCH (n:ContractSpec) WHERE n.workspaceId = $workspaceId AND n.generation = $generation " +
    "AND n.active = true AND n.storageId IN $storageIds AND n.specKind IN $specKinds " +
    "RETURN n.id AS id, n.contractId AS contractId, n.specKind AS specKind, n.repoId AS repoId, n.fileId AS fileId, " +
    "n.evidenceId AS evidenceId, n.sourceSymbolId AS sourceSymbolId, n.canonicalKey AS canonicalKey, " +
    "n.httpMethod AS httpMethod, n.pathTemplate AS pathTemplate, n.eventTopic AS eventTopic, n.framework AS framework, " +
    "n.version AS version, n.specJson AS specJson, n.confidence AS confidence, n.batchId AS batchId, " +
    "n.indexedAt AS indexedAt, n.active AS active;",
    {
      workspaceId: input.workspaceId,
      generation: input.generation,
      storageIds: ids.map((id) => publicNodeStorageId(input.generation, id)),
      specKinds: [...input.kinds]
    }
  );
  return rows.sort((left, right) => left.id.localeCompare(right.id));
}

function schemaScopeKey(scope: ResolutionScopeIdentity): string {
  return `${scope.languageId}\0${scope.repoId}\0${scope.resolutionScopeId}`;
}

function schemaScopePrefixKey(scope: {
  languageId: string;
  repoId: string;
  resolutionScopePrefix: string;
}): string {
  return `${scope.languageId}\0${scope.repoId}\0${scope.resolutionScopePrefix}`;
}

function schemaDeclarationId(spec: ContractSpecNode): string | undefined {
  try {
    const parsed = JSON.parse(spec.specJson) as { identity?: { declarationId?: unknown } };
    return typeof parsed.identity?.declarationId === "string" ? parsed.identity.declarationId : undefined;
  } catch {
    return undefined;
  }
}

export type GraphPipelineResult = {
  graphWrite: GraphWriteResult;
  lexicalProjection: LexicalProjectionResult;
  lexicalWrite: LexicalWriteResult;
};

export type FullCopyLexicalReconcileDecision = {
  reconcile: boolean;
  reason: "non-kuzu-provider" | "health-check-failed" | "invalid-document-count" | "unreliable-stats" | "active-documents" | "empty-workspace";
};

export async function resolveFullCopyLexicalReconcile(ctx: IndexRunContext): Promise<FullCopyLexicalReconcileDecision> {
  if (ctx.config.graph.provider !== "kuzu") return { reconcile: true, reason: "non-kuzu-provider" };
  try {
    const health = await ctx.lexicalStore.pendingHealth(pendingPublicGraphScope(ctx));
    const documentCount = health.metrics.documentCount;
    if (!Number.isSafeInteger(documentCount) || documentCount < 0) {
      return { reconcile: true, reason: "invalid-document-count" };
    }
    if (health.reasons.some((reason) => reason === "lexical_stats_table_missing" || reason === "lexical_stats_version_mismatch")) {
      return { reconcile: true, reason: "unreliable-stats" };
    }
    return documentCount === 0
      ? { reconcile: false, reason: "empty-workspace" }
      : { reconcile: true, reason: "active-documents" };
  } catch {
    return { reconcile: true, reason: "health-check-failed" };
  }
}

async function runSemanticPipeline(input: {
  ctx: IndexRunContext;
  batchId: string;
  repos: RepoNode[];
  parsedFiles: ParsedGraphFile[];
  label: string;
  repoName?: string;
}): Promise<string | undefined> {
  const { ctx, batchId, repos, parsedFiles, label, repoName } = input;
  if (!ctx.embedding.enabled) return undefined;
  const semanticWrite = await runSemanticWritePhase({
    cwd: ctx.cwd,
    repos,
    parsedFiles,
    config: ctx.config,
    enabled: true,
    label,
    repoName,
    batchId,
    createProgressBar: createProgressBar(ctx),
    warn: warn(ctx)
  });
  return semanticWrite.warning;
}

async function runSummaryPipeline(input: {
  ctx: IndexRunContext;
  batchId: string;
  repos: RepoNode[];
  parsedFiles: ParsedGraphFile[];
  label: string;
}): Promise<SummaryFailuresByRepo> {
  const { ctx, batchId, repos, parsedFiles, label } = input;
  const summaryPhase = await runLlmSummaryPhase({
    parsedFiles,
    repos,
    config: ctx.config,
    openAiApiKey: ctx.llm.apiKey,
    openAiBaseUrl: ctx.llm.baseUrl,
    llmSummaryLevel: ctx.llm.summaryLevel,
    label,
    batchId,
    createProgressBar: createProgressBar(ctx),
    errorLogger: errorLogger(ctx)
  });
  return summaryPhase.failuresByRepo;
}

async function commitSucceededRepos(input: {
  db: GraphDB;
  ctx: IndexRunContext;
  repos: RepoNode[];
  counts: BatchCounts;
  batchId: string;
  indexedAt: string;
  summaryFailures: SummaryFailuresByRepo;
  semanticWarning?: string;
  graphPipeline?: GraphPipelineResult;
}): Promise<void> {
  const { db, ctx, repos, counts, batchId, indexedAt, summaryFailures, semanticWarning, graphPipeline } = input;
  for (const repo of repos) {
    const repoCounts = counts.get(repo.id) ?? { scanned: 0, changed: 0 };
    const commit = () => runIndexStateCommitPhase({
      db,
      repo,
      batchId,
      indexedAt,
      filesScanned: repoCounts.scanned,
      filesChanged: repoCounts.changed,
      filesStale: 0,
      status: "succeeded",
      summaryFailures: summaryFailures.get(repo.id),
      semanticWarning,
      graphWriteAtomicity: graphPipeline?.graphWrite.atomicityMode,
      graphWriteStatus: graphPipeline?.graphWrite.journalStatus,
      lexical: graphPipeline?.lexicalWrite,
      lexicalProjectionDurationMs: graphPipeline?.lexicalProjection.durationMs
    });
    if (ctx.schemaGeneration) ctx.pendingIndexStateCommits.set(repo.id, commit);
    else await commit();
  }
}

async function commitFailedRepos(input: {
  db: GraphDB;
  ctx: IndexRunContext;
  repos: RepoNode[];
  counts: BatchCounts;
  batchId: string;
  indexedAt: string;
  error: unknown;
  graphWrite?: GraphWriteResult;
}): Promise<void> {
  const { db, ctx, repos, counts, batchId, indexedAt, error, graphWrite } = input;
  if (ctx.schemaGeneration) return;
  const graphWriteFailure = getGraphWriteFailureDetails(error);
  for (const repo of repos) {
    const repoCounts = counts.get(repo.id) ?? { scanned: 0, changed: 0 };
    await runIndexStateCommitPhase({
      db,
      repo,
      batchId,
      indexedAt,
      filesScanned: repoCounts.scanned,
      filesChanged: 0,
      filesStale: 0,
      status: "failed",
      graphWriteAtomicity: graphWrite?.atomicityMode ?? graphWriteFailure?.graphWriteAtomicity,
      graphWriteStatus: graphWrite?.journalStatus ?? graphWriteFailure?.graphWriteStatus,
      error
    });
  }
}

export async function runBatchedFullIndex(input: {
  db: GraphDB;
  ctx: IndexRunContext;
  repoBatches: AppConfig["repos"][];
  options: IndexOptions;
  initialRepoCount: number;
  preparedRepos?: ReadonlyMap<string, PreparedRepoIndex>;
}): Promise<IndexPathResult> {
  const { db, ctx, repoBatches, options, initialRepoCount, preparedRepos } = input;
  const indexedRepos: RepoNode[] = [];
  let filesScanned = 0;
  let filesChanged = 0;
  let lexicalProjectionDurationMs = 0;
  let lexicalWriteDurationMs = 0;
  // A full publication always targets a newly allocated empty physical
  // generation, regardless of how many repos exist in the active snapshot.
  let graphIsEmpty = true;
  const batchIds: string[] = [];

  // Batched full indexing is the only path that switches from bulk-copy to
  // append-copy across batches; keep that state here instead of in runIndexing.
  log(ctx)(`Batched indexing: batches=${repoBatches.length} batchSize=${options.batchSize ?? ctx.config.indexing.batchSize}`);
  for (const [batchIndex, batchRepoConfigs] of repoBatches.entries()) {
    const batchStarted = Date.now();
    const batchNumber = batchIndex + 1;
    const batchLabel = `Batch ${batchNumber}/${repoBatches.length}`;
    const batchId = createBatchId(`batch:${batchNumber}`);
    batchIds.push(batchId);
    const indexedAt = new Date().toISOString();
    let batchRepos: RepoNode[] = [];
    let perRepoCounts: BatchCounts = new Map();
    log(ctx)(`${batchLabel}: repos=${batchRepoConfigs.length}`);

    try {
      const scanStarted = Date.now();
      const preparedBatch = batchRepoConfigs
        .map((repoConfig) => preparedRepos?.get(toRepoNode(repoConfig, ctx.cwd).id))
        .filter((item): item is PreparedRepoIndex => Boolean(item));
      const scanParseResults = preparedBatch.length === batchRepoConfigs.length
        ? preparedBatch.map((item) => item.scanParse)
        : await scanParseRepos({ ctx, repoConfigs: batchRepoConfigs, options });
      batchRepos = scanParseResults.map((result) => result.repo);
      perRepoCounts = countsByRepo(scanParseResults);
      const batchCounts = sumCounts(scanParseResults);
      filesScanned += batchCounts.filesScanned;
      filesChanged += batchCounts.filesChanged;
      indexedRepos.push(...batchRepos);
      const parsedFiles = scanParseResults.flatMap((result) => result.parsedFiles);

      const summaryFailures = preparedBatch.length === batchRepoConfigs.length
        ? new Map(preparedBatch.flatMap((item) => item.summaryFailures ? [[item.repo.id, item.summaryFailures] as const] : []))
        : await runSummaryPipeline({ ctx, batchId, repos: batchRepos, parsedFiles, label: `batch ${batchNumber}` });
      logStage(ctx, `${batchLabel} scan/parse/summarize`, scanStarted);
      // Each graph writer owns a bounded provider transaction. Lexical and
      // semantic staging remain outside it and are invisible in the pending
      // generation until the workspace visibility switch.
      let graphPipeline: GraphPipelineResult | undefined;
      let semanticWarning: string | undefined;
      graphPipeline = await runGraphPipeline({
        db,
        ctx,
        batchId,
        indexedAt,
        repos: batchRepos,
        parsedFiles,
        label: `batch ${batchNumber}/${repoBatches.length}`,
        stageLabel: batchLabel,
        selection: selectGraphWriter({ writeMode: ctx.writeMode, batchedFull: true, graphIsEmpty: graphIsEmpty && batchIndex === 0, provider: ctx.config.graph.provider })
      });
      lexicalProjectionDurationMs += graphPipeline.lexicalProjection.durationMs;
      lexicalWriteDurationMs += graphPipeline.lexicalWrite.durationMs;
      graphIsEmpty = false;
      semanticWarning = await runSemanticPipeline({ ctx, batchId, repos: batchRepos, parsedFiles, label: `batch ${batchNumber}/${repoBatches.length}` });
      await commitSucceededRepos({ db, ctx, repos: batchRepos, counts: perRepoCounts, batchId, indexedAt, summaryFailures, semanticWarning, graphPipeline });
      if (!graphPipeline) throw new Error(`Batch ${batchNumber} completed without a graph pipeline result.`);
      ctx.onGraphBatchStaged?.(batchId);

      log(ctx)(`${batchLabel} complete: repos=${batchRepos.length} filesScanned=${batchCounts.filesScanned} filesChanged=${batchCounts.filesChanged} duration=${((Date.now() - batchStarted) / 1000).toFixed(2)}s`);
    } catch (error) {
      if (ctx.schemaGeneration) {
        try {
          await db.failGraphWriteBatch({
            batchId,
            updatedAt: new Date().toISOString(),
            error: error instanceof Error ? error.message : String(error),
            completedStage: "workspace-generation-aborted",
            awaitingCleanup: true
          });
        } catch {}
      }
      await commitFailedRepos({ db, ctx, repos: batchRepos, counts: perRepoCounts, batchId, indexedAt, error });
      throw error;
    }
  }

  return { filesScanned, filesChanged, repos: indexedRepos, batchId: createBatchId("batched-full"), batchIds, lexicalProjectionDurationMs, lexicalWriteDurationMs };
}

export async function runFullCopyBulkIndex(input: {
  db: GraphDB;
  ctx: IndexRunContext;
  planning: IndexPlanningResult;
  options: IndexOptions;
  preparedRepos?: ReadonlyMap<string, PreparedRepoIndex>;
}): Promise<IndexPathResult> {
  const { db, ctx, planning, options, preparedRepos } = input;
  const batchId = createBatchId("bulk");
  const indexedAt = new Date().toISOString();
  let repos: RepoNode[] = [];
  let perRepoCounts: BatchCounts = new Map();
  try {
    const scanStarted = Date.now();
    const prepared = planning.repoConfigs
      .map((repoConfig) => preparedRepos?.get(toRepoNode(repoConfig, ctx.cwd).id))
      .filter((item): item is PreparedRepoIndex => Boolean(item));
    const scanParseResults = prepared.length === planning.repoConfigs.length
      ? prepared.map((item) => item.scanParse)
      : await scanParseRepos({ ctx, repoConfigs: planning.repoConfigs, options });
    repos = scanParseResults.map((result) => result.repo);
    const parsedFiles = scanParseResults.flatMap((result) => result.parsedFiles);
    const counts = sumCounts(scanParseResults);
    perRepoCounts = countsByRepo(scanParseResults);

    const summaryFailures = prepared.length === planning.repoConfigs.length
      ? new Map(prepared.flatMap((item) => item.summaryFailures ? [[item.repo.id, item.summaryFailures] as const] : []))
      : await runSummaryPipeline({ ctx, batchId, repos, parsedFiles, label: "all repos" });
    logStage(ctx, "Scan/parse/summarize", scanStarted);
    const lexicalReconcile = await resolveFullCopyLexicalReconcile(ctx);
    // Generation-scoped bulk writes are invisible until the final pointer
    // switch, so the workspace does not need one provider transaction here.
    let graphPipeline: GraphPipelineResult | undefined;
    let semanticWarning: string | undefined;
    let rebuilt = 0;
    graphPipeline = await runGraphPipeline({
      db,
      ctx,
      batchId,
      indexedAt,
      repos,
      parsedFiles,
      label: "bulk-copy",
      reconcileLexicalRepos: lexicalReconcile.reconcile,
      lexicalReconcileReason: lexicalReconcile.reason,
      selection: selectGraphWriter({ writeMode: ctx.writeMode, fullCopyBulk: true, provider: ctx.config.graph.provider })
    });
    semanticWarning = await runSemanticPipeline({ ctx, batchId, repos, parsedFiles, label: "all repos" });
    rebuilt = await runRelationRebuildPhase({ db, batchId: createBatchId("deps"), log: log(ctx), scope: pendingPublicGraphScope(ctx) });
    logStage(ctx, `Dependency rebuild (${rebuilt} edges)`, Date.now());
    await commitSucceededRepos({ db, ctx, repos, counts: perRepoCounts, batchId, indexedAt, summaryFailures, semanticWarning, graphPipeline });
    ctx.onGraphBatchStaged?.(batchId);
    return {
      ...counts,
      repos,
      batchId,
      batchIds: [batchId],
      lexicalProjectionDurationMs: graphPipeline?.lexicalProjection.durationMs ?? 0,
      lexicalWriteDurationMs: graphPipeline?.lexicalWrite.durationMs ?? 0
    };
  } catch (error) {
    if (ctx.schemaGeneration) {
      try {
        await db.failGraphWriteBatch({
          batchId,
          updatedAt: new Date().toISOString(),
          error: error instanceof Error ? error.message : String(error),
          completedStage: "workspace-generation-aborted",
          awaitingCleanup: true
        });
      } catch {}
    }
    await commitFailedRepos({ db, ctx, repos, counts: perRepoCounts, batchId, indexedAt, error });
    throw error;
  }
}

/**
 * Builds one workspace-wide incremental mutation after every repository has
 * completed concurrent scan/parse preparation. A single reconciliation view
 * is required so simultaneous cross-repo declaration changes and affected
 * roots are canonicalized together instead of against independent stale
 * catalogs.
 */
export async function prepareIncrementalWorkspaceIndex(input: {
  db: GraphDB;
  ctx: IndexRunContext;
  preparedRepos: readonly PreparedRepoIndex[];
}): Promise<IndexPathResult> {
  const { db, ctx, preparedRepos } = input;
  if (!ctx.incrementalMutationSet) {
    throw new Error("Workspace incremental preparation requires a reserved mutation set.");
  }
  const changed = preparedRepos.filter((prepared) =>
    prepared.scanParse.parsedFiles.length > 0 || prepared.scanParse.removedFileIds.length > 0);
  if (changed.length === 0) throw new Error("Workspace incremental preparation received no changed source.");
  const batchId = createBatchId("incremental-workspace");
  const indexedAt = new Date().toISOString();
  const repos = changed.map((prepared) => prepared.repo);
  const parsedFiles = changed.flatMap((prepared) => prepared.scanParse.parsedFiles);
  const activeFileIdsByRepo = new Map(changed.map((prepared) => [
    prepared.repo.id,
    prepared.scanParse.activeFileIds
  ]));
  const removedFileIdsByRepo = new Map(changed.map((prepared) => [
    prepared.repo.id,
    prepared.scanParse.removedFileIds
  ]));
  const graphPipeline = await runGraphPipeline({
    db,
    ctx,
    batchId,
    indexedAt,
    repos,
    parsedFiles,
    label: "incremental workspace",
    reconcileLexicalRepos: false,
    activeFileIdsByRepo,
    removedFileIds: [...removedFileIdsByRepo.values()].flat(),
    removedFileIdsByRepo,
    lexicalReconcileOnly: parsedFiles.length === 0,
    selection: selectGraphWriter({
      writeMode: ctx.writeMode,
      changedOnly: true,
      provider: ctx.config.graph.provider
    })
  });
  const semanticWarning = parsedFiles.length > 0
    ? await runSemanticPipeline({ ctx, batchId, repos, parsedFiles, label: "incremental workspace" })
    : undefined;
  for (const prepared of changed) {
    const repo = prepared.repo;
    ctx.pendingIndexStateCommits.set(repo.id, () => runIndexStateCommitPhase({
      db,
      repo,
      batchId,
      indexedAt,
      filesScanned: prepared.scanParse.filesScanned,
      filesChanged: prepared.scanParse.filesChanged,
      filesStale: ctx.incrementalMutationSet?.repoMutations[0]?.applied?.filesStaleByRepo.get(repo.id) ?? 0,
      status: "succeeded",
      summaryFailures: prepared.summaryFailures,
      semanticWarning,
      graphWriteAtomicity: ctx.incrementalMutationSet?.repoMutations[0]?.applied?.graphWrite.atomicityMode
        ?? graphPipeline.graphWrite.atomicityMode,
      graphWriteStatus: ctx.incrementalMutationSet?.repoMutations[0]?.applied?.graphWrite.journalStatus
        ?? graphPipeline.graphWrite.journalStatus,
      lexical: ctx.incrementalMutationSet?.repoMutations[0]?.applied?.lexicalWrite
        ?? graphPipeline.lexicalWrite,
      lexicalProjectionDurationMs: graphPipeline.lexicalProjection.durationMs
    }));
  }
  ctx.onGraphBatchStaged?.(batchId);
  return {
    filesScanned: preparedRepos.reduce((total, prepared) => total + prepared.scanParse.filesScanned, 0),
    filesChanged: changed.reduce((total, prepared) => total + prepared.scanParse.filesChanged, 0),
    repos,
    batchId,
    batchIds: [batchId],
    lexicalProjectionDurationMs: graphPipeline.lexicalProjection.durationMs,
    lexicalWriteDurationMs: 0
  };
}

export async function runPerRepoIndex(input: {
  db: GraphDB;
  ctx: IndexRunContext;
  repoConfig: AppConfig["repos"][number];
  options: IndexOptions;
  prepared?: PreparedRepoIndex;
}): Promise<IndexPathResult> {
  const { db, ctx, repoConfig, options } = input;
  const prepared = input.prepared ?? await prepareRepoIndex({ db, ctx, repoConfig, options });
  const { repo, batchId, indexedAt, scanParse, summaryFailures } = prepared;

  try {
    // Scanning, parsing, and summarization completed before staging writes.
    const parsedFiles = scanParse.parsedFiles;
    if (ctx.incrementalMutationSet && parsedFiles.length === 0 && scanParse.removedFileIds.length === 0) {
      return {
        filesScanned: scanParse.filesScanned,
        filesChanged: 0,
        repos: [repo],
        batchId,
        batchIds: [],
        lexicalProjectionDurationMs: 0,
        lexicalWriteDurationMs: 0
      };
    }

    // The graph mutation owns a bounded transaction. Lexical, semantic, and
    // stale writes target the same invisible pending generation and need no
    // compensation against the active snapshot.
    let semanticWarning: string | undefined;
    let graphPipeline: GraphPipelineResult | undefined;
    let filesStale = 0;
    graphPipeline = await runGraphPipeline({
      db,
      ctx,
      batchId,
      indexedAt,
      repos: [repo],
      parsedFiles,
      label: repo.name,
      repoName: repo.name,
      reconcileLexicalRepos: !options.changedOnly,
      activeFileIdsByRepo: ctx.incrementalMutationSet || options.changedOnly
        ? new Map([[repo.id, scanParse.activeFileIds]])
        : undefined,
      removedFileIds: scanParse.removedFileIds,
      removedFileIdsByRepo: new Map([[repo.id, scanParse.removedFileIds]]),
      lexicalReconcileOnly: Boolean(options.changedOnly && parsedFiles.length === 0),
      selection: selectGraphWriter({ writeMode: ctx.writeMode, changedOnly: options.changedOnly, provider: ctx.config.graph.provider })
    });
    if (parsedFiles.length > 0 || !options.changedOnly) {
      semanticWarning = await runSemanticPipeline({ ctx, batchId, repos: [repo], parsedFiles, label: repo.name, repoName: repo.name });
    }

    const staleStarted = Date.now();
    if (!ctx.incrementalMutationSet) {
      filesStale = await runStaleMarkPhase({ db, repo, activeFileIds: scanParse.activeFileIds, batchId, indexedAt, scope: pendingPublicGraphScope(ctx) });
      logStage(ctx, `Stale mark ${repo.name}`, staleStarted);
    }
    const commitIndexState = () => runIndexStateCommitPhase({
      db,
      repo,
      batchId,
      indexedAt,
      filesScanned: scanParse.filesScanned,
      filesChanged: parsedFiles.length,
      filesStale: ctx.incrementalMutationSet?.repoMutations.find((mutation) => mutation.batchId === batchId)
        ?.applied?.filesStaleByRepo.get(repo.id) ?? filesStale,
      status: "succeeded",
      summaryFailures,
      semanticWarning,
      graphWriteAtomicity: ctx.incrementalMutationSet?.repoMutations.find((mutation) => mutation.batchId === batchId)?.applied?.graphWrite.atomicityMode ?? graphPipeline?.graphWrite.atomicityMode,
      graphWriteStatus: ctx.incrementalMutationSet?.repoMutations.find((mutation) => mutation.batchId === batchId)?.applied?.graphWrite.journalStatus ?? graphPipeline?.graphWrite.journalStatus,
      lexical: ctx.incrementalMutationSet?.repoMutations.find((mutation) => mutation.batchId === batchId)?.applied?.lexicalWrite ?? graphPipeline?.lexicalWrite,
      lexicalProjectionDurationMs: graphPipeline?.lexicalProjection.durationMs
    });
    if (ctx.schemaGeneration) ctx.pendingIndexStateCommits.set(repo.id, commitIndexState);
    else await commitIndexState();
    ctx.onGraphBatchStaged?.(batchId);

  return {
    filesScanned: scanParse.filesScanned,
    filesChanged: scanParse.filesChanged,
    repos: [repo],
    batchId,
    batchIds: [batchId],
    lexicalProjectionDurationMs: graphPipeline?.lexicalProjection.durationMs ?? 0,
    lexicalWriteDurationMs: graphPipeline?.lexicalWrite.durationMs ?? 0
  };
  } catch (error) {
    const graphWriteFailure = getGraphWriteFailureDetails(error);
    // Generation-owned data is deleted after all concurrent staging jobs have
    // settled. Only callers without a generation write an immediate failure.
    if (ctx.schemaGeneration) {
      try {
        await db.failGraphWriteBatch({
          batchId,
          updatedAt: new Date().toISOString(),
          error: error instanceof Error ? error.message : String(error),
          completedStage: "workspace-generation-aborted",
          awaitingCleanup: true
        });
      } catch {}
    } else {
      await runIndexStateCommitPhase({
        db,
        repo,
        batchId,
        indexedAt,
        filesScanned: 0,
        filesChanged: 0,
        filesStale: 0,
        status: "failed",
        graphWriteAtomicity: graphWriteFailure?.graphWriteAtomicity,
        graphWriteStatus: graphWriteFailure?.graphWriteStatus,
        error
      });
    }
    throw error;
  }
}

/**
 * Applies one previously prepared repository delta. The caller owns the
 * provider-level workspace transaction and revision CAS; this function must
 * not scan, parse, clone a generation, or perform a repo-wide lexical
 * reconciliation.
 */
export async function applyIncrementalRepoMutation(input: {
  db: GraphDB;
  ctx: IndexRunContext;
  mutation: IncrementalRepoMutation;
  deferLexicalWrite?: boolean;
}): Promise<NonNullable<IncrementalRepoMutation["applied"]>> {
  const { db, ctx, mutation, deferLexicalWrite = false } = input;
  if (!ctx.incrementalMutationSet) throw new Error("Incremental apply requires a reserved mutation set.");
  const mutationSet = ctx.incrementalMutationSet;
  const scope = pendingPublicGraphScope(ctx);
  const store = new SchemaGenerationStore(db, ctx.workspaceId);
  let lexicalWrite: LexicalWriteResult | undefined;
  const lexicalStarted = Date.now();
  const graphWrite = await runGraphWritePhase({
    db,
    cwd: ctx.cwd,
    selection: mutation.selection,
    facts: mutation.publicGraph.facts,
    repos: [...mutation.repos],
    parsedFiles: [...mutation.parsedFiles],
    publicGraphReplacement: mutation.publicGraph.replacement,
    preparedSummaries: mutation.summaries.kind === "prepared"
      ? mutation.summaries.payload
      : undefined,
    config: ctx.config,
    llmSummaryLevel: ctx.llm.summaryLevel,
    openAiApiKey: ctx.llm.apiKey,
    openAiBaseUrl: ctx.llm.baseUrl,
    label: mutation.repos.map((repo) => repo.name).join(", "),
    repoName: mutation.repos.length === 1 ? mutation.repos[0]?.name : undefined,
    createProgressBar: createProgressBar(ctx),
    log: log(ctx),
    warn: warn(ctx),
    skipGraphWrite: mutation.publicGraph.replacement.sourceFileIds.length === 0,
    deferWorkspaceCommit: true,
    skipRecovery: true,
    parentGeneration: scope.generation,
    beforeWrite: async () => {
      await applyIncrementalSchemaMutation({
        db,
        store,
        workspaceId: ctx.workspaceId,
        generation: scope.generation,
        revision: mutationSet.nextRevision,
        mutation: mutation.schema
      });
    },
    lexical: {
      store: ctx.lexicalStore,
      workspaceId: ctx.workspaceId,
      write: async () => {
        if (deferLexicalWrite) return;
        await ctx.lexicalStore.applyIncrementalMutation({
          workspaceId: ctx.workspaceId,
          generation: scope.generation,
          expectedRevision: mutationSet.expectedActiveRevision,
          nextRevision: mutationSet.nextRevision,
          upsertDocuments: mutation.lexical.upsertDocuments,
          deleteDocumentIds: mutation.lexical.deleteDocumentIds
        });
        const providerHealth = await ctx.lexicalStore.health({
          ...scope,
          revision: mutationSet.nextRevision
        });
        lexicalWrite = {
          phase: "lexical-write",
          durationMs: Date.now() - lexicalStarted,
          documentCount: mutation.lexical.upsertDocuments.length,
          reconciledRepoIds: [],
          providerHealth,
          projectionSchemaVersion: providerHealth.projectionSchemaVersion,
          tokenizerVersion: providerHealth.tokenizerVersion,
          indexStatus: providerHealth.status,
          indexReasons: [...providerHealth.reasons]
        };
      }
    }
  });
  if (!deferLexicalWrite && !lexicalWrite) {
    throw new Error(`Incremental batch ${mutation.batchId} did not apply its lexical delta.`);
  }
  const filesStaleByRepo = new Map<string, number>();
  for (const repo of mutation.repos) {
    const prefix = `file:${repo.id}:`;
    filesStaleByRepo.set(repo.id, mutation.publicGraph.deletedFileIds.filter((fileId) => fileId.startsWith(prefix)).length);
  }
  const applied = { graphWrite, lexicalWrite, filesStaleByRepo };
  mutation.applied = applied;
  return applied;
}

export async function runDependencyRebuild(input: {
  db: GraphDB;
  ctx: IndexRunContext;
  repoIds?: string[];
}): Promise<number> {
  const { db, ctx, repoIds } = input;
  const rebuildStarted = Date.now();
  const rebuilt = await runRelationRebuildPhase({
    db,
    repoIds,
    batchId: createBatchId("deps"),
    log: log(ctx),
    scope: pendingPublicGraphScope(ctx)
  });
  logStage(ctx, "Dependency rebuild", rebuildStarted);
  return rebuilt;
}
