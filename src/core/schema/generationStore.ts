import { type GraphDB, type GraphValue, withTransaction } from "../graph-model/db.js";
import { LEXICAL_PROJECTION_SCHEMA_VERSION } from "../retrieval/types.js";
import { canonicalSerialize, SCHEMA_INDEX_VERSION, stableFactId } from "./model.js";
import type { ResolutionScopeIdentity } from "./model.js";
import { assertNoLivePublicGraphReadLeases } from "../graph-model/readSnapshot.js";

export type SchemaInternalFactKind =
  | "declarations"
  | "resolutionContexts"
  | "resolutionScopeDependencies"
  | "roots"
  | "dependencies"
  | "provenance"
  | "diagnostics"
  | "fingerprints";

const FACT_TABLES: Record<SchemaInternalFactKind, string> = {
  declarations: "TypeDeclarationFact",
  resolutionContexts: "ResolutionContextFact",
  resolutionScopeDependencies: "ResolutionScopeDependencyFact",
  roots: "SchemaRootFact",
  dependencies: "SchemaDependencyFact",
  provenance: "SchemaProvenanceFact",
  diagnostics: "SchemaDiagnosticFact",
  fingerprints: "SchemaBehaviorFingerprintFact"
};

export interface OwnedSchemaFact {
  id: string;
  generation?: string;
  repoId?: string;
  sourceFileId?: string;
}

export interface SchemaBehaviorFingerprintReplacement {
  repoId: string;
  languageId: string;
  resolutionScopeId: string;
  facts: readonly OwnedSchemaFact[];
}

export interface DeclarationScopePrefix {
  languageId: string;
  repoId: string;
  resolutionScopePrefix: string;
}

export interface AffectedSchemaRootsInput<T extends OwnedSchemaFact> {
  generation?: string;
  touchedSources: readonly { repoId: string; fileId: string }[];
  changedDeclarationIds: readonly string[];
  changedResolutionScopes: readonly ResolutionScopeIdentity[];
  pendingRoots?: readonly T[];
}

type GenerationStateRow = {
  activeGeneration?: GraphValue;
  activeRevision?: GraphValue;
  pendingGeneration?: GraphValue;
  pendingRevision?: GraphValue;
  pendingParentGeneration?: GraphValue;
  pendingParentRevision?: GraphValue;
  pendingLeaseUntil?: GraphValue;
};

type GenerationRow = {
  activeRevision?: GraphValue;
  parentGeneration?: GraphValue;
  schemaIndexVersion?: GraphValue;
  status?: GraphValue;
};

export const SCHEMA_GENERATION_LEASE_MS = 30 * 60 * 1000;

export type FullSchemaGenerationReservation = {
  kind: "full";
  generation: string;
  parentGeneration?: string;
  parentRevision?: string;
  leaseUntil?: string;
};

export type IncrementalSchemaRevisionReservation = {
  kind: "incremental";
  generation: string;
  revision: string;
  parentRevision: string;
  leaseUntil?: string;
};

export type SchemaGenerationReservation =
  | FullSchemaGenerationReservation
  | IncrementalSchemaRevisionReservation;

export interface BeginFullSchemaGenerationInput {
  generation: string;
  createdAt: string;
  expectedActiveGeneration: string | null;
  expectedActiveRevision: string | null;
}

export interface ReserveIncrementalSchemaRevisionInput {
  revision: string;
  expectedActiveGeneration: string;
  expectedActiveRevision: string;
}

export interface ValidatedIncrementalSchemaRevision {
  generation: string;
  parentRevision: string;
  revision: string;
}

export interface SchemaContributionView {
  rootReferenceId: string;
  entityKind: "schema-spec" | "logical-relation" | "lexical-document";
  entityId: string;
  payload?: unknown;
}

export type SchemaContributionEntityKey = Pick<SchemaContributionView, "entityKind" | "entityId">;

export interface SchemaContributionReplacement {
  rootReferenceId: string;
  contributions: readonly Omit<SchemaContributionView, "rootReferenceId">[];
}

export interface SchemaContributionVisibilityChange extends SchemaContributionEntityKey {
  previousCount: number;
  nextCount: number;
  previousContributions: SchemaContributionView[];
  contributions: SchemaContributionView[];
}

export class SchemaGenerationStore {
  constructor(private readonly db: GraphDB, private readonly workspaceId: string) {}

  async beginFull(input: BeginFullSchemaGenerationInput): Promise<string | undefined> {
    const { generation, createdAt } = input;
    const initialState = await this.readGenerationState();
    this.assertExpectedActiveState({
      operation: `begin full schema generation ${generation}`,
      state: initialState,
      expectedActiveGeneration: input.expectedActiveGeneration,
      expectedActiveRevision: input.expectedActiveRevision
    });
    this.assertNoPendingReservation(initialState, generation);
    if (generation === this.stringValue(initialState.activeGeneration)) {
      throw new Error(`Cannot reuse active schema generation ${generation} as a pending generation.`);
    }
    let activeGeneration: string | undefined;
    await withTransaction(this.db, async () => {
      const state = await this.lockGenerationState(generation);
      activeGeneration = this.stringValue(state.activeGeneration);
      const activeRevision = this.stringValue(state.activeRevision);
      this.assertExpectedActiveState({
        operation: `begin full schema generation ${generation}`,
        state,
        expectedActiveGeneration: input.expectedActiveGeneration,
        expectedActiveRevision: input.expectedActiveRevision
      });
      this.assertNoPendingReservation(state, generation);
      if (generation === activeGeneration) {
        throw new Error(`Cannot reuse active schema generation ${generation} as a pending generation.`);
      }
      const existing = await this.db.query<{ id?: GraphValue }>(
        "MATCH (g:SchemaGeneration {id: $generation}) RETURN g.id AS id;",
        { generation }
      );
      if (existing.length > 0) {
        throw new Error(`Cannot reuse existing schema generation ${generation}.`);
      }
      await this.db.query(
        "MERGE (g:SchemaGeneration {id: $id}) SET g.workspaceId=$workspaceId, g.parentGeneration=$parentGeneration, g.status=$status, g.schemaIndexVersion=$schemaIndexVersion, g.createdAt=$createdAt;",
        { id: generation, workspaceId: this.workspaceId, parentGeneration: activeGeneration ?? "", status: "pending", schemaIndexVersion: SCHEMA_INDEX_VERSION, createdAt }
      );
      await this.db.query(
        "MATCH (s:SchemaGenerationState {id: $id}) " +
        "SET s.pendingGeneration=$generation, s.pendingRevision='', " +
        "s.pendingParentGeneration=$parentGeneration, s.pendingParentRevision=$parentRevision, s.pendingLeaseUntil=$leaseUntil;",
        {
          id: this.stateId(),
          generation,
          parentGeneration: activeGeneration ?? "",
          parentRevision: activeRevision ?? "",
          leaseUntil: this.nextLeaseUntil()
        }
      );
    });
    return activeGeneration;
  }

  async reserveIncremental(input: ReserveIncrementalSchemaRevisionInput): Promise<void> {
    const { revision } = input;
    if (!revision) throw new Error("Incremental schema revision must be non-empty.");
    const initialState = await this.readGenerationState();
    this.assertExpectedActiveState({
      operation: `reserve incremental schema revision ${revision}`,
      state: initialState,
      expectedActiveGeneration: input.expectedActiveGeneration,
      expectedActiveRevision: input.expectedActiveRevision
    });
    this.assertNoPendingReservation(initialState, revision);
    if (revision === input.expectedActiveRevision) {
      throw new Error(`Cannot reuse active schema revision ${revision} as a pending revision.`);
    }
    await withTransaction(this.db, async () => {
      const state = await this.lockGenerationState(revision);
      this.assertExpectedActiveState({
        operation: `reserve incremental schema revision ${revision}`,
        state,
        expectedActiveGeneration: input.expectedActiveGeneration,
        expectedActiveRevision: input.expectedActiveRevision
      });
      this.assertNoPendingReservation(state, revision);
      if (revision === input.expectedActiveRevision) {
        throw new Error(`Cannot reuse active schema revision ${revision} as a pending revision.`);
      }
      await this.db.query(
        "MATCH (s:SchemaGenerationState {id: $id}) " +
        "SET s.pendingGeneration='', s.pendingRevision=$revision, " +
        "s.pendingParentGeneration=$parentGeneration, s.pendingParentRevision=$parentRevision, s.pendingLeaseUntil=$leaseUntil;",
        {
          id: this.stateId(),
          revision,
          parentGeneration: input.expectedActiveGeneration,
          parentRevision: input.expectedActiveRevision,
          leaseUntil: this.nextLeaseUntil()
        }
      );
    });
  }

  async replaceSourceFacts(input: {
    generation: string;
    kind: SchemaInternalFactKind;
    repoId: string;
    fileId: string;
    facts: readonly OwnedSchemaFact[];
  }): Promise<void> {
    await this.assertPending(input.generation);
    await this.replaceSourceFactsUnchecked({ ...input, revision: input.generation });
  }

  async replaceBehaviorFingerprints(input: {
    generation: string;
    replacement: SchemaBehaviorFingerprintReplacement;
  }): Promise<void> {
    await this.assertPending(input.generation);
    await this.replaceBehaviorFingerprintsUnchecked({
      generation: input.generation,
      revision: input.generation,
      ...input.replacement
    });
  }

  /**
   * Applies one source replacement to the active physical dataset. Callers must
   * invoke this only from the provider's final incremental write transaction.
   */
  async replaceActiveSourceFacts(input: {
    generation: string;
    kind: SchemaInternalFactKind;
    repoId: string;
    fileId: string;
    facts: readonly OwnedSchemaFact[];
  }): Promise<void> {
    const revision = await this.assertIncrementalActiveTarget(input.generation);
    await this.replaceSourceFactsUnchecked({ ...input, revision });
  }

  async replaceContributions(input: {
    generation: string;
    rootReferenceId: string;
    contributions: readonly { entityKind: "schema-spec" | "logical-relation" | "lexical-document"; entityId: string; payload?: unknown }[];
  }): Promise<void> {
    await this.assertPending(input.generation);
    await this.replaceContributionsUnchecked({ ...input, revision: input.generation });
  }

  /**
   * Applies one root-contribution replacement to the active physical dataset.
   * Callers must invoke this only from the provider's final incremental write
   * transaction so public, internal, lexical, and revision state roll back
   * together on failure.
   */
  async replaceActiveContributions(input: {
    generation: string;
    rootReferenceId: string;
    contributions: readonly Omit<SchemaContributionView, "rootReferenceId">[];
  }): Promise<void> {
    const revision = await this.assertIncrementalActiveTarget(input.generation);
    await this.replaceContributionsUnchecked({ ...input, revision });
  }

  /**
   * Applies an already prepared set of active source/root replacements after
   * one read-only reservation check. The provider incremental coordinator owns
   * the surrounding write transaction and state-row lock. Avoiding a state
   * update per replacement is required by Kuzu, which otherwise reports a
   * write/write conflict for repeatedly touching the lock row in one commit.
   */
  async applyActiveReplacementBatch(input: {
    generation: string;
    revision: string;
    sourceReplacements: readonly {
      kind: SchemaInternalFactKind;
      repoId: string;
      fileId: string;
      facts: readonly OwnedSchemaFact[];
    }[];
    behaviorFingerprintReplacements: readonly SchemaBehaviorFingerprintReplacement[];
    contributionReplacements: readonly SchemaContributionReplacement[];
  }): Promise<void> {
    const rows = await this.db.query<GenerationStateRow>(
      "MATCH (s:SchemaGenerationState {id: $id}) RETURN " +
      "s.activeGeneration AS activeGeneration, s.activeRevision AS activeRevision, " +
      "s.pendingGeneration AS pendingGeneration, s.pendingRevision AS pendingRevision, " +
      "s.pendingParentGeneration AS pendingParentGeneration, s.pendingParentRevision AS pendingParentRevision, " +
      "s.pendingLeaseUntil AS pendingLeaseUntil;",
      { id: this.stateId() }
    );
    const validated = this.assertIncrementalCommitCandidate(input.revision, rows[0] ?? {});
    if (validated.generation !== input.generation) {
      throw new Error(`Schema incremental batch targets ${input.generation}, but the active generation is ${validated.generation}.`);
    }
    for (const replacement of input.sourceReplacements) {
      await this.replaceSourceFactsUnchecked({
        generation: input.generation,
        revision: input.revision,
        ...replacement
      });
    }
    for (const replacement of input.behaviorFingerprintReplacements) {
      await this.replaceBehaviorFingerprintsUnchecked({
        generation: input.generation,
        revision: input.revision,
        ...replacement
      });
    }
    for (const replacement of input.contributionReplacements) {
      await this.replaceContributionsUnchecked({
        generation: input.generation,
        revision: input.revision,
        ...replacement
      });
    }
  }

  private async replaceContributionsUnchecked(input: {
    generation: string;
    revision: string;
    rootReferenceId: string;
    contributions: readonly Omit<SchemaContributionView, "rootReferenceId">[];
  }): Promise<void> {
    await this.db.query(
      "MATCH (c:SchemaContribution) WHERE c.generation = $generation AND c.rootReferenceId = $rootReferenceId DELETE c;",
      { generation: input.generation, rootReferenceId: input.rootReferenceId }
    );
    const replacementId = stableFactId("schema-contribution-replacement", {
      generation: input.generation,
      rootReferenceId: input.rootReferenceId
    });
    await this.db.query(
      "MERGE (r:SchemaContributionReplacement {id: $id}) SET r.generation=$generation, r.revision=$revision, r.rootReferenceId=$rootReferenceId, r.tombstone=$tombstone;",
      {
        id: replacementId,
        generation: input.generation,
        revision: input.revision,
        rootReferenceId: input.rootReferenceId,
        tombstone: input.contributions.length === 0
      }
    );
    for (const contribution of [...input.contributions].sort((a, b) => `${a.entityKind}:${a.entityId}`.localeCompare(`${b.entityKind}:${b.entityId}`))) {
      const id = stableFactId("schema-contribution", { generation: input.generation, rootReferenceId: input.rootReferenceId, entityKind: contribution.entityKind, entityId: contribution.entityId });
      await this.db.query(
        "MERGE (c:SchemaContribution {id: $id}) SET c.generation=$generation, c.rootReferenceId=$rootReferenceId, c.entityKind=$entityKind, c.entityId=$entityId, c.payload=$payload;",
        { id, generation: input.generation, rootReferenceId: input.rootReferenceId, entityKind: contribution.entityKind, entityId: contribution.entityId, payload: canonicalSerialize(contribution.payload ?? {}) }
      );
    }
  }

  async commitFull(generation: string): Promise<void> {
    await withTransaction(this.db, async () => {
      const state = await this.lockGenerationState(generation);
      const row = await this.generationRow(generation);
      this.assertFullCommitCandidate(generation, state, row);
      const parent = this.stringValue(row.parentGeneration);
      if (parent) {
        await this.db.query(
          "MATCH (g:SchemaGeneration {id: $parent}) WHERE g.workspaceId=$workspaceId SET g.status=$status;",
          { parent, workspaceId: this.workspaceId, status: "superseded" }
        );
      }
      await this.db.query(
        "MATCH (g:SchemaGeneration {id: $generation}) " +
        "SET g.status=$status, g.activeRevision=$revision, g.schemaIndexVersion=$schemaIndexVersion, " +
        "g.lexicalProjectionVersion=$lexicalProjectionVersion, g.updatedAt=$updatedAt;",
        {
          generation,
          revision: generation,
          status: "active",
          schemaIndexVersion: SCHEMA_INDEX_VERSION,
          lexicalProjectionVersion: LEXICAL_PROJECTION_SCHEMA_VERSION,
          updatedAt: new Date().toISOString()
        }
      );
      await this.db.query(
        "MATCH (s:SchemaGenerationState {id: $id}) " +
        "SET s.workspaceId=$workspaceId, s.activeGeneration=$generation, s.activeRevision=$revision, " +
        "s.pendingGeneration='', s.pendingRevision='', s.pendingParentGeneration='', s.pendingParentRevision='', s.pendingLeaseUntil='', " +
        "s.schemaIndexVersion=$schemaIndexVersion, s.lexicalProjectionVersion=$lexicalProjectionVersion;",
        { id: `schema-generation-state:${this.workspaceId}`, workspaceId: this.workspaceId, generation, revision: generation, schemaIndexVersion: SCHEMA_INDEX_VERSION, lexicalProjectionVersion: LEXICAL_PROJECTION_SCHEMA_VERSION }
      );
    });
  }

  async validateFull(generation: string): Promise<void> {
    const state = await this.lockGenerationState(generation);
    const row = await this.generationRow(generation);
    this.assertFullCommitCandidate(generation, state, row);
  }

  async validateIncremental(revision: string): Promise<ValidatedIncrementalSchemaRevision> {
    const state = await this.lockGenerationState(revision);
    const validated = this.assertIncrementalCommitCandidate(revision, state);
    await this.assertPhysicalGenerationRevision(validated);
    return validated;
  }

  /**
   * Advances only the logical revision of the active physical dataset. The
   * provider-level incremental mutation entry point calls this from its outer
   * transaction after every graph/internal/lexical delta has succeeded.
   */
  async commitIncremental(revision: string): Promise<void> {
    await withTransaction(this.db, async () => {
      // The final state transition below is the transaction's single write to
      // SchemaGenerationState. Kuzu rejects a lock-then-update pattern as two
      // writes to the same row in one transaction; the provider transaction
      // still supplies atomic conflict detection for a concurrent publisher.
      const state = await this.readGenerationState();
      const validated = this.assertIncrementalCommitCandidate(revision, state);
      await this.assertPhysicalGenerationRevision(validated);
      await this.db.query(
        "MATCH (g:SchemaGeneration {id: $generation}) WHERE g.workspaceId=$workspaceId AND g.status='active' " +
        "SET g.activeRevision=$revision, g.schemaIndexVersion=$schemaIndexVersion, " +
        "g.lexicalProjectionVersion=$lexicalProjectionVersion, g.updatedAt=$updatedAt;",
        {
          generation: validated.generation,
          workspaceId: this.workspaceId,
          revision,
          schemaIndexVersion: SCHEMA_INDEX_VERSION,
          lexicalProjectionVersion: LEXICAL_PROJECTION_SCHEMA_VERSION,
          updatedAt: new Date().toISOString()
        }
      );
      await this.db.query(
        "MATCH (s:SchemaGenerationState {id: $id}) " +
        "SET s.activeRevision=$revision, s.pendingGeneration='', s.pendingRevision='', " +
        "s.pendingParentGeneration='', s.pendingParentRevision='', s.pendingLeaseUntil='', " +
        "s.schemaIndexVersion=$schemaIndexVersion, s.lexicalProjectionVersion=$lexicalProjectionVersion;",
        {
          id: this.stateId(),
          revision,
          schemaIndexVersion: SCHEMA_INDEX_VERSION,
          lexicalProjectionVersion: LEXICAL_PROJECTION_SCHEMA_VERSION
        }
      );
    });
  }

  async rollback(generation: string): Promise<void> {
    await assertNoLivePublicGraphReadLeases(this.db, {
      workspaceId: this.workspaceId,
      generation
    });
    await this.abandonFull(generation);
    for (const table of [...Object.values(FACT_TABLES), "SchemaSourceReplacement", "SchemaBehaviorReplacement", "SchemaContribution", "SchemaContributionReplacement", "SchemaGenerationReadLease"]) {
      await this.db.query(`MATCH (n:${table}) WHERE n.generation = $generation DELETE n;`, { generation });
    }
    await this.db.query("MATCH (g:SchemaGeneration {id: $generation}) DELETE g;", { generation });
  }

  async abandonFull(generation: string): Promise<void> {
    await withTransaction(this.db, async () => {
      const state = await this.lockGenerationState(generation);
      const active = this.stringValue(state.activeGeneration);
      if (active === generation) {
        throw new Error(`Cannot roll back active schema generation ${generation}; committed journal cleanup must be retried as garbage collection.`);
      }
      const reserved = this.stringValue(state.pendingGeneration);
      if (reserved === generation) {
        await this.db.query(
          "MATCH (s:SchemaGenerationState {id: $id}) " +
          "SET s.pendingGeneration='', s.pendingParentGeneration='', s.pendingParentRevision='', s.pendingLeaseUntil='';",
          { id: this.stateId() }
        );
      }
      await this.db.query(
        "MATCH (g:SchemaGeneration {id: $generation}) WHERE g.workspaceId=$workspaceId AND g.status <> 'active' SET g.status=$status;",
        { generation, workspaceId: this.workspaceId, status: "aborting" }
      );
    });
  }

  async abandonIncremental(revision: string): Promise<void> {
    await withTransaction(this.db, async () => {
      const state = await this.lockGenerationState(revision);
      const activeRevision = this.stringValue(state.activeRevision);
      if (activeRevision === revision) {
        throw new Error(`Cannot abandon active schema revision ${revision}; committed journal cleanup must be retried.`);
      }
      if (this.stringValue(state.pendingRevision) !== revision) return;
      await this.db.query(
        "MATCH (s:SchemaGenerationState {id: $id}) " +
        "SET s.pendingRevision='', s.pendingParentGeneration='', s.pendingParentRevision='', s.pendingLeaseUntil='';",
        { id: this.stateId() }
      );
    });
  }

  async pendingGenerations(): Promise<string[]> {
    const rows = await this.db.query<{ generation?: GraphValue }>(
      "MATCH (g:SchemaGeneration) WHERE g.workspaceId = $workspaceId AND g.status = 'pending' RETURN g.id AS generation ORDER BY g.createdAt, g.id;",
      { workspaceId: this.workspaceId }
    );
    return rows.flatMap((row) => typeof row.generation === "string" ? [row.generation] : []);
  }

  async abortingGenerations(): Promise<string[]> {
    const rows = await this.db.query<{ generation?: GraphValue }>(
      "MATCH (g:SchemaGeneration) WHERE g.workspaceId = $workspaceId AND g.status = 'aborting' RETURN g.id AS generation ORDER BY g.createdAt, g.id;",
      { workspaceId: this.workspaceId }
    );
    return rows.flatMap((row) => typeof row.generation === "string" ? [row.generation] : []);
  }

  async supersededGenerations(): Promise<string[]> {
    const rows = await this.db.query<{ generation?: GraphValue }>(
      "MATCH (g:SchemaGeneration) WHERE g.workspaceId = $workspaceId AND g.status = 'superseded' RETURN g.id AS generation ORDER BY g.createdAt, g.id;",
      { workspaceId: this.workspaceId }
    );
    return rows.flatMap((row) => typeof row.generation === "string" ? [row.generation] : []);
  }

  async reservedGeneration(): Promise<string | undefined> {
    const reservation = await this.reservation();
    return reservation?.kind === "full" ? reservation.generation : undefined;
  }

  async reservedRevision(): Promise<string | undefined> {
    const reservation = await this.reservation();
    return reservation?.kind === "incremental" ? reservation.revision : undefined;
  }

  async reservation(): Promise<SchemaGenerationReservation | undefined> {
    const rows = await this.db.query<GenerationStateRow>(
      "MATCH (s:SchemaGenerationState {id: $id}) RETURN " +
      "s.activeGeneration AS activeGeneration, s.pendingGeneration AS pendingGeneration, s.pendingRevision AS pendingRevision, " +
      "s.pendingParentGeneration AS pendingParentGeneration, s.pendingParentRevision AS pendingParentRevision, " +
      "s.pendingLeaseUntil AS pendingLeaseUntil;",
      { id: this.stateId() }
    );
    const state = rows[0];
    if (!state) return undefined;
    const generation = this.stringValue(state.pendingGeneration);
    const revision = this.stringValue(state.pendingRevision);
    if (generation && revision) {
      throw new Error(`Generation state is corrupt: workspace ${this.workspaceId} has both full and incremental reservations.`);
    }
    const leaseUntil = this.stringValue(state.pendingLeaseUntil);
    const parentGeneration = this.stringValue(state.pendingParentGeneration);
    const parentRevision = this.stringValue(state.pendingParentRevision);
    if (generation) return {
      kind: "full",
      generation,
      ...(parentGeneration ? { parentGeneration } : {}),
      ...(parentRevision ? { parentRevision } : {}),
      ...(leaseUntil ? { leaseUntil } : {})
    };
    if (!revision) return undefined;
    const activeGeneration = this.stringValue(state.activeGeneration);
    if (!activeGeneration || !parentRevision) {
      throw new Error(`Generation state is corrupt: incremental revision ${revision} has no active generation or parent revision.`);
    }
    return {
      kind: "incremental",
      generation: parentGeneration ?? activeGeneration,
      revision,
      parentRevision,
      ...(leaseUntil ? { leaseUntil } : {})
    };
  }

  async renewLease(reservationId: string): Promise<void> {
    await withTransaction(this.db, async () => {
      const state = await this.lockGenerationState(reservationId);
      const pendingGeneration = this.stringValue(state.pendingGeneration);
      const pendingRevision = this.stringValue(state.pendingRevision);
      if (pendingGeneration !== reservationId && pendingRevision !== reservationId) {
        throw new Error(`Schema reservation ${reservationId} lost the workspace pending reservation.`);
      }
      if (pendingGeneration) {
        const row = await this.generationRow(pendingGeneration);
        if (row?.status !== "pending") {
          throw new Error(`Schema generation ${pendingGeneration} is not pending and cannot renew its lease.`);
        }
      }
      await this.db.query(
        "MATCH (s:SchemaGenerationState {id: $id}) SET s.pendingLeaseUntil=$leaseUntil;",
        { id: this.stateId(), leaseUntil: this.nextLeaseUntil() }
      );
    });
  }

  async recoverExpiredReservation(now = new Date()): Promise<SchemaGenerationReservation | undefined> {
    if (!(await this.reservation())) return undefined;
    return withTransaction(this.db, async () => {
      const state = await this.lockGenerationState(`recovery:${now.toISOString()}`);
      const generation = this.stringValue(state.pendingGeneration);
      const revision = this.stringValue(state.pendingRevision);
      if (!generation && !revision) return undefined;
      if (generation && revision) {
        throw new Error(`Generation state is corrupt: workspace ${this.workspaceId} has both full and incremental reservations.`);
      }
      const leaseUntil = this.stringValue(state.pendingLeaseUntil);
      if (leaseUntil && Date.parse(leaseUntil) > now.getTime()) return undefined;
      const activeGeneration = this.stringValue(state.activeGeneration);
      const activeRevision = this.stringValue(state.activeRevision);
      const parentGeneration = this.stringValue(state.pendingParentGeneration);
      const parentRevision = this.stringValue(state.pendingParentRevision);
      if (generation && activeGeneration === generation) {
        throw new Error(`Generation state is corrupt: active generation ${generation} is also reserved as pending.`);
      }
      if (revision && activeRevision === revision) {
        throw new Error(`Generation state is corrupt: active revision ${revision} is also reserved as pending.`);
      }
      await this.db.query(
        "MATCH (s:SchemaGenerationState {id: $id}) " +
        "SET s.pendingGeneration='', s.pendingRevision='', s.pendingParentGeneration='', s.pendingParentRevision='', s.pendingLeaseUntil='';",
        { id: this.stateId() }
      );
      if (generation) {
        await this.db.query(
          "MATCH (g:SchemaGeneration {id: $generation}) WHERE g.workspaceId=$workspaceId AND g.status <> 'active' SET g.status=$status;",
          { generation, workspaceId: this.workspaceId, status: "aborting" }
        );
        return {
          kind: "full",
          generation,
          ...(parentGeneration ? { parentGeneration } : {}),
          ...(parentRevision ? { parentRevision } : {}),
          ...(leaseUntil ? { leaseUntil } : {})
        };
      }
      if (!revision || !activeGeneration || !parentRevision) return undefined;
      return {
        kind: "incremental",
        generation: parentGeneration ?? activeGeneration,
        revision,
        parentRevision,
        ...(leaseUntil ? { leaseUntil } : {})
      };
    });
  }

  async activeGeneration(): Promise<string | undefined> {
    const rows = await this.db.query<{ activeGeneration?: GraphValue }>(
      "MATCH (s:SchemaGenerationState {id: $id}) RETURN s.activeGeneration AS activeGeneration;",
      { id: `schema-generation-state:${this.workspaceId}` }
    );
    const value = rows[0]?.activeGeneration;
    return typeof value === "string" && value ? value : undefined;
  }

  async activeRevision(): Promise<string | undefined> {
    const rows = await this.db.query<{ activeRevision?: GraphValue }>(
      "MATCH (s:SchemaGenerationState {id: $id}) RETURN s.activeRevision AS activeRevision;",
      { id: this.stateId() }
    );
    return this.stringValue(rows[0]?.activeRevision);
  }

  async assertIncrementalCompatible(mode: "changed-only" | "watch"): Promise<void> {
    const rows = await this.db.query<{
      activeGeneration?: GraphValue;
      activeRevision?: GraphValue;
      schemaIndexVersion?: GraphValue;
      lexicalProjectionVersion?: GraphValue;
    }>(
      "MATCH (s:SchemaGenerationState {id: $id}) RETURN s.activeGeneration AS activeGeneration, " +
      "s.activeRevision AS activeRevision, s.schemaIndexVersion AS schemaIndexVersion, " +
      "s.lexicalProjectionVersion AS lexicalProjectionVersion;",
      { id: `schema-generation-state:${this.workspaceId}` }
    );
    const row = rows[0];
    const version = row?.schemaIndexVersion;
    if (version !== SCHEMA_INDEX_VERSION) {
      throw new Error(`Schema index version ${String(version ?? "missing")} is incompatible with ${mode}; clean generated graph/internal/lexical artifacts and run a full reindex (required version ${SCHEMA_INDEX_VERSION}).`);
    }
    const lexicalVersion = row?.lexicalProjectionVersion;
    if (lexicalVersion !== LEXICAL_PROJECTION_SCHEMA_VERSION) {
      throw new Error(`Lexical projection version ${String(lexicalVersion ?? "missing")} is incompatible with ${mode}; clean generated graph/internal/lexical artifacts and run a full reindex (required version ${LEXICAL_PROJECTION_SCHEMA_VERSION}).`);
    }
    if (!this.stringValue(row?.activeGeneration) || !this.stringValue(row?.activeRevision)) {
      throw new Error(`Schema generation/revision state is incomplete and incompatible with ${mode}; clean generated graph/internal/lexical artifacts and run a full reindex.`);
    }
  }

  async factsBySources<T extends OwnedSchemaFact>(
    kind: SchemaInternalFactKind,
    sources: readonly { repoId: string; fileId: string }[],
    generation?: string
  ): Promise<T[]> {
    const targetGeneration = generation ?? await this.activeGeneration();
    if (!targetGeneration || sources.length === 0) return [];
    const table = FACT_TABLES[kind];
    const facts = new Map<string, T>();
    for (const source of uniqueSources(sources)) {
      const rows = await this.db.query<{ payload?: GraphValue }>(
        `MATCH (f:${table}) WHERE f.generation = $generation AND f.repoId = $repoId AND f.fileId = $fileId RETURN f.payload AS payload;`,
        { generation: targetGeneration, repoId: source.repoId, fileId: source.fileId }
      );
      for (const fact of rows.flatMap((row) => this.parsePayload<T>(row.payload))) facts.set(fact.id, fact);
    }
    return [...facts.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  async facts<T extends OwnedSchemaFact>(
    kind: SchemaInternalFactKind,
    generation?: string
  ): Promise<T[]> {
    const targetGeneration = generation ?? await this.activeGeneration();
    if (!targetGeneration) return [];
    const rows = await this.db.query<{ payload?: GraphValue }>(
      `MATCH (f:${FACT_TABLES[kind]}) WHERE f.generation = $generation RETURN f.payload AS payload;`,
      { generation: targetGeneration }
    );
    const facts = new Map<string, T>();
    for (const fact of rows.flatMap((row) => this.parsePayload<T>(row.payload))) facts.set(fact.id, fact);
    return [...facts.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  async behaviorFingerprintsByRepos<T extends OwnedSchemaFact>(
    repoIds: readonly string[],
    generation?: string
  ): Promise<T[]> {
    const targetGeneration = generation ?? await this.activeGeneration();
    const ids = [...new Set(repoIds)].sort((left, right) => left.localeCompare(right));
    if (!targetGeneration || ids.length === 0) return [];
    const rows = await this.db.query<{ payload?: GraphValue }>(
      "MATCH (f:SchemaBehaviorFingerprintFact) WHERE f.generation = $generation " +
      "AND f.repoId IN $repoIds RETURN f.payload AS payload;",
      { generation: targetGeneration, repoIds: ids }
    );
    const facts = new Map<string, T>();
    for (const fact of rows.flatMap((row) => this.parsePayload<T>(row.payload))) facts.set(fact.id, fact);
    return [...facts.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  async factsByIds<T extends OwnedSchemaFact>(
    kind: SchemaInternalFactKind,
    factIds: readonly string[],
    generation?: string
  ): Promise<T[]> {
    const targetGeneration = generation ?? await this.activeGeneration();
    const ids = [...new Set(factIds)].sort((left, right) => left.localeCompare(right));
    if (!targetGeneration || ids.length === 0) return [];
    const storageIds = ids.map((id) => stableFactId("generation-fact", {
      generation: targetGeneration,
      id
    }));
    const rows = await this.db.query<{ payload?: GraphValue }>(
      `MATCH (f:${FACT_TABLES[kind]}) WHERE f.generation = $generation AND f.id IN $storageIds RETURN f.payload AS payload;`,
      { generation: targetGeneration, storageIds }
    );
    return rows.flatMap((row) => this.parsePayload<T>(row.payload))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  async declarationsByScopes<T extends OwnedSchemaFact>(input: {
    exactScopes: readonly ResolutionScopeIdentity[];
    scopePrefixes?: readonly DeclarationScopePrefix[];
    generation?: string;
  }): Promise<T[]> {
    const targetGeneration = input.generation ?? await this.activeGeneration();
    if (!targetGeneration) return [];
    const facts = new Map<string, T>();
    for (const scope of uniqueScopes(input.exactScopes)) {
      const rows = await this.db.query<{ payload?: GraphValue }>(
        "MATCH (f:TypeDeclarationFact) WHERE f.generation = $generation AND f.languageId = $languageId " +
        "AND f.repoId = $repoId AND f.resolutionScopeId = $resolutionScopeId RETURN f.payload AS payload;",
        {
          generation: targetGeneration,
          languageId: scope.languageId,
          repoId: scope.repoId,
          resolutionScopeId: scope.resolutionScopeId
        }
      );
      for (const fact of rows.flatMap((row) => this.parsePayload<T>(row.payload))) facts.set(fact.id, fact);
    }
    for (const scope of uniqueScopePrefixes(input.scopePrefixes ?? [])) {
      const rows = await this.db.query<{ payload?: GraphValue }>(
        "MATCH (f:TypeDeclarationFact) WHERE f.generation = $generation AND f.languageId = $languageId " +
        "AND f.repoId = $repoId AND f.resolutionScopeId STARTS WITH $resolutionScopePrefix RETURN f.payload AS payload;",
        {
          generation: targetGeneration,
          languageId: scope.languageId,
          repoId: scope.repoId,
          resolutionScopePrefix: scope.resolutionScopePrefix
        }
      );
      for (const fact of rows.flatMap((row) => this.parsePayload<T>(row.payload))) facts.set(fact.id, fact);
    }
    return [...facts.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  async dependenciesByRoots<T extends OwnedSchemaFact>(
    rootReferenceIds: readonly string[],
    generation?: string
  ): Promise<T[]> {
    const targetGeneration = generation ?? await this.activeGeneration();
    const roots = [...new Set(rootReferenceIds)].sort((left, right) => left.localeCompare(right));
    if (!targetGeneration || roots.length === 0) return [];
    const rows = await this.db.query<{ payload?: GraphValue }>(
      "MATCH (d:SchemaDependencyFact) WHERE d.generation = $generation AND d.rootReferenceId IN $rootReferenceIds RETURN d.payload AS payload;",
      { generation: targetGeneration, rootReferenceIds: roots }
    );
    return rows.flatMap((row) => this.parsePayload<T>(row.payload))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  async rootsDependingOnDeclarations<T extends OwnedSchemaFact>(
    declarationIds: readonly string[],
    generation?: string
  ): Promise<T[]> {
    const targetGeneration = generation ?? await this.activeGeneration();
    const uniqueDeclarationIds = [...new Set(declarationIds)].sort((left, right) => left.localeCompare(right));
    if (!targetGeneration || uniqueDeclarationIds.length === 0) return [];
    const dependencyRows = await this.db.query<{ rootReferenceId?: GraphValue }>(
      "MATCH (d:SchemaDependencyFact) WHERE d.generation = $generation AND d.declarationId IN $declarationIds " +
      "RETURN DISTINCT d.rootReferenceId AS rootReferenceId;",
      { generation: targetGeneration, declarationIds: uniqueDeclarationIds }
    );
    const rootReferenceIds = dependencyRows.flatMap((row) => typeof row.rootReferenceId === "string" ? [row.rootReferenceId] : []);
    if (rootReferenceIds.length === 0) return [];
    const rows = await this.db.query<{ payload?: GraphValue }>(
      "MATCH (r:SchemaRootFact) WHERE r.generation = $generation AND r.rootReferenceId IN $rootReferenceIds RETURN r.payload AS payload;",
      { generation: targetGeneration, rootReferenceIds: [...new Set(rootReferenceIds)].sort((left, right) => left.localeCompare(right)) }
    );
    return rows.flatMap((row) => this.parsePayload<T>(row.payload)).sort((left, right) => left.id.localeCompare(right.id));
  }

  /**
   * Plans affected roots from the active reverse index plus the pending source
   * overlay. Source owners, declaration dependencies, and resolution-scope
   * visibility are deliberately combined here so changed-only never has to
   * infer the workspace catalog from the current parsed-file batch.
   */
  async affectedRoots<T extends OwnedSchemaFact & {
    repoId?: string;
    ownerFileId?: string;
    resolutionContextId?: string;
  }>(input: AffectedSchemaRootsInput<T>): Promise<T[]> {
    const targetGeneration = input.generation ?? await this.activeGeneration();
    const roots = new Map<string, T>();
    const add = (facts: readonly T[]): void => {
      for (const fact of facts) roots.set(fact.id, fact);
    };
    add(input.pendingRoots ?? []);
    if (!targetGeneration) return [...roots.values()].sort((left, right) => left.id.localeCompare(right.id));

    add(await this.factsBySources<T>("roots", input.touchedSources, targetGeneration));
    add(await this.rootsDependingOnDeclarations<T>(input.changedDeclarationIds, targetGeneration));

    const scopes = uniqueScopes(input.changedResolutionScopes);
    if (scopes.length > 0) {
      const contextIds = new Set<string>();
      for (const scope of scopes) {
        const rows = await this.db.query<{ factId?: GraphValue }>(
          "MATCH (c:ResolutionContextFact) WHERE c.generation=$generation AND c.languageId=$languageId " +
          "AND c.repoId=$repoId AND c.resolutionScopeId=$resolutionScopeId RETURN c.factId AS factId;",
          { generation: targetGeneration, ...scope }
        );
        for (const row of rows) if (typeof row.factId === "string") contextIds.add(row.factId);
      }
      if (contextIds.size > 0) {
        const rows = await this.db.query<{ payload?: GraphValue }>(
          "MATCH (r:SchemaRootFact) WHERE r.generation=$generation AND r.resolutionContextId IN $contextIds RETURN r.payload AS payload;",
          { generation: targetGeneration, contextIds: [...contextIds].sort() }
        );
        add(rows.flatMap((row) => this.parsePayload<T>(row.payload)));
      }
    }
    return [...roots.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  async activeContributionCount(entityKind: "schema-spec" | "logical-relation" | "lexical-document", entityId: string): Promise<number> {
    const generation = await this.activeGeneration();
    if (!generation) return 0;
    const rows = await this.db.query<{ count?: GraphValue }>(
      "MATCH (c:SchemaContribution) WHERE c.generation = $generation AND c.entityKind = $entityKind AND c.entityId = $entityId RETURN count(c) AS count;",
      { generation, entityKind, entityId }
    );
    const value = rows[0]?.count;
    return typeof value === "bigint" || typeof value === "number" ? Number(value) : 0;
  }

  async contributionsByRoots(rootReferenceIds: readonly string[], generation?: string): Promise<SchemaContributionView[]> {
    const targetGeneration = generation ?? await this.activeGeneration();
    const roots = [...new Set(rootReferenceIds)].sort((left, right) => left.localeCompare(right));
    if (!targetGeneration || roots.length === 0) return [];
    const rows = await this.db.query<{ rootReferenceId?: GraphValue; entityKind?: GraphValue; entityId?: GraphValue; payload?: GraphValue }>(
      "MATCH (c:SchemaContribution) WHERE c.generation = $generation AND c.rootReferenceId IN $rootReferenceIds " +
      "RETURN c.rootReferenceId AS rootReferenceId, c.entityKind AS entityKind, c.entityId AS entityId, c.payload AS payload;",
      { generation: targetGeneration, rootReferenceIds: roots }
    );
    return this.parseContributionRows(rows);
  }

  async contributionsByEntities(keys: readonly SchemaContributionEntityKey[], generation?: string): Promise<SchemaContributionView[]> {
    const targetGeneration = generation ?? await this.activeGeneration();
    if (!targetGeneration || keys.length === 0) return [];
    const contributions = new Map<string, SchemaContributionView>();
    for (const key of uniqueContributionKeys(keys)) {
      const rows = await this.db.query<{ rootReferenceId?: GraphValue; entityKind?: GraphValue; entityId?: GraphValue; payload?: GraphValue }>(
        "MATCH (c:SchemaContribution) WHERE c.generation = $generation AND c.entityKind = $entityKind AND c.entityId = $entityId " +
        "RETURN c.rootReferenceId AS rootReferenceId, c.entityKind AS entityKind, c.entityId AS entityId, c.payload AS payload;",
        { generation: targetGeneration, entityKind: key.entityKind, entityId: key.entityId }
      );
      for (const contribution of this.parseContributionRows(rows)) {
        contributions.set(contributionKey(contribution), contribution);
      }
    }
    return [...contributions.values()].sort(compareContributions);
  }

  async contributionVisibilityForReplacements(input: {
    generation?: string;
    replacements: readonly SchemaContributionReplacement[];
    previousContributions?: readonly SchemaContributionView[];
  }): Promise<SchemaContributionVisibilityChange[]> {
    const targetGeneration = input.generation ?? await this.activeGeneration();
    if (!targetGeneration || input.replacements.length === 0) return [];
    const replacedRoots = new Set<string>();
    for (const replacement of input.replacements) {
      if (replacedRoots.has(replacement.rootReferenceId)) {
        throw new Error(`Duplicate contribution replacement for root ${replacement.rootReferenceId}.`);
      }
      replacedRoots.add(replacement.rootReferenceId);
    }
    const previousForRoots = input.previousContributions
      ? [...input.previousContributions]
      : await this.contributionsByRoots([...replacedRoots], targetGeneration);
    const affectedKeys = uniqueContributionKeys([
      ...previousForRoots,
      ...input.replacements.flatMap((replacement) => replacement.contributions)
    ]);
    if (affectedKeys.length === 0) return [];
    const previousForEntities = await this.contributionsByEntities(affectedKeys, targetGeneration);
    const next = new Map<string, SchemaContributionView>();
    for (const contribution of previousForEntities) {
      if (!replacedRoots.has(contribution.rootReferenceId)) next.set(contributionKey(contribution), contribution);
    }
    for (const replacement of input.replacements) {
      for (const contribution of replacement.contributions) {
        const view = { ...contribution, rootReferenceId: replacement.rootReferenceId };
        next.set(contributionKey(view), view);
      }
    }
    return affectedKeys.map((key) => ({
      ...key,
      previousCount: previousForEntities.filter((item) => sameContributionEntity(item, key)).length,
      nextCount: [...next.values()].filter((item) => sameContributionEntity(item, key)).length,
      previousContributions: previousForEntities.filter((item) => sameContributionEntity(item, key)).sort(compareContributions),
      contributions: [...next.values()].filter((item) => sameContributionEntity(item, key)).sort(compareContributions)
    }));
  }

  private parsePayload<T>(payload: GraphValue | undefined): T[] {
    if (typeof payload !== "string") return [];
    try {
      const parsed: unknown = JSON.parse(payload);
      return parsed && typeof parsed === "object" ? [parsed as T] : [];
    } catch {
      return [];
    }
  }

  private parseContributionRows(
    rows: readonly { rootReferenceId?: GraphValue; entityKind?: GraphValue; entityId?: GraphValue; payload?: GraphValue }[]
  ): SchemaContributionView[] {
    return rows.flatMap((row) => {
      if (typeof row.rootReferenceId !== "string" || typeof row.entityId !== "string"
        || (row.entityKind !== "schema-spec" && row.entityKind !== "logical-relation" && row.entityKind !== "lexical-document")) return [];
      const contribution: SchemaContributionView = {
        rootReferenceId: row.rootReferenceId,
        entityKind: row.entityKind,
        entityId: row.entityId,
        payload: this.parsePayload<unknown>(row.payload)[0]
      };
      return [contribution];
    }).sort(compareContributions);
  }

  private async replaceSourceFactsUnchecked(input: {
    generation: string;
    revision: string;
    kind: SchemaInternalFactKind;
    repoId: string;
    fileId: string;
    facts: readonly OwnedSchemaFact[];
  }): Promise<void> {
    const table = FACT_TABLES[input.kind];
    await this.db.query(
      `MATCH (f:${table}) WHERE f.generation = $generation AND f.repoId = $repoId AND f.fileId = $fileId DELETE f;`,
      { generation: input.generation, repoId: input.repoId, fileId: input.fileId }
    );
    const replacementId = stableFactId("schema-replacement", {
      generation: input.generation,
      kind: input.kind,
      repoId: input.repoId,
      fileId: input.fileId
    });
    await this.db.query(
      "MERGE (r:SchemaSourceReplacement {id: $id}) " +
      "SET r.generation=$generation, r.revision=$revision, r.repoId=$repoId, r.fileId=$fileId, r.factKind=$factKind, r.tombstone=$tombstone;",
      {
        id: replacementId,
        generation: input.generation,
        revision: input.revision,
        repoId: input.repoId,
        fileId: input.fileId,
        factKind: input.kind,
        tombstone: input.facts.length === 0
      }
    );
    for (const fact of [...input.facts].sort((left, right) => left.id.localeCompare(right.id))) {
      await this.insertFact(table, input.generation, input.repoId, input.fileId, fact);
    }
  }

  private async replaceBehaviorFingerprintsUnchecked(input: {
    generation: string;
    revision: string;
    repoId: string;
    languageId: string;
    resolutionScopeId: string;
    facts: readonly OwnedSchemaFact[];
  }): Promise<void> {
    await this.db.query(
      "MATCH (f:SchemaBehaviorFingerprintFact) " +
      "WHERE f.generation=$generation AND f.repoId=$repoId AND f.languageId=$languageId " +
      "AND f.resolutionScopeId=$resolutionScopeId DELETE f;",
      {
        generation: input.generation,
        repoId: input.repoId,
        languageId: input.languageId,
        resolutionScopeId: input.resolutionScopeId
      }
    );
    const replacementId = stableFactId("schema-behavior-replacement", {
      generation: input.generation,
      repoId: input.repoId,
      languageId: input.languageId,
      resolutionScopeId: input.resolutionScopeId
    });
    await this.db.query(
      "MERGE (r:SchemaBehaviorReplacement {id: $id}) " +
      "SET r.generation=$generation, r.revision=$revision, r.repoId=$repoId, r.languageId=$languageId, " +
      "r.resolutionScopeId=$resolutionScopeId, r.tombstone=$tombstone;",
      {
        id: replacementId,
        generation: input.generation,
        revision: input.revision,
        repoId: input.repoId,
        languageId: input.languageId,
        resolutionScopeId: input.resolutionScopeId,
        tombstone: input.facts.length === 0
      }
    );
    for (const fact of [...input.facts].sort((left, right) => left.id.localeCompare(right.id))) {
      const payload = { ...fact, generation: input.generation };
      await this.db.query(
        "MERGE (f:SchemaBehaviorFingerprintFact {id: $storageId}) " +
        "SET f.generation=$generation, f.repoId=$repoId, f.fileId='', f.languageId=$languageId, " +
        "f.resolutionScopeId=$resolutionScopeId, f.factId=$factId, f.payload=$payload;",
        {
          storageId: stableFactId("generation-fact", { generation: input.generation, id: fact.id }),
          generation: input.generation,
          repoId: input.repoId,
          languageId: input.languageId,
          resolutionScopeId: input.resolutionScopeId,
          factId: fact.id,
          payload: canonicalSerialize(payload)
        }
      );
    }
  }

  private async insertFact(table: string, generation: string, repoId: string, fileId: string, fact: OwnedSchemaFact): Promise<void> {
    const payload = { ...fact, generation };
    const indexed = factIndexProperties(table, fact);
    const indexedAssignments = Object.keys(indexed).map((key) => `f.${key}=$${key}`).join(", ");
    await this.db.query(
      `MERGE (f:${table} {id: $storageId}) SET f.generation=$generation, f.repoId=$repoId, f.fileId=$fileId, f.payload=$payload` +
      (indexedAssignments ? `, ${indexedAssignments};` : ";"),
      {
        storageId: stableFactId("generation-fact", { generation, id: fact.id }),
        generation,
        repoId: fact.repoId ?? repoId,
        fileId: fact.sourceFileId ?? fileId,
        payload: canonicalSerialize(payload),
        ...indexed
      }
    );
  }

  private stateId(): string {
    return `schema-generation-state:${this.workspaceId}`;
  }

  private stringValue(value: GraphValue | undefined): string | undefined {
    return typeof value === "string" && value ? value : undefined;
  }

  private async lockGenerationState(nonce: string): Promise<GenerationStateRow> {
    const rows = await this.db.query<GenerationStateRow>(
      "MERGE (s:SchemaGenerationState {id: $id}) " +
      "ON CREATE SET s.workspaceId=$workspaceId, s.activeGeneration='', s.activeRevision='', " +
      "s.pendingGeneration='', s.pendingRevision='', s.pendingParentGeneration='', s.pendingParentRevision='', " +
      "s.pendingLeaseUntil='', s.schemaIndexVersion=$schemaIndexVersion, s.lexicalProjectionVersion=$lexicalProjectionVersion " +
      "SET s.protocolNonce=$nonce " +
      "RETURN s.activeGeneration AS activeGeneration, s.activeRevision AS activeRevision, " +
      "s.pendingGeneration AS pendingGeneration, s.pendingRevision AS pendingRevision, " +
      "s.pendingParentGeneration AS pendingParentGeneration, s.pendingParentRevision AS pendingParentRevision, " +
      "s.pendingLeaseUntil AS pendingLeaseUntil;",
      {
        id: this.stateId(),
        workspaceId: this.workspaceId,
        schemaIndexVersion: SCHEMA_INDEX_VERSION,
        lexicalProjectionVersion: LEXICAL_PROJECTION_SCHEMA_VERSION,
        nonce
      }
    );
    return rows[0] ?? {};
  }

  private async readGenerationState(): Promise<GenerationStateRow> {
    const rows = await this.db.query<GenerationStateRow>(
      "MATCH (s:SchemaGenerationState {id: $id}) RETURN " +
      "s.activeGeneration AS activeGeneration, s.activeRevision AS activeRevision, " +
      "s.pendingGeneration AS pendingGeneration, s.pendingRevision AS pendingRevision, " +
      "s.pendingParentGeneration AS pendingParentGeneration, s.pendingParentRevision AS pendingParentRevision, " +
      "s.pendingLeaseUntil AS pendingLeaseUntil;",
      { id: this.stateId() }
    );
    return rows[0] ?? {};
  }

  private async generationRow(generation: string): Promise<GenerationRow | undefined> {
    const rows = await this.db.query<GenerationRow>(
      "MATCH (g:SchemaGeneration {id: $generation}) WHERE g.workspaceId=$workspaceId " +
      "RETURN g.activeRevision AS activeRevision, g.parentGeneration AS parentGeneration, g.schemaIndexVersion AS schemaIndexVersion, g.status AS status;",
      { generation, workspaceId: this.workspaceId }
    );
    return rows[0];
  }

  private assertFullCommitCandidate(
    generation: string,
    state: GenerationStateRow,
    row: GenerationRow | undefined
  ): asserts row is GenerationRow {
    if (!row || row.status !== "pending" || row.schemaIndexVersion !== SCHEMA_INDEX_VERSION) {
      throw new Error(`Schema generation ${generation} failed compatibility validation.`);
    }
    const reserved = this.stringValue(state.pendingGeneration);
    if (reserved !== generation) {
      throw new Error(`Schema generation ${generation} no longer owns the workspace pending reservation.`);
    }
    if (this.stringValue(state.pendingRevision)) {
      throw new Error(`Schema generation ${generation} cannot commit while an incremental revision is reserved.`);
    }
    const active = this.stringValue(state.activeGeneration);
    const parent = this.stringValue(row.parentGeneration);
    const reservedParent = this.stringValue(state.pendingParentGeneration);
    if (active !== parent || active !== reservedParent) {
      throw new Error(`Schema generation ${generation} is stale; active parent changed during staging.`);
    }
    const activeRevision = this.stringValue(state.activeRevision);
    const parentRevision = this.stringValue(state.pendingParentRevision);
    if (activeRevision !== parentRevision) {
      throw new Error(`Schema generation ${generation} is stale; active revision changed during staging.`);
    }
    const leaseUntil = this.stringValue(state.pendingLeaseUntil);
    if (!leaseUntil || Date.parse(leaseUntil) <= Date.now()) {
      throw new Error(`Schema generation ${generation} no longer holds a valid workspace lease.`);
    }
  }

  private assertIncrementalCommitCandidate(
    revision: string,
    state: GenerationStateRow
  ): ValidatedIncrementalSchemaRevision {
    if (this.stringValue(state.pendingGeneration)) {
      throw new Error(`Schema revision ${revision} cannot commit while a full generation is reserved.`);
    }
    if (this.stringValue(state.pendingRevision) !== revision) {
      throw new Error(`Schema revision ${revision} no longer owns the workspace pending reservation.`);
    }
    const generation = this.stringValue(state.activeGeneration);
    const activeRevision = this.stringValue(state.activeRevision);
    const parentGeneration = this.stringValue(state.pendingParentGeneration);
    const parentRevision = this.stringValue(state.pendingParentRevision);
    if (!generation || generation !== parentGeneration) {
      throw new Error(`Schema revision ${revision} is stale; active physical generation changed during staging.`);
    }
    if (!activeRevision || activeRevision !== parentRevision) {
      throw new Error(`Schema revision ${revision} is stale; active parent revision changed during staging.`);
    }
    const leaseUntil = this.stringValue(state.pendingLeaseUntil);
    if (!leaseUntil || Date.parse(leaseUntil) <= Date.now()) {
      throw new Error(`Schema revision ${revision} no longer holds a valid workspace lease.`);
    }
    return { generation, parentRevision, revision };
  }

  private async assertPhysicalGenerationRevision(validated: ValidatedIncrementalSchemaRevision): Promise<void> {
    const row = await this.generationRow(validated.generation);
    if (!row || row.status !== "active" || this.stringValue(row.activeRevision) !== validated.parentRevision) {
      throw new Error(
        `Schema revision ${validated.revision} is stale; physical generation ${validated.generation} ` +
        `does not expose parent revision ${validated.parentRevision}.`
      );
    }
  }

  private assertExpectedActiveState(input: {
    operation: string;
    state: GenerationStateRow;
    expectedActiveGeneration: string | null;
    expectedActiveRevision: string | null;
  }): void {
    const activeGeneration = this.stringValue(input.state.activeGeneration) ?? null;
    const activeRevision = this.stringValue(input.state.activeRevision) ?? null;
    if (activeGeneration !== input.expectedActiveGeneration || activeRevision !== input.expectedActiveRevision) {
      throw new Error(
        `Cannot ${input.operation}; expected active generation/revision ` +
        `${input.expectedActiveGeneration ?? "none"}/${input.expectedActiveRevision ?? "none"}, found ` +
        `${activeGeneration ?? "none"}/${activeRevision ?? "none"}.`
      );
    }
  }

  private assertNoPendingReservation(state: GenerationStateRow, requestedId: string): void {
    const pendingGeneration = this.stringValue(state.pendingGeneration);
    const pendingRevision = this.stringValue(state.pendingRevision);
    if (pendingGeneration || pendingRevision) {
      throw new Error(
        `Cannot reserve ${requestedId}; workspace ${this.workspaceId} is already staging ` +
        `${pendingGeneration ? `generation ${pendingGeneration}` : `revision ${pendingRevision}`}.`
      );
    }
  }

  private async assertIncrementalActiveTarget(generation: string): Promise<string> {
    const state = await this.readGenerationState();
    const revision = this.stringValue(state.pendingRevision);
    if (!revision) throw new Error(`Active schema generation ${generation} has no reserved incremental revision.`);
    const validated = this.assertIncrementalCommitCandidate(revision, state);
    if (validated.generation !== generation) {
      throw new Error(`Schema incremental mutation targets ${generation}, but the active physical generation is ${validated.generation}.`);
    }
    return revision;
  }

  private nextLeaseUntil(): string {
    return new Date(Date.now() + SCHEMA_GENERATION_LEASE_MS).toISOString();
  }

  private async assertPending(generation: string): Promise<void> {
    const rows = await this.db.query<{ status?: GraphValue }>(
      "MATCH (g:SchemaGeneration {id: $generation}) WHERE g.workspaceId = $workspaceId RETURN g.status AS status;",
      { generation, workspaceId: this.workspaceId }
    );
    if (rows[0]?.status !== "pending") throw new Error(`Schema generation ${generation} is not pending.`);
  }
}

function uniqueSources(sources: readonly { repoId: string; fileId: string }[]): { repoId: string; fileId: string }[] {
  return [...new Map(sources.map((source) => [`${source.repoId}\0${source.fileId}`, source])).values()]
    .sort((left, right) => left.repoId.localeCompare(right.repoId) || left.fileId.localeCompare(right.fileId));
}

function uniqueScopes(scopes: readonly ResolutionScopeIdentity[]): ResolutionScopeIdentity[] {
  return [...new Map(scopes.map((scope) => [
    `${scope.languageId}\0${scope.repoId}\0${scope.resolutionScopeId}`,
    scope
  ])).values()].sort((left, right) =>
    left.languageId.localeCompare(right.languageId)
    || left.repoId.localeCompare(right.repoId)
    || left.resolutionScopeId.localeCompare(right.resolutionScopeId));
}

function uniqueScopePrefixes(scopes: readonly DeclarationScopePrefix[]): DeclarationScopePrefix[] {
  return [...new Map(scopes.map((scope) => [
    `${scope.languageId}\0${scope.repoId}\0${scope.resolutionScopePrefix}`,
    scope
  ])).values()].sort((left, right) =>
    left.languageId.localeCompare(right.languageId)
    || left.repoId.localeCompare(right.repoId)
    || left.resolutionScopePrefix.localeCompare(right.resolutionScopePrefix));
}

function uniqueContributionKeys(keys: readonly SchemaContributionEntityKey[]): SchemaContributionEntityKey[] {
  return [...new Map(keys.map((key) => [`${key.entityKind}\0${key.entityId}`, {
    entityKind: key.entityKind,
    entityId: key.entityId
  }])).values()].sort((left, right) =>
    left.entityKind.localeCompare(right.entityKind) || left.entityId.localeCompare(right.entityId));
}

function contributionKey(contribution: SchemaContributionView): string {
  return `${contribution.rootReferenceId}\0${contribution.entityKind}\0${contribution.entityId}`;
}

function compareContributions(left: SchemaContributionView, right: SchemaContributionView): number {
  return contributionKey(left).localeCompare(contributionKey(right));
}

function sameContributionEntity(left: SchemaContributionEntityKey, right: SchemaContributionEntityKey): boolean {
  return left.entityKind === right.entityKind && left.entityId === right.entityId;
}

function factIndexProperties(table: string, fact: OwnedSchemaFact): Record<string, GraphValue> {
  const value = fact as unknown as Record<string, unknown>;
  const indexed: Record<string, GraphValue> = { factId: fact.id };
  const addString = (column: string, candidate: unknown): void => {
    indexed[column] = typeof candidate === "string" ? candidate : "";
  };
  const identity = objectProperty(value.identity);
  const scope = objectProperty(value.scope);
  const from = objectProperty(value.from);
  const to = objectProperty(value.to);
  if (table === "TypeDeclarationFact") {
    addString("languageId", identity.languageId);
    addString("resolutionScopeId", identity.resolutionScopeId);
    addString("canonicalName", identity.canonicalName);
  } else if (table === "ResolutionContextFact") {
    addString("languageId", value.languageId);
    addString("resolutionScopeId", value.resolutionScopeId);
  } else if (table === "ResolutionScopeDependencyFact") {
    addString("sourceContextId", value.sourceContextId);
    addString("fromLanguageId", from.languageId);
    addString("fromRepoId", from.repoId);
    addString("fromResolutionScopeId", from.resolutionScopeId);
    addString("toLanguageId", to.languageId);
    addString("toRepoId", to.repoId);
    addString("toResolutionScopeId", to.resolutionScopeId);
  } else if (table === "SchemaRootFact") {
    addString("rootReferenceId", fact.id);
    addString("ownerFileId", value.ownerFileId);
    addString("ownerSpecId", value.ownerSpecId);
    addString("resolutionContextId", value.resolutionContextId);
    addString("languageId", value.languageId);
  } else if (table === "SchemaDependencyFact") {
    addString("rootReferenceId", value.rootReferenceId);
    addString("declarationId", value.declarationId);
  } else if (table === "SchemaProvenanceFact") {
    addString("rootReferenceId", value.rootReferenceId);
    addString("relationId", value.relationId);
  } else if (table === "SchemaDiagnosticFact") {
    addString("rootReferenceId", value.rootReferenceId);
    addString("ownerSpecId", value.ownerSpecId);
    addString("languageId", scope.languageId);
    addString("resolutionScopeId", scope.resolutionScopeId);
  } else if (table === "SchemaBehaviorFingerprintFact") {
    addString("languageId", value.languageId);
    addString("resolutionScopeId", value.resolutionScopeId);
  }
  return indexed;
}

function objectProperty(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
