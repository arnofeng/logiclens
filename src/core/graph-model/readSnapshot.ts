import { randomUUID } from "node:crypto";
import type { GraphDB, GraphValue } from "./db.js";
import type { PublicGraphGenerationScope } from "./publicGraphGeneration.js";

export const PUBLIC_GRAPH_READ_LEASE_DURATION_MS = 5 * 60_000;
export const PUBLIC_GRAPH_READ_LEASE_HEARTBEAT_MS = 30_000;

const leaseMutationTails = new WeakMap<GraphDB, Promise<void>>();

/**
 * Kuzu permits concurrent readers but only one writer. Read leases are tiny
 * writes that can otherwise collide when callers issue many reads in parallel
 * (for example a retrieval evaluation corpus). Keep only lease mutations
 * ordered per provider instance; the protected graph reads remain concurrent.
 */
async function serializeLeaseMutation<T>(db: GraphDB, operation: () => Promise<T>): Promise<T> {
  const previous = leaseMutationTails.get(db) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(operation);
  const tail = result.then(() => undefined, () => undefined);
  leaseMutationTails.set(db, tail);
  try {
    return await result;
  } finally {
    if (leaseMutationTails.get(db) === tail) leaseMutationTails.delete(db);
  }
}

export type PublicGraphReadSnapshot = Readonly<{
  workspaceId: string;
  generation: string;
  /** Logical publication revision inside the physical generation. */
  revision: string;
  /** Present for snapshots pinned through pinPublicGraphReadSnapshot. */
  leaseId?: string;
  leaseUntil?: string;
}>;

function readSnapshot(input: {
  workspaceId: string;
  generation: string;
  revision: string;
  leaseId?: string;
  leaseUntil?: string;
}): PublicGraphReadSnapshot {
  const snapshot: {
    workspaceId: string;
    generation: string;
    readonly revision?: string;
    readonly leaseId?: string;
    readonly leaseUntil?: string;
  } = {
    workspaceId: input.workspaceId,
    generation: input.generation
  };
  // A snapshot remains structurally usable anywhere a generation scope or
  // query-parameter record was accepted before read leases existed. Kuzu
  // rejects unused prepared-statement parameters, so lifecycle metadata must
  // be readable by renew/release without becoming enumerable Cypher params.
  Object.defineProperties(snapshot, {
    revision: { value: input.revision, enumerable: false },
    ...(input.leaseId ? {
      leaseId: { value: input.leaseId, enumerable: false },
      leaseUntil: { value: input.leaseUntil, enumerable: false }
    } : {})
  });
  return Object.freeze(snapshot) as PublicGraphReadSnapshot;
}

/**
 * Creates a committed, non-leased snapshot when the caller already owns the
 * publication transition (for example a provider lifecycle test helper).
 * Revision remains deliberately non-enumerable so the value is safe to pass
 * through generation-scoped Kuzu query parameter helpers.
 */
export function createPublicGraphReadSnapshot(input: {
  workspaceId: string;
  generation: string;
  revision: string;
}): PublicGraphReadSnapshot {
  if (!input.workspaceId || !input.generation || !input.revision) {
    throw new TypeError("Public graph read snapshot identities must be non-empty.");
  }
  return readSnapshot(input);
}

async function tryReadActiveSnapshot(
  db: GraphDB,
  workspaceId: string
): Promise<PublicGraphReadSnapshot | undefined> {
  const rows = await db.query<{ activeGeneration?: GraphValue; activeRevision?: GraphValue }>(
    "MATCH (s:SchemaGenerationState {id: $stateId}) " +
    "RETURN s.activeGeneration AS activeGeneration, s.activeRevision AS activeRevision;",
    { stateId: `schema-generation-state:${workspaceId}` }
  );
  const generation = rows[0]?.activeGeneration;
  if (typeof generation !== "string" || generation.length === 0) return undefined;
  const revision = rows[0]?.activeRevision;
  if (typeof revision !== "string" || revision.length === 0) {
    throw new Error(
      `Active public graph generation ${generation} has no revision. Run a clean full reindex.`
    );
  }
  return readSnapshot({ workspaceId, generation, revision });
}

/**
 * Pins the public graph generation for one high-level read operation.
 * Callers must pass the returned immutable snapshot to every lower-level
 * query so a concurrent active-pointer switch cannot produce a mixed view.
 */
export async function pinPublicGraphReadSnapshot(
  db: GraphDB,
  workspaceId: string
): Promise<PublicGraphReadSnapshot> {
  const snapshot = await tryPinPublicGraphReadSnapshot(db, workspaceId);
  if (!snapshot) {
    throw new Error(`No active public graph generation exists for workspace ${workspaceId}. Run a clean full reindex.`);
  }
  return snapshot;
}

/** Returns undefined only when a workspace has not committed its first generation. */
export async function tryPinPublicGraphReadSnapshot(
  db: GraphDB,
  workspaceId: string,
  now = new Date()
): Promise<PublicGraphReadSnapshot | undefined> {
  const leaseId = `schema-read-lease:${randomUUID()}`;
  const leaseUntil = new Date(now.getTime() + PUBLIC_GRAPH_READ_LEASE_DURATION_MS).toISOString();
  const rows = await serializeLeaseMutation(db, () => db.query<{
    activeGeneration?: GraphValue;
    activeRevision?: GraphValue;
  }>(
    "MATCH (s:SchemaGenerationState {id: $stateId}) " +
    "WHERE s.activeGeneration IS NOT NULL AND s.activeGeneration <> '' " +
    "AND s.activeRevision IS NOT NULL AND s.activeRevision <> '' " +
    "SET s.protocolNonce=$leaseId " +
    "MERGE (l:SchemaGenerationReadLease {id: $leaseId}) " +
    "SET l.workspaceId=$workspaceId, l.generation=s.activeGeneration, l.leaseUntil=$leaseUntil, l.createdAt=$createdAt " +
    "RETURN s.activeGeneration AS activeGeneration, s.activeRevision AS activeRevision;",
    {
      stateId: `schema-generation-state:${workspaceId}`,
      workspaceId,
      leaseId,
      leaseUntil,
      createdAt: now.toISOString()
    }
  ));
  const generation = rows[0]?.activeGeneration;
  if (typeof generation !== "string" || generation.length === 0) {
    return undefined;
  }
  const revision = rows[0]?.activeRevision;
  if (typeof revision !== "string" || revision.length === 0) {
    throw new Error(
      `Active public graph generation ${generation} has no revision. Run a clean full reindex.`
    );
  }
  return readSnapshot({ workspaceId, generation, revision, leaseId, leaseUntil });
}

export async function renewPublicGraphReadSnapshot(
  db: GraphDB,
  snapshot: PublicGraphReadSnapshot,
  now = new Date()
): Promise<PublicGraphReadSnapshot> {
  const leaseId = snapshot.leaseId;
  if (!leaseId) return snapshot;
  const leaseUntil = new Date(now.getTime() + PUBLIC_GRAPH_READ_LEASE_DURATION_MS).toISOString();
  const rows = await serializeLeaseMutation(db, () => db.query<{ generation?: GraphValue }>(
    "MATCH (l:SchemaGenerationReadLease {id: $leaseId}) " +
    "WHERE l.workspaceId=$workspaceId AND l.generation=$generation " +
    "SET l.leaseUntil=$leaseUntil RETURN l.generation AS generation;",
    {
      leaseId,
      workspaceId: snapshot.workspaceId,
      generation: snapshot.generation,
      leaseUntil
    }
  ));
  if (rows[0]?.generation !== snapshot.generation) {
    throw new Error(`Public graph read lease ${leaseId} no longer owns generation ${snapshot.generation}.`);
  }
  return readSnapshot({
    workspaceId: snapshot.workspaceId,
    generation: snapshot.generation,
    revision: snapshot.revision,
    leaseId,
    leaseUntil
  });
}

export async function releasePublicGraphReadSnapshot(
  db: GraphDB,
  snapshot: PublicGraphReadSnapshot
): Promise<void> {
  const leaseId = snapshot.leaseId;
  if (!leaseId) return;
  await serializeLeaseMutation(db, () => db.query(
    "MATCH (l:SchemaGenerationReadLease {id: $leaseId}) " +
    "WHERE l.workspaceId=$workspaceId AND l.generation=$generation DELETE l;",
    {
      leaseId,
      workspaceId: snapshot.workspaceId,
      generation: snapshot.generation
    }
  ));
}

/**
 * Runs the complete high-level operation in one provider read transaction.
 * Providers without that capability retain the generation-lease fallback.
 * Nested readers must reuse the supplied snapshot and provider context.
 */
export async function withPublicGraphReadSnapshot<T>(
  db: GraphDB,
  workspaceId: string,
  operation: (snapshot: PublicGraphReadSnapshot) => Promise<T>
): Promise<T> {
  if (db.readTransaction) {
    return db.readTransaction(async () => {
      const snapshot = await tryReadActiveSnapshot(db, workspaceId);
      if (!snapshot) {
        throw new Error(
          `No active public graph generation exists for workspace ${workspaceId}. Run a clean full reindex.`
        );
      }
      return operation(snapshot);
    });
  }

  let snapshot = await pinPublicGraphReadSnapshot(db, workspaceId);
  let heartbeatWork = Promise.resolve();
  const heartbeat = setInterval(() => {
    heartbeatWork = heartbeatWork.then(async () => {
      snapshot = await renewPublicGraphReadSnapshot(db, snapshot);
    });
  }, PUBLIC_GRAPH_READ_LEASE_HEARTBEAT_MS);
  heartbeat.unref?.();
  try {
    return await operation(snapshot);
  } finally {
    clearInterval(heartbeat);
    try {
      await heartbeatWork;
    } finally {
      await releasePublicGraphReadSnapshot(db, snapshot);
    }
  }
}

/**
 * Optional variant for status/readiness APIs before the first full index.
 * A committed workspace still receives the same provider transaction
 * guarantees as withPublicGraphReadSnapshot.
 */
export async function tryWithPublicGraphReadSnapshot<T>(
  db: GraphDB,
  workspaceId: string,
  operation: (snapshot: PublicGraphReadSnapshot) => Promise<T>
): Promise<T | undefined> {
  if (db.readTransaction) {
    return db.readTransaction(async () => {
      const snapshot = await tryReadActiveSnapshot(db, workspaceId);
      return snapshot ? operation(snapshot) : undefined;
    });
  }
  const snapshot = await tryPinPublicGraphReadSnapshot(db, workspaceId);
  if (!snapshot) return undefined;
  try {
    return await operation(snapshot);
  } finally {
    await releasePublicGraphReadSnapshot(db, snapshot);
  }
}

/** Pins the active publication inside one provider write transaction. */
export async function withPublicGraphWriteSnapshot<T>(
  db: GraphDB,
  workspaceId: string,
  operation: (snapshot: PublicGraphReadSnapshot) => Promise<T>
): Promise<T> {
  const execute = async (): Promise<T> => {
    const snapshot = await tryReadActiveSnapshot(db, workspaceId);
    if (!snapshot) {
      throw new Error(
        `No active public graph generation exists for workspace ${workspaceId}. Run a clean full reindex.`
      );
    }
    return operation(snapshot);
  };
  if (db.transaction) return db.transaction(execute);
  if (db.readTransaction) return db.readTransaction(execute);
  const snapshot = await pinPublicGraphReadSnapshot(db, workspaceId);
  try {
    return await operation(snapshot);
  } finally {
    await releasePublicGraphReadSnapshot(db, snapshot);
  }
}

export async function assertNoLivePublicGraphReadLeases(
  db: GraphDB,
  scope: PublicGraphGenerationScope,
  now = new Date()
): Promise<void> {
  const params = { ...scope, now: now.toISOString() };
  await db.query(
    "MATCH (l:SchemaGenerationReadLease) " +
    "WHERE l.workspaceId=$workspaceId AND l.generation=$generation AND l.leaseUntil <= $now DELETE l;",
    params
  );
  const rows = await db.query<{ count?: GraphValue }>(
    "MATCH (l:SchemaGenerationReadLease) " +
    "WHERE l.workspaceId=$workspaceId AND l.generation=$generation AND l.leaseUntil > $now " +
    "RETURN count(l) AS count;",
    params
  );
  const value = rows[0]?.count;
  const count = typeof value === "bigint" ? Number(value) : typeof value === "number" ? value : 0;
  if (count > 0) {
    throw new Error(`Cannot delete public graph generation ${scope.generation}; ${count} live read lease${count === 1 ? "" : "s"} still pin it.`);
  }
}

export function withPublicGraphSnapshotParams(
  snapshot: PublicGraphReadSnapshot,
  params: Record<string, GraphValue> = {}
): Record<string, GraphValue> {
  if ("generation" in params && params.generation !== snapshot.generation) {
    throw new TypeError("Public graph query generation does not match the pinned read snapshot.");
  }
  if ("workspaceId" in params && params.workspaceId !== snapshot.workspaceId) {
    throw new TypeError("Public graph query workspace does not match the pinned read snapshot.");
  }
  return { ...params, workspaceId: snapshot.workspaceId, generation: snapshot.generation };
}

/** Builds a predicate for trusted, statically-declared Cypher aliases. */
export function publicGraphGenerationPredicate(...aliases: readonly string[]): string {
  if (aliases.length === 0 || aliases.some((alias) => !/^[A-Za-z][A-Za-z0-9_]*$/u.test(alias))) {
    throw new TypeError("Public graph generation predicates require one or more safe Cypher aliases.");
  }
  return aliases
    .flatMap((alias) => [
      `${alias}.workspaceId = $workspaceId`,
      `${alias}.generation = $generation`
    ])
    .join(" AND ");
}

/** Builds an active-row predicate for public nodes or relationships that carry lifecycle state. */
export function publicGraphActivePredicate(...aliases: readonly string[]): string {
  if (aliases.length === 0 || aliases.some((alias) => !/^[A-Za-z][A-Za-z0-9_]*$/u.test(alias))) {
    throw new TypeError("Public graph active predicates require one or more safe Cypher aliases.");
  }
  return aliases
    .map((alias) => `(${alias}.active IS NULL OR ${alias}.active = true)`)
    .join(" AND ");
}
