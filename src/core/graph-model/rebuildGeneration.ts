import { createBatchId } from "./batchWriter.js";
import { type GraphDB } from "./db.js";
import type { PublicGraphGenerationScope } from "./publicGraphGeneration.js";
import {
  rebuildRepoDependencies,
  type RebuildRepoDependenciesLogger
} from "./rebuildRelations.js";
import type { RepoDependencyEdge } from "../parsing/types.js";
import { SchemaGenerationStore } from "../schema/generationStore.js";
import { SCHEMA_INDEX_VERSION } from "../schema/model.js";

export type GenerationSafeRelationRebuildLogger = RebuildRepoDependenciesLogger & {
  warn?: (message: string) => void;
};

export type RelationRebuildOperation = (
  scope: PublicGraphGenerationScope
) => Promise<RepoDependencyEdge[]>;

export type GenerationSafeRelationRebuildInput = {
  db: GraphDB;
  workspaceId: string;
  repoIds?: string[];
  logger?: GenerationSafeRelationRebuildLogger;
};

type GenerationCleanupInput = Pick<
  GenerationSafeRelationRebuildInput,
  "db" | "workspaceId" | "logger"
> & {
  generations: SchemaGenerationStore;
  generation: string;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function cleanupInactiveGeneration(input: GenerationCleanupInput): Promise<string[]> {
  const errors: string[] = [];
  let reservationReleased = false;
  try {
    await input.generations.abandonFull(input.generation);
    reservationReleased = true;
  } catch (error) {
    errors.push(`reservation: ${errorMessage(error)}`);
  }

  if (!reservationReleased) return errors;

  try {
    await input.db.deletePublicGraphGeneration({
      workspaceId: input.workspaceId,
      generation: input.generation
    });
  } catch (error) {
    errors.push(`graph: ${errorMessage(error)}`);
  }

  if (errors.length === 0) {
    try {
      await input.generations.rollback(input.generation);
    } catch (error) {
      errors.push(`internal: ${errorMessage(error)}`);
    }
  }
  return errors;
}

async function cleanupWithRetryMarker(input: GenerationCleanupInput): Promise<void> {
  const errors = await cleanupInactiveGeneration(input);
  if (errors.length > 0) {
    try {
      input.logger?.warn?.(
        `Generation cleanup deferred for ${input.generation}: ${errors.join("; ")}`
      );
    } catch {}
  }
}

/**
 * Rebuilds derived public relations through the incremental revision protocol.
 * The complete relation delta and revision advancement share one provider
 * transaction; the physical public/internal generation stays stable.
 *
 * The operation callback is explicit so provider-level conformance tests can
 * inject a failing pending write without weakening the production protocol.
 */
export async function runGenerationSafeRelationRebuild(
  input: GenerationSafeRelationRebuildInput,
  rebuild: RelationRebuildOperation
): Promise<RepoDependencyEdge[]> {
  const generations = new SchemaGenerationStore(input.db, input.workspaceId);
  const recovered = await generations.recoverExpiredReservation();
  if (recovered) {
    try {
      input.logger?.warn?.(
        `Recovered expired workspace ${recovered.kind} reservation ` +
        `${recovered.kind === "full" ? recovered.generation : recovered.revision}.`
      );
    } catch {}
    if (recovered.kind === "full") {
      await cleanupWithRetryMarker({ ...input, generations, generation: recovered.generation });
    }
  }

  const reservation = await generations.reservation();
  if (reservation) {
    throw new Error(
      `Workspace ${input.workspaceId} is already staging ${reservation.kind} ` +
      `${reservation.kind === "full" ? reservation.generation : reservation.revision} ` +
      `until ${reservation.leaseUntil ?? "an unknown time"}; refusing a concurrent relation rebuild.`
    );
  }

  for (const generation of await generations.abortingGenerations()) {
    await cleanupWithRetryMarker({ ...input, generations, generation });
  }

  const activeGeneration = await generations.activeGeneration();
  const activeRevision = await generations.activeRevision();
  if (!activeGeneration || !activeRevision) {
    throw new Error("Cannot rebuild relations before an active workspace generation exists; run a full index first.");
  }

  const revision = createBatchId(`schema-revision:${input.workspaceId}:relation-rebuild`);
  const activeScope = { workspaceId: input.workspaceId, generation: activeGeneration } as const;
  let revisionReserved = false;
  let committed = false;
  let leaseHeartbeat: ReturnType<typeof setInterval> | undefined;
  let leaseHeartbeatWork: Promise<void> = Promise.resolve();

  const startLeaseHeartbeat = (): void => {
    leaseHeartbeat = setInterval(() => {
      leaseHeartbeatWork = leaseHeartbeatWork
        .then(() => generations.renewLease(revision))
        .catch((error) => {
          try {
            input.logger?.warn?.(
              `Relation rebuild generation lease heartbeat deferred: ${errorMessage(error)}`
            );
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
    await generations.reserveIncremental({
      revision,
      expectedActiveGeneration: activeGeneration,
      expectedActiveRevision: activeRevision
    });
    revisionReserved = true;
    startLeaseHeartbeat();
    await stopLeaseHeartbeat();
    await generations.renewLease(revision);
    const dependencies = await input.db.applyIncrementalIndexMutation({
      workspaceId: input.workspaceId,
      expectedActiveGeneration: activeGeneration,
      expectedActiveRevision: activeRevision,
      nextRevision: revision,
      schemaIndexVersion: SCHEMA_INDEX_VERSION
    }, async () => {
      const rebuilt = await rebuild(activeScope);
      await input.db.applyPublicGraphStatsDelta(activeScope, {
        expectedRevision: activeRevision,
        nextRevision: revision,
        delta: {
          repos: 0,
          files: 0,
          codeNodes: 0,
          sectionNodes: 0,
          callEdges: 0,
          importEdges: 0,
          entities: 0
        }
      });
      return rebuilt;
    });
    committed = true;
    return dependencies;
  } catch (error) {
    await stopLeaseHeartbeat();
    if (!committed && revisionReserved) {
      try {
        committed = await generations.activeRevision() === revision;
      } catch {
        // A lost commit acknowledgement is unsafe to compensate. Preserve the
        // pending artifacts so a later invocation can inspect the pointer.
        throw error;
      }
    }
    if (!committed && revisionReserved) {
      try {
        await generations.abandonIncremental(revision);
      } catch (cleanupError) {
        try {
          input.logger?.warn?.(`Incremental relation rebuild cleanup deferred: ${errorMessage(cleanupError)}`);
        } catch {}
      }
    }
    throw error;
  }
}

export async function rebuildRepoDependenciesInNewGeneration(
  input: GenerationSafeRelationRebuildInput
): Promise<RepoDependencyEdge[]> {
  return runGenerationSafeRelationRebuild(input, (scope) => rebuildRepoDependencies(input.db, {
    scope,
    repoIds: input.repoIds,
    logger: input.logger
  }));
}
