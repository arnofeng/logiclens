import { withTransaction, type GraphDB } from "../graph-model/db.js";
import type { AppConfig } from "../../config/schema.js";
import { runIndexQueue } from "./scheduler.js";
import { planIndexRun } from "./planning.js";
import { createIndexRunContext } from "./context.js";
import { applyIncrementalRepoMutation, prepareIncrementalWorkspaceIndex, prepareRepoIndex, runBatchedFullIndex, runDependencyRebuild, runFullCopyBulkIndex, runPerRepoIndex, type IndexCounters, type PreparedRepoIndex } from "./orchestrator.js";
import type { IndexLogger, IndexOptions, IndexResult } from "./types.js";
import { autoDetectAndRegisterPlugins } from "../plugins/register.js";
import { refreshSucceededIndexStateLexicalMetrics } from "./stateCommit.js";
import { runIndexStateCommitPhase } from "./stateCommit.js";
import { SchemaGenerationStore } from "../schema/generationStore.js";
import { createBatchId } from "../graph-model/batchWriter.js";
import { toRepoNode } from "../workspace/repoRegistry.js";

import { chunk } from "../../shared/chunk.js";
import {
  createIncrementalIndexMutationSet,
  buildCombinedIncrementalLexicalMutation,
  incrementalMutationIsEmpty,
  validateIncrementalIndexMutationSet
} from "./incrementalMutation.js";
import { validateIncrementalIndexMutationEndpoints } from "./incrementalValidation.js";
import { LEXICAL_PROJECTION_SCHEMA_VERSION } from "../retrieval/types.js";
import { SCHEMA_INDEX_VERSION } from "../schema/model.js";
import {
  applyIncrementalSchemaMutation,
  buildCombinedIncrementalSchemaVisibility,
  incrementalSchemaPublicGraphDelta
} from "../schema/staging.js";
import {
  applyIncrementalDependencyMutation,
  prepareIncrementalDependencyMutation
} from "../graph-model/rebuildRelations.js";
import {
  applyIncrementalSchemaSupportGc,
  prepareIncrementalSchemaSupportGc
} from "../schema/publicGraphGc.js";

function addCounters(target: IndexCounters, increment: IndexCounters): void {
  target.filesScanned += increment.filesScanned;
  target.filesChanged += increment.filesChanged;
}

function requireNonNegativeSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
  return value;
}

async function cleanupCommittedBatchJournals(input: {
  db: GraphDB;
  lexicalStore: Awaited<ReturnType<typeof createIndexRunContext>>["lexicalStore"];
  workspaceId: string;
  batchIds: readonly string[];
  logger: IndexLogger;
}): Promise<void> {
  for (const batchId of [...new Set(input.batchIds)].reverse()) {
    const cleanupErrors: string[] = [];
    try {
      await input.lexicalStore.commitBatch?.({ workspaceId: input.workspaceId, batchId });
    } catch (cleanupError) {
      const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      cleanupErrors.push(`lexical: ${message}`);
      input.logger.warn?.(`Committed lexical journal cleanup deferred for batch ${batchId}: ${message}`);
    }
    if (cleanupErrors.length === 0 && input.db.updateGraphWriteBatch) {
      try {
        await input.db.updateGraphWriteBatch({
          batchId,
          updatedAt: new Date().toISOString(),
          completedStage: "gc-complete"
        });
      } catch (cleanupError) {
        input.logger.warn?.(`Committed journal GC marker update deferred for batch ${batchId}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
      }
    }
  }
}

async function retryCommittedBatchJournalGc(input: {
  db: GraphDB;
  lexicalStore: Awaited<ReturnType<typeof createIndexRunContext>>["lexicalStore"];
  workspaceId: string;
  logger: IndexLogger;
}): Promise<void> {
  const rows = await input.db.query<{ batchId: string }>(
    "MATCH (b:GraphWriteBatch) WHERE b.workspaceId = $workspaceId AND b.status = 'committed' AND b.completedStage <> 'gc-complete' RETURN b.batchId AS batchId;",
    { workspaceId: input.workspaceId }
  );
  await cleanupCommittedBatchJournals({ ...input, batchIds: rows.map((row) => row.batchId) });
}

async function recoverAbandonedGenerationBatches(input: {
  db: GraphDB;
  lexicalStore: Awaited<ReturnType<typeof createIndexRunContext>>["lexicalStore"];
  workspaceId: string;
  generation: string;
  logger: IndexLogger;
}): Promise<void> {
  const recovered = await input.db.recoverIncompleteGraphWriteBatches({
    workspaceId: input.workspaceId,
    generation: input.generation,
    updatedAt: new Date().toISOString(),
    cleanupBatch: async (journal) => {
      await input.lexicalStore.deleteGeneration({
        workspaceId: journal.workspaceId,
        generation: journal.generation
      });
      await input.lexicalStore.cleanupBatch({
        workspaceId: journal.workspaceId,
        batchId: journal.batchId
      });
    }
  });
  for (const journal of recovered) {
    input.logger.warn?.(
      `Recovered abandoned workspace generation batch ${journal.batchId} (${journal.generation}).`
    );
  }
}

export async function runIndexing(
  db: GraphDB,
  config: AppConfig,
  options: IndexOptions & { cwd?: string; logger?: IndexLogger }
): Promise<IndexResult> {
  const started = Date.now();
  const cwd = options.cwd ?? process.cwd();
  const logger = options.logger ?? {};
  const setupStarted = Date.now();
  const planning = await planIndexRun({ db, config, options });
  const pluginBootstrap = await autoDetectAndRegisterPlugins({
    config,
    cwd,
    repoConfigs: planning.repoConfigs,
    warn: (message) => logger.warn?.(message),
    log: (message) => logger.log?.(message)
  });
  const ctx = await createIndexRunContext({
    db,
    cwd,
    config,
    options,
    logger,
    writeMode: planning.writeMode,
    additionalIndexFilesByRepo: pluginBootstrap.additionalIndexFilesByRepo,
    activePluginSourceGlobsByRepo: pluginBootstrap.activePluginSourceGlobsByRepo
  });
  ctx.pendingIndexStateCommits ??= new Map();
  ctx.activeGeneration = planning.activeGeneration;
  ctx.activeRevision = planning.activeRevision;
  ctx.publicationMode = planning.publicationMode;
  const schemaGenerations = new SchemaGenerationStore(db, ctx.workspaceId);
  if (options.changedOnly) await schemaGenerations.assertIncrementalCompatible("changed-only");
  await retryCommittedBatchJournalGc({ db, lexicalStore: ctx.lexicalStore, workspaceId: ctx.workspaceId, logger });
  const expiredReservation = await schemaGenerations.recoverExpiredReservation();
  if (expiredReservation) {
    const reservationId = expiredReservation.kind === "full"
      ? expiredReservation.generation
      : expiredReservation.revision;
    logger.warn?.(`Recovered expired workspace ${expiredReservation.kind} reservation ${reservationId}.`);
  }
  const reservation = await schemaGenerations.reservation();
  if (reservation) {
    throw new Error(
      `Workspace ${ctx.workspaceId} is already staging generation ${reservation.generation} until ${reservation.leaseUntil ?? "an unknown time"}; ` +
      "refusing concurrent recovery or indexing so an in-flight pending generation cannot be deleted."
    );
  }
  const supersededGenerationGc = await schemaGenerations.supersededGenerations();
  const recoverableGenerations = [...new Set(
    await schemaGenerations.abortingGenerations()
  )].sort();
  for (const pendingGeneration of recoverableGenerations) {
    const cleanupErrors: string[] = [];
    try {
      await recoverAbandonedGenerationBatches({
        db,
        lexicalStore: ctx.lexicalStore,
        workspaceId: ctx.workspaceId,
        generation: pendingGeneration,
        logger
      });
    } catch (error) {
      cleanupErrors.push(`journal: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      await ctx.lexicalStore.deleteGeneration({ workspaceId: ctx.workspaceId, generation: pendingGeneration });
    } catch (error) {
      cleanupErrors.push(`lexical: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      await db.deletePublicGraphGeneration({ workspaceId: ctx.workspaceId, generation: pendingGeneration });
    } catch (error) {
      cleanupErrors.push(`graph: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (cleanupErrors.length > 0) {
      logger.warn?.(`Deferred orphan pending generation cleanup ${pendingGeneration}: ${cleanupErrors.join("; ")}`);
      continue;
    }
    try {
      await schemaGenerations.rollback(pendingGeneration);
      logger.warn?.(`Recovered orphan pending workspace generation ${pendingGeneration}.`);
    } catch (error) {
      logger.warn?.(`Deferred orphan pending generation cleanup ${pendingGeneration}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const generation = createBatchId(`schema-generation:${ctx.workspaceId}`);
  ctx.schemaGeneration = generation;
  const stagedBatchIds: string[] = [];
  ctx.onGraphBatchStaged = (batchId) => stagedBatchIds.push(batchId);
  let generationBegun = false;
  let workspaceCommitted = false;
  let leaseHeartbeat: ReturnType<typeof setInterval> | undefined;
  let leaseHeartbeatWork: Promise<void> = Promise.resolve();
  const startLeaseHeartbeat = (): void => {
    leaseHeartbeat = setInterval(() => {
      leaseHeartbeatWork = leaseHeartbeatWork
        .then(() => schemaGenerations.renewLease(generation))
        .catch((error) => {
          try {
            logger.warn?.(`Schema generation lease heartbeat deferred: ${error instanceof Error ? error.message : String(error)}`);
          } catch {}
        });
    }, 30_000);
    leaseHeartbeat.unref?.();
  };
  const stopLeaseHeartbeat = async (): Promise<void> => {
    if (leaseHeartbeat) clearInterval(leaseHeartbeat);
    leaseHeartbeat = undefined;
    await leaseHeartbeatWork;
  };
  try {
    const preparedRepos = new Map<string, PreparedRepoIndex>();
    const preparationJobs = await runIndexQueue(
      planning.repoConfigs,
      { concurrency: config.indexing.concurrency, retries: 1 },
      async (repoConfig) => {
        const prepared = await prepareRepoIndex({ db, ctx, repoConfig, options });
        preparedRepos.set(prepared.repo.id, prepared);
      },
      (repoConfig) => `prepare:${repoConfig.name}`
    );
    const failedPreparation = preparationJobs.filter((job) => job.status === "failed");
    if (failedPreparation.length > 0) {
      throw new Error(`Index preparation failed: ${failedPreparation.map((job) => `${job.id}: ${job.error ?? "unknown error"}`).join("; ")}`);
    }
    logger.log?.(`Index preparation complete: repos=${preparedRepos.size} concurrency=${config.indexing.concurrency}`);

    const preparedValues = [...preparedRepos.values()];
    const preparedTotals = preparedValues.reduce<IndexCounters>((totals, prepared) => {
      totals.filesScanned += prepared.scanParse.filesScanned;
      totals.filesChanged += prepared.scanParse.filesChanged;
      return totals;
    }, { filesScanned: 0, filesChanged: 0 });
    const hasIncrementalMutation = preparedValues.some((prepared) =>
      prepared.scanParse.parsedFiles.length > 0 || prepared.scanParse.removedFileIds.length > 0);
    if (planning.publicationMode === "incremental" && !hasIncrementalMutation) {
      if (!planning.activeGeneration) {
        throw new Error("Incremental indexing requires an active physical generation.");
      }
      const scope = { workspaceId: ctx.workspaceId, generation: planning.activeGeneration };
      const [storedStats, lexicalHealth] = await Promise.all([
        db.readPublicGraphStats(scope),
        ctx.lexicalStore.health({ ...scope, revision: planning.activeRevision })
      ]);
      if (!storedStats) {
        throw new Error(
          "Public graph stats metadata is missing for incremental indexing; " +
          "clean generated graph/internal/lexical artifacts and run a full reindex."
        );
      }
      if (storedStats.revision !== planning.activeRevision) {
        throw new Error(
          `Public graph stats revision ${storedStats.revision} does not match active revision ${planning.activeRevision ?? "missing"}; ` +
          "clean generated graph/internal/lexical artifacts and run a full reindex."
        );
      }
      if (lexicalHealth.status !== "healthy") {
        throw new Error(
          `Lexical index is unhealthy at active revision ${planning.activeRevision ?? "missing"}` +
          `${lexicalHealth.reasons.length > 0 ? ` (${lexicalHealth.reasons.join(", ")})` : ""}; ` +
          "clean generated graph/internal/lexical artifacts and run a full reindex."
        );
      }
      const stats = storedStats;
      logger.log?.(`Incremental indexing is a no-op: scanned=${preparedTotals.filesScanned} changed=0 graphWrites=0 lexicalWrites=0`);
      return {
        filesScanned: preparedTotals.filesScanned,
        filesChanged: 0,
        codeNodes: stats.codeNodes,
        sectionNodes: stats.sectionNodes,
        callEdges: stats.callEdges,
        importEdges: stats.importEdges,
        entities: stats.entities,
        durationMs: Date.now() - started,
        lexicalDocumentCount: lexicalHealth.metrics.documentCount,
        lexicalIndexSizeBytes: lexicalHealth.metrics.indexSizeBytes,
        lexicalProjectionSchemaVersion: lexicalHealth.projectionSchemaVersion,
        lexicalTokenizerVersion: lexicalHealth.tokenizerVersion,
        lexicalIndexStatus: lexicalHealth.status,
        lexicalProjectionDurationMs: 0,
        lexicalWriteDurationMs: 0
      };
    }

    if (planning.publicationMode === "incremental") {
      await schemaGenerations.reserveIncremental({
        revision: generation,
        expectedActiveGeneration: planning.activeGeneration ?? "",
        expectedActiveRevision: planning.activeRevision ?? ""
      });
    } else {
      await schemaGenerations.beginFull({
        generation,
        createdAt: new Date(started).toISOString(),
        expectedActiveGeneration: planning.activeGeneration ?? null,
        expectedActiveRevision: planning.activeRevision ?? null
      });
    }
    generationBegun = true;
    startLeaseHeartbeat();
    if (planning.publicationMode === "incremental") {
      if (!planning.activeGeneration || !planning.activeRevision) {
        throw new Error("Incremental indexing requires an active generation and revision.");
      }
      ctx.targetGeneration = planning.activeGeneration;
      ctx.incrementalMutationSet = createIncrementalIndexMutationSet({
        workspaceId: ctx.workspaceId,
        targetGeneration: planning.activeGeneration,
        expectedActiveRevision: planning.activeRevision,
        nextRevision: generation
      });
    } else {
      ctx.targetGeneration = generation;
      // Full publication starts with an empty physical generation. Passing no
      // parent initializes lexical metadata without reading or copying the
      // active document corpus.
      await ctx.lexicalStore.initializeGeneration({ workspaceId: ctx.workspaceId, generation });
    }
    logger.log?.(`Index setup: ${((Date.now() - setupStarted) / 1000).toFixed(2)}s`);
    const totals: IndexCounters = { filesScanned: 0, filesChanged: 0 };
    let lexicalProjectionDurationMs = 0;
    let lexicalWriteDurationMs = 0;
    const successfulRepoIds: string[] = [];

    // The command layer now only chooses the indexing route and aggregates the
    // public IndexResult. Scanning, parsing, graph writes, semantic writes, stale
    // marking, and state commits live behind phase orchestration helpers.
    if (planning.runPath === "batched-full") {
      if (planning.writeMode !== "auto" && planning.writeMode !== "bulk") {
        throw new Error("Batched full indexing supports write modes auto or bulk. Omit --batch-size to use merge or bulk-upsert.");
      }
      const repoBatches = chunk(planning.repoConfigs, planning.batchSize);
      const result = await runBatchedFullIndex({
        db,
        ctx,
        repoBatches,
        options: { ...options, batchSize: planning.batchSize },
        initialRepoCount: planning.initialRepoCount,
        preparedRepos
      });
      addCounters(totals, result);
      lexicalProjectionDurationMs += result.lexicalProjectionDurationMs;
      lexicalWriteDurationMs += result.lexicalWriteDurationMs;
      successfulRepoIds.push(...result.repos.map((repo) => repo.id));
      stagedBatchIds.push(...result.batchIds ?? [result.batchId]);
      const rebuildStarted = Date.now();
      await runDependencyRebuild({ db, ctx });
      const dependencyRebuildMs = Date.now() - rebuildStarted;
      logger.log?.(`Batched indexing complete: batches=${repoBatches.length} filesScanned=${totals.filesScanned} filesChanged=${totals.filesChanged} dependencyRebuild=${(dependencyRebuildMs / 1000).toFixed(2)}s total=${((Date.now() - started) / 1000).toFixed(2)}s`);
    } else if (planning.runPath === "full-copy-bulk") {
      if (options.changedOnly) throw new Error("Bulk write mode currently supports full empty-graph imports only; use merge mode for --changed-only.");
      const result = await runFullCopyBulkIndex({ db, ctx, planning, options, preparedRepos });
      addCounters(totals, result);
      lexicalProjectionDurationMs += result.lexicalProjectionDurationMs;
      lexicalWriteDurationMs += result.lexicalWriteDurationMs;
      successfulRepoIds.push(...result.repos.map((repo) => repo.id));
      stagedBatchIds.push(...result.batchIds ?? [result.batchId]);
    } else {
      const indexedRepoIds: string[] = [];
      if (ctx.incrementalMutationSet) {
        const result = await prepareIncrementalWorkspaceIndex({
          db,
          ctx,
          preparedRepos: [...preparedRepos.values()]
        });
        addCounters(totals, result);
        lexicalProjectionDurationMs += result.lexicalProjectionDurationMs;
        indexedRepoIds.push(...result.repos.map((repo) => repo.id));
        successfulRepoIds.push(...result.repos.map((repo) => repo.id));
        stagedBatchIds.push(...result.batchIds ?? [result.batchId]);
      } else {
        const writeJobs = await runIndexQueue(
          planning.repoConfigs,
          { concurrency: config.indexing.concurrency, retries: 1 },
          async (repoConfig) => {
            const repo = toRepoNode(repoConfig, cwd);
            const prepared = preparedRepos.get(repo.id);
            if (!prepared) throw new Error(`Missing prepared index facts for ${repoConfig.name}.`);
            const result = await runPerRepoIndex({ db, ctx, repoConfig, options, prepared });
            addCounters(totals, result);
            lexicalProjectionDurationMs += result.lexicalProjectionDurationMs;
            lexicalWriteDurationMs += result.lexicalWriteDurationMs;
            indexedRepoIds.push(...result.repos.map((repo) => repo.id));
            successfulRepoIds.push(...result.repos.map((repo) => repo.id));
            stagedBatchIds.push(...result.batchIds ?? [result.batchId]);
          },
          (repoConfig) => `stage:${repoConfig.name}`
        );
        const failedWrites = writeJobs.filter((job) => job.status === "failed");
        if (failedWrites.length > 0) {
          throw new Error(`Index staging failed: ${failedWrites.map((job) => `${job.id}: ${job.error ?? "unknown error"}`).join("; ")}`);
        }
        await runDependencyRebuild({ db, ctx, repoIds: options.repo ? indexedRepoIds : undefined });
      }
    }

    if (ctx.incrementalMutationSet) {
      ctx.incrementalMutationSet.schemaVisibility = await buildCombinedIncrementalSchemaVisibility({
        store: schemaGenerations,
        generation: ctx.incrementalMutationSet.targetGeneration,
        mutations: ctx.incrementalMutationSet.repoMutations.map((mutation) => mutation.schema)
      });
      const schemaDelta = incrementalSchemaPublicGraphDelta(ctx.incrementalMutationSet.schemaVisibility);
      const replacements = ctx.incrementalMutationSet.repoMutations.map((mutation) => mutation.publicGraph.replacement);
      ctx.incrementalMutationSet.schemaSupportGc = await prepareIncrementalSchemaSupportGc({
        db,
        scope: {
          workspaceId: ctx.workspaceId,
          generation: ctx.incrementalMutationSet.targetGeneration
        },
        schemaDelta,
        graphFacts: ctx.incrementalMutationSet.repoMutations.map((mutation) => mutation.publicGraph.facts),
        replacedSourceFileIds: replacements.flatMap((replacement) => replacement.sourceFileIds),
        alreadyDeletedEvidenceIds: replacements.flatMap((replacement) => replacement.staleEvidenceIds),
        alreadyDeletedContractIds: replacements.flatMap((replacement) => replacement.orphanContractIds),
        alreadyDeletedEntityIds: replacements.flatMap((replacement) => replacement.orphanEntityIds)
      });
      const statsDelta = ctx.incrementalMutationSet.publicGraphStatsDelta;
      if (!statsDelta) throw new Error("Incremental mutation is missing its prepared public graph stats delta.");
      const nextEntityDelta = statsDelta.entities - ctx.incrementalMutationSet.schemaSupportGc.entityIds.length;
      if (!Number.isSafeInteger(nextEntityDelta)) {
        throw new Error("Incremental schema support GC produced an unsafe public graph entity delta.");
      }
      ctx.incrementalMutationSet.publicGraphStatsDelta = { ...statsDelta, entities: nextEntityDelta };
      ctx.incrementalMutationSet.dependencyMutation = await prepareIncrementalDependencyMutation(db, {
        scope: {
          workspaceId: ctx.workspaceId,
          generation: ctx.incrementalMutationSet.targetGeneration
        },
        batchId: createBatchId("deps"),
        affectedFileIds: ctx.incrementalMutationSet.repoMutations.flatMap((mutation) => [
          ...mutation.publicGraph.touchedFileIds,
          ...mutation.publicGraph.deletedFileIds
        ]),
        graphFacts: ctx.incrementalMutationSet.repoMutations.map((mutation) => mutation.publicGraph.facts),
        schema: schemaDelta
      });
      ctx.incrementalMutationSet.lexicalMutation = buildCombinedIncrementalLexicalMutation(
        ctx.incrementalMutationSet
      );
    }

    // Compatibility metadata advances only after every prepared delta and the
    // cross-repo relation rebuild have succeeded. Incremental publication
    // applies all provider writes to the active physical generation in one
    // guarded transaction; full publication only switches the pending snapshot.
    const finalizationStarted = Date.now();
    await stopLeaseHeartbeat();
    await schemaGenerations.renewLease(generation);

    let stats: Awaited<ReturnType<GraphDB["stats"]>>;
    let lexicalHealth: Awaited<ReturnType<typeof ctx.lexicalStore.health>>;
    let lexicalDocumentCount: number;
    let lexicalIndexSizeBytes: number;

    if (planning.publicationMode === "incremental") {
      const mutationSet = ctx.incrementalMutationSet;
      if (!mutationSet || incrementalMutationIsEmpty(mutationSet)) {
        throw new Error("Incremental publication has no prepared mutation set.");
      }
      validateIncrementalIndexMutationSet(mutationSet);
      await validateIncrementalIndexMutationEndpoints(db, mutationSet);
      const committed = await db.applyIncrementalIndexMutation({
        workspaceId: ctx.workspaceId,
        expectedActiveGeneration: mutationSet.targetGeneration,
        expectedActiveRevision: mutationSet.expectedActiveRevision,
        nextRevision: mutationSet.nextRevision,
        schemaIndexVersion: SCHEMA_INDEX_VERSION,
        lexicalProjectionVersion: LEXICAL_PROJECTION_SCHEMA_VERSION
      }, async () => {
        for (const mutation of mutationSet.repoMutations) {
          await applyIncrementalRepoMutation({ db, ctx, mutation, deferLexicalWrite: true });
        }
        await applyIncrementalSchemaMutation({
          db,
          store: schemaGenerations,
          workspaceId: ctx.workspaceId,
          generation: mutationSet.targetGeneration,
          revision: mutationSet.nextRevision,
          mutation: mutationSet.schemaVisibility!
        });
        await applyIncrementalSchemaSupportGc({
          db,
          scope: {
            workspaceId: ctx.workspaceId,
            generation: mutationSet.targetGeneration
          },
          plan: mutationSet.schemaSupportGc!
        });
        const lexicalMutationStarted = Date.now();
        await ctx.lexicalStore.applyIncrementalMutation({
          workspaceId: ctx.workspaceId,
          generation: mutationSet.targetGeneration,
          expectedRevision: mutationSet.expectedActiveRevision,
          nextRevision: mutationSet.nextRevision,
          upsertDocuments: mutationSet.lexicalMutation!.upsertDocuments,
          deleteDocumentIds: mutationSet.lexicalMutation!.deleteDocumentIds
        });
        lexicalWriteDurationMs += Date.now() - lexicalMutationStarted;
        const lexicalAfterMutation = await ctx.lexicalStore.health({
          workspaceId: ctx.workspaceId,
          generation: mutationSet.targetGeneration,
          revision: mutationSet.nextRevision
        });
        for (const mutation of mutationSet.repoMutations) {
          if (!mutation.applied) throw new Error(`Incremental batch ${mutation.batchId} was not applied.`);
          mutation.applied.lexicalWrite = {
            phase: "lexical-write",
            durationMs: lexicalWriteDurationMs,
            documentCount: mutationSet.lexicalMutation!.upsertDocuments.length,
            reconciledRepoIds: [],
            providerHealth: lexicalAfterMutation,
            projectionSchemaVersion: lexicalAfterMutation.projectionSchemaVersion,
            tokenizerVersion: lexicalAfterMutation.tokenizerVersion,
            indexStatus: lexicalAfterMutation.status,
            indexReasons: [...lexicalAfterMutation.reasons]
          };
        }
        await applyIncrementalDependencyMutation(db, {
          scope: {
            workspaceId: ctx.workspaceId,
            generation: mutationSet.targetGeneration
          },
          mutation: mutationSet.dependencyMutation!
        });
        const committedStats = await db.applyPublicGraphStatsDelta({
          workspaceId: ctx.workspaceId,
          generation: mutationSet.targetGeneration
        }, {
          expectedRevision: mutationSet.expectedActiveRevision,
          nextRevision: mutationSet.nextRevision,
          delta: mutationSet.publicGraphStatsDelta!
        });
        const committedLexicalHealth = await ctx.lexicalStore.health({
          workspaceId: ctx.workspaceId,
          generation: mutationSet.targetGeneration,
          revision: mutationSet.nextRevision
        });
        const committedDocumentCount = requireNonNegativeSafeInteger(
          committedLexicalHealth.metrics.documentCount,
          "Lexical document count"
        );
        const committedIndexSizeBytes = requireNonNegativeSafeInteger(
          committedLexicalHealth.metrics.indexSizeBytes,
          "Lexical index size in bytes"
        );
        for (const [, commitIndexState] of [...ctx.pendingIndexStateCommits.entries()]
          .sort(([left], [right]) => left.localeCompare(right))) {
          await commitIndexState();
        }
        await refreshSucceededIndexStateLexicalMetrics({
          db,
          repoIds: successfulRepoIds,
          lexicalDocumentCount: committedDocumentCount,
          lexicalIndexSizeBytes: committedIndexSizeBytes,
          lexicalProjectionSchemaVersion: committedLexicalHealth.projectionSchemaVersion,
          lexicalTokenizerVersion: committedLexicalHealth.tokenizerVersion,
          lexicalIndexStatus: committedLexicalHealth.status,
          lexicalProjectionDurationMs,
          lexicalWriteDurationMs
        });
        for (const batchId of [...new Set(stagedBatchIds)]) {
          await db.commitGraphWriteBatch({
            batchId,
            updatedAt: new Date().toISOString(),
            completedStage: "workspace-committed"
          });
        }
        return {
          stats: committedStats,
          lexicalHealth: committedLexicalHealth,
          lexicalDocumentCount: committedDocumentCount,
          lexicalIndexSizeBytes: committedIndexSizeBytes
        };
      });
      stats = committed.stats;
      lexicalHealth = committed.lexicalHealth;
      lexicalDocumentCount = committed.lexicalDocumentCount;
      lexicalIndexSizeBytes = committed.lexicalIndexSizeBytes;
    } else {
      stats = await db.computePublicGraphStats({ workspaceId: ctx.workspaceId, generation });
      const committed = await withTransaction(db, async () => {
        await schemaGenerations.validateFull(generation);
        await ctx.lexicalStore.commitVersions();
        const committedLexicalHealth = await ctx.lexicalStore.pendingHealth({
          workspaceId: ctx.workspaceId,
          generation
        });
        const committedDocumentCount = requireNonNegativeSafeInteger(
          committedLexicalHealth.metrics.documentCount,
          "Lexical document count"
        );
        const committedIndexSizeBytes = requireNonNegativeSafeInteger(
          committedLexicalHealth.metrics.indexSizeBytes,
          "Lexical index size in bytes"
        );
        for (const [, commitIndexState] of [...ctx.pendingIndexStateCommits.entries()]
          .sort(([left], [right]) => left.localeCompare(right))) {
          await commitIndexState();
        }
        await refreshSucceededIndexStateLexicalMetrics({
          db,
          repoIds: successfulRepoIds,
          lexicalDocumentCount: committedDocumentCount,
          lexicalIndexSizeBytes: committedIndexSizeBytes,
          lexicalProjectionSchemaVersion: committedLexicalHealth.projectionSchemaVersion,
          lexicalTokenizerVersion: committedLexicalHealth.tokenizerVersion,
          lexicalIndexStatus: committedLexicalHealth.status,
          lexicalProjectionDurationMs,
          lexicalWriteDurationMs
        });
        for (const batchId of [...new Set(stagedBatchIds)]) {
          await db.commitGraphWriteBatch({
            batchId,
            updatedAt: new Date().toISOString(),
            completedStage: "workspace-committed"
          });
        }
        await db.initializePublicGraphStats(
          { workspaceId: ctx.workspaceId, generation },
          generation,
          stats
        );
        await schemaGenerations.commitFull(generation);
        return {
          lexicalHealth: committedLexicalHealth,
          lexicalDocumentCount: committedDocumentCount,
          lexicalIndexSizeBytes: committedIndexSizeBytes
        };
      });
      lexicalHealth = committed.lexicalHealth;
      lexicalDocumentCount = committed.lexicalDocumentCount;
      lexicalIndexSizeBytes = committed.lexicalIndexSizeBytes;
    }
    workspaceCommitted = true;
    await cleanupCommittedBatchJournals({
      db,
      lexicalStore: ctx.lexicalStore,
      workspaceId: ctx.workspaceId,
      batchIds: stagedBatchIds,
      logger
    });
    for (const supersededGeneration of supersededGenerationGc) {
      try {
        await ctx.lexicalStore.deleteGeneration({ workspaceId: ctx.workspaceId, generation: supersededGeneration });
        await db.deletePublicGraphGeneration({ workspaceId: ctx.workspaceId, generation: supersededGeneration });
        await schemaGenerations.rollback(supersededGeneration);
      } catch (cleanupError) {
        logger.warn?.(
          `Superseded generation GC deferred for ${supersededGeneration}: ` +
          `${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`
        );
      }
    }
    logger.log?.(`Index finalization: ${((Date.now() - finalizationStarted) / 1000).toFixed(2)}s`);
    return {
      filesScanned: totals.filesScanned,
      filesChanged: totals.filesChanged,
      codeNodes: stats.codeNodes,
      sectionNodes: stats.sectionNodes,
      callEdges: stats.callEdges,
      importEdges: stats.importEdges,
      entities: stats.entities,
      durationMs: Date.now() - started,
      lexicalDocumentCount,
      lexicalIndexSizeBytes,
      lexicalProjectionSchemaVersion: lexicalHealth.projectionSchemaVersion,
      lexicalTokenizerVersion: lexicalHealth.tokenizerVersion,
      lexicalIndexStatus: lexicalHealth.status,
      lexicalProjectionDurationMs,
      lexicalWriteDurationMs
    };
  } catch (error) {
    await stopLeaseHeartbeat();
    // Once the final visibility-switch transaction has committed, every
    // remaining operation is journal GC or result reporting. Never compensate
    // a committed generation: cleanup is idempotent and retried on the next run.
    if (!workspaceCommitted && generationBegun) {
      try {
        workspaceCommitted = planning.publicationMode === "incremental"
          ? await schemaGenerations.activeRevision() === generation
          : await schemaGenerations.activeGeneration() === generation;
      } catch {
        // A lost commit acknowledgement is indistinguishable from a failed
        // commit while the provider is unavailable. Preserve every journal and
        // let the next run inspect the active pointer before choosing recovery.
        throw error;
      }
    }
    if (workspaceCommitted) throw error;
    // Incremental journals are created inside the provider transaction and
    // therefore disappear with a failed commit. Persisting compensating
    // journals against the active physical generation would make recovery
    // mistake active data for an abandoned snapshot.
    if (planning.publicationMode === "full-snapshot") {
      for (const batchId of [...new Set(stagedBatchIds)].reverse()) {
        try {
          await db.failGraphWriteBatch({
            batchId,
            updatedAt: new Date().toISOString(),
            error: error instanceof Error ? error.message : String(error),
            completedStage: "workspace-generation-aborted"
          });
        } catch {}
      }
    }
    if (generationBegun) {
      const cleanupErrors: string[] = [];
      if (planning.publicationMode === "incremental") {
        try {
          await schemaGenerations.abandonIncremental(generation);
        } catch (cleanupError) {
          cleanupErrors.push(`revision: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
        }
      } else {
        let safeToDelete = false;
        try {
          await schemaGenerations.abandonFull(generation);
          safeToDelete = true;
        } catch (cleanupError) {
          cleanupErrors.push(`reservation: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
        }
        try {
          if (!safeToDelete) throw new Error("generation reservation was not released");
          await ctx.lexicalStore.deleteGeneration({ workspaceId: ctx.workspaceId, generation });
        } catch (cleanupError) {
          cleanupErrors.push(`lexical: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
        }
        try {
          if (!safeToDelete) throw new Error("generation reservation was not released");
          await db.deletePublicGraphGeneration({ workspaceId: ctx.workspaceId, generation });
        } catch (cleanupError) {
          cleanupErrors.push(`graph: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
        }
        if (cleanupErrors.length === 0) {
          try {
            await schemaGenerations.rollback(generation);
          } catch (cleanupError) {
            cleanupErrors.push(`internal: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
          }
        }
      }
      if (cleanupErrors.length > 0) {
        logger.warn?.(`Pending generation cleanup deferred for ${generation}: ${cleanupErrors.join("; ")}`);
      }
    }
    const failureBatchId = createBatchId("generation-failed");
    const failedAt = new Date().toISOString();
    for (const repoConfig of planning.repoConfigs) {
      try {
        await runIndexStateCommitPhase({
          db,
          repo: toRepoNode(repoConfig, cwd),
          batchId: failureBatchId,
          indexedAt: failedAt,
          filesScanned: 0,
          filesChanged: 0,
          filesStale: 0,
          status: "failed",
          error
        });
      } catch {}
    }
    throw error;
  }
}

/**
 * Decides which target repos must be refused because a full (non-incremental)
 * index would rebuild already-indexed data. A full re-index of an existing repo
 * is the slow per-repo append-copy path and can leave orphaned shared nodes
 * behind, so callers should prefer --changed-only or a clean graph rebuild.
 *
 * Returns the names of targeted repos that are already indexed. An empty array
 * means the run is allowed (new repos, or --changed-only runs).
 */
export function findBlockedReindexTargets(input: {
  changedOnly?: boolean;
  repo?: string;
  configuredRepoNames: string[];
  indexedRepoNames: string[];
}): string[] {
  if (input.changedOnly) return [];
  const indexed = new Set(input.indexedRepoNames);
  const targets = input.repo ? [input.repo] : input.configuredRepoNames;
  return targets.filter((name) => indexed.has(name));
}
