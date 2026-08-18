import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KuzuGraphDB, withTransaction } from "../src/core/graph-model/db.js";
import {
  SchemaGenerationStore,
  type FullSchemaGenerationInput,
  type OwnedSchemaFact
} from "../src/core/schema/generationStore.js";
import type { ResolutionContextFact, SchemaBehaviorFingerprint, SchemaDependencyFact, SchemaRootReference, TypeDeclarationFact } from "../src/core/schema/model.js";
import { SCHEMA_INDEX_VERSION, typeDeclarationIdentityId } from "../src/core/schema/model.js";
import { runSchemaReplacementConformance } from "./helpers/schemaReplacementConformance.js";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))));

async function store(workspaceId = "workspace:test"): Promise<{ db: KuzuGraphDB; generations: SchemaGenerationStore }> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "repohelix-schema-generation-"));
  directories.push(directory);
  const db = await KuzuGraphDB.open(path.join(directory, "graph"));
  await db.initSchema("schema-generation-test");
  return { db, generations: new SchemaGenerationStore(db, workspaceId) };
}

async function beginInitial(generations: SchemaGenerationStore, generation: string): Promise<void> {
  await generations.beginFull({
    generation,
    createdAt: "2026-01-01T00:00:00.000Z",
    expectedActiveGeneration: null,
    expectedActiveRevision: null
  });
}

function fullFacts(
  overrides: Partial<FullSchemaGenerationInput["facts"]> = {}
): FullSchemaGenerationInput["facts"] {
  return {
    declarations: [],
    resolutionContexts: [],
    resolutionScopeDependencies: [],
    roots: [],
    dependencies: [],
    provenance: [],
    diagnostics: [],
    fingerprints: [],
    ...overrides
  };
}

describe("schema generation and incremental revision lifecycle", () => {
  it("stages a full generation in bounded append-only batches without replacement metadata", async () => {
    const { db, generations } = await store();
    try {
      await beginInitial(generations, "generation:batched");
      const querySpy = vi.spyOn(db, "query");
      querySpy.mockClear();
      await generations.appendFullGenerationBatch({
        generation: "generation:batched",
        facts: fullFacts({
          declarations: ["a", "b"].map((suffix) => ({
            id: `declaration:${suffix}`,
            repoId: "repo:a",
            sourceFileId: `file:${suffix}`
          }))
        }),
        contributions: [{
          rootReferenceId: "root:a",
          entityKind: "schema-spec",
          entityId: "spec:a"
        }]
      });

      const stagingQueries = querySpy.mock.calls.map(([query]) => query);
      expect(stagingQueries.filter((query) => query.startsWith("UNWIND $rows AS row CREATE"))).toHaveLength(2);
      expect(stagingQueries.some((query) => /Schema(?:Source|Behavior|Contribution)Replacement/u.test(query))).toBe(false);
      expect(stagingQueries).toHaveLength(3);
      expect((await generations.facts("declarations", "generation:batched")).map((fact) => fact.id))
        .toEqual(["declaration:a", "declaration:b"]);
      expect(await generations.activeContributionCount("schema-spec", "spec:a")).toBe(0);
      await generations.commitFull("generation:batched");
      expect(await generations.activeContributionCount("schema-spec", "spec:a")).toBe(1);
    } finally {
      await db.close();
    }
  });

  it("runs the provider-neutral replacement conformance harness on Kuzu", async () => {
    const { db } = await store("workspace:kuzu-conformance");
    try {
      await runSchemaReplacementConformance(db, "workspace:kuzu-conformance");
    } finally {
      await db.close();
    }
  }, 15_000);

  it("starts a full generation empty instead of cloning parent facts or contributions", async () => {
    const { db, generations } = await store();
    try {
      await beginInitial(generations, "generation:base");
      await generations.appendFullGenerationBatch({
        generation: "generation:base",
        facts: fullFacts({ declarations: [{ id: "declaration:base", repoId: "repo:a", sourceFileId: "file:a" }] }),
        contributions: [{ rootReferenceId: "root:base", entityKind: "schema-spec", entityId: "spec:base" }]
      });
      await generations.commitFull("generation:base");

      await generations.beginFull({
        generation: "generation:next-full",
        createdAt: "2026-01-02T00:00:00.000Z",
        expectedActiveGeneration: "generation:base",
        expectedActiveRevision: "generation:base"
      });
      expect(await db.query(
        "MATCH (f:TypeDeclarationFact) WHERE f.generation=$generation RETURN f.factId AS factId;",
        { generation: "generation:next-full" }
      )).toEqual([]);
      expect(await db.query(
        "MATCH (c:SchemaContribution) WHERE c.generation=$generation RETURN c.entityId AS entityId;",
        { generation: "generation:next-full" }
      )).toEqual([]);
      await generations.rollback("generation:next-full");
      expect(await generations.activeGeneration()).toBe("generation:base");
      expect(await generations.activeRevision()).toBe("generation:base");
    } finally {
      await db.close();
    }
  });

  it("loads declarations through exact canonical scopes and import-path prefixes", async () => {
    const { db, generations } = await store();
    try {
      await beginInitial(generations, "generation:scopes");
      const declaration = (scope: string, canonicalName: string, fileId: string): TypeDeclarationFact => {
        const identity = {
          languageId: "go",
          repoId: "repo:a",
          resolutionScopeId: scope,
          canonicalName
        };
        return {
          id: typeDeclarationIdentityId(identity),
          identity,
          fileId,
          declarationKind: "object",
          typeParameters: [],
          generation: "generation:scopes"
        };
      };
      const selected = declaration("package:example.com/service/pkg/contracts:contracts", "Payload", "file:payload");
      const unrelated = declaration("package:example.com/service/internal/state:state", "Payload", "file:state");
      await generations.appendFullGenerationBatch({
        generation: "generation:scopes",
        facts: fullFacts({
          declarations: [selected, unrelated].map((fact) => ({
            ...fact,
            repoId: fact.identity.repoId,
            sourceFileId: fact.fileId
          }))
        }),
        contributions: []
      });
      await generations.commitFull("generation:scopes");

      expect(await generations.declarationsByScopes<TypeDeclarationFact>({
        exactScopes: [],
        scopePrefixes: [{
          languageId: "go",
          repoId: "repo:a",
          resolutionScopePrefix: "package:example.com/service/pkg/contracts:"
        }]
      })).toEqual([expect.objectContaining({ id: selected.id })]);
      expect(await generations.declarationsByScopes<TypeDeclarationFact>({
        exactScopes: [selected.identity]
      })).toEqual([expect.objectContaining({ id: selected.id })]);
    } finally {
      await db.close();
    }
  });

  it("does not create incremental replacement metadata for an empty full generation", async () => {
    const { db, generations } = await store();
    try {
      await beginInitial(generations, "generation:empty");
      await generations.appendFullGenerationBatch({
        generation: "generation:empty",
        facts: fullFacts(),
        contributions: []
      });
      await generations.commitFull("generation:empty");
      for (const table of ["SchemaSourceReplacement", "SchemaContributionReplacement", "SchemaBehaviorReplacement"]) {
        expect(await db.query(`MATCH (r:${table}) RETURN r.id AS id;`)).toEqual([]);
      }
    } finally {
      await db.close();
    }
  });

  it("reserves and commits an incremental revision without changing the physical generation", async () => {
    const { db, generations } = await store();
    try {
      await beginInitial(generations, "generation:active");
      await generations.appendFullGenerationBatch({
        generation: "generation:active",
        facts: fullFacts({ declarations: [{ id: "declaration:old", repoId: "repo:a", sourceFileId: "file:a" }] }),
        contributions: []
      });
      await generations.commitFull("generation:active");
      const querySpy = vi.spyOn(db, "query");
      querySpy.mockClear();
      await generations.reserveIncremental({
        revision: "revision:two",
        expectedActiveGeneration: "generation:active",
        expectedActiveRevision: "generation:active"
      });
      const reservationQueries = querySpy.mock.calls.map(([query]) => query);
      expect(reservationQueries.some((query) => /TypeDeclarationFact|SchemaContribution|SKIP\s+\d+\s+LIMIT/iu.test(query))).toBe(false);
      expect(await generations.reservation()).toEqual(expect.objectContaining({
        kind: "incremental",
        generation: "generation:active",
        revision: "revision:two",
        parentRevision: "generation:active"
      }));
      expect(await generations.validateIncremental("revision:two")).toEqual({
        generation: "generation:active",
        parentRevision: "generation:active",
        revision: "revision:two"
      });

      await withTransaction(db, async () => {
        await generations.applyActiveReplacementBatch({
          generation: "generation:active",
          revision: "revision:two",
          sourceReplacements: [{
            kind: "declarations",
            repoId: "repo:a",
            fileId: "file:a",
            facts: [{ id: "declaration:new", repoId: "repo:a", sourceFileId: "file:a" }]
          }],
          behaviorFingerprintReplacements: [],
          contributionReplacements: []
        });
        await generations.commitIncremental("revision:two");
      });

      expect(await generations.activeGeneration()).toBe("generation:active");
      expect(await generations.activeRevision()).toBe("revision:two");
      expect((await generations.factsBySources(
        "declarations",
        [{ repoId: "repo:a", fileId: "file:a" }],
        "generation:active"
      )).map((fact) => fact.id)).toEqual(["declaration:new"]);
      expect(await db.query<{ count: number | bigint }>(
        "MATCH (f:TypeDeclarationFact) WHERE f.generation=$generation RETURN count(f) AS count;",
        { generation: "generation:active" }
      )).toEqual([{ count: 1 }]);
    } finally {
      await db.close();
    }
  });

  it("rolls back active replacements and revision advancement with the provider transaction", async () => {
    const { db, generations } = await store();
    try {
      await beginInitial(generations, "generation:rollback");
      await generations.appendFullGenerationBatch({
        generation: "generation:rollback",
        facts: fullFacts({ declarations: [{ id: "declaration:stable", repoId: "repo:a", sourceFileId: "file:a" }] }),
        contributions: []
      });
      await generations.commitFull("generation:rollback");
      await generations.reserveIncremental({
        revision: "revision:failed",
        expectedActiveGeneration: "generation:rollback",
        expectedActiveRevision: "generation:rollback"
      });
      await expect(withTransaction(db, async () => {
        await generations.applyActiveReplacementBatch({
          generation: "generation:rollback",
          revision: "revision:failed",
          sourceReplacements: [{ kind: "declarations", repoId: "repo:a", fileId: "file:a", facts: [] }],
          behaviorFingerprintReplacements: [],
          contributionReplacements: []
        });
        await generations.commitIncremental("revision:failed");
        throw new Error("injected failure before provider commit");
      })).rejects.toThrow(/injected failure/u);
      await generations.abandonIncremental("revision:failed");

      expect(await generations.activeGeneration()).toBe("generation:rollback");
      expect(await generations.activeRevision()).toBe("generation:rollback");
      expect((await generations.factsBySources(
        "declarations",
        [{ repoId: "repo:a", fileId: "file:a" }],
        "generation:rollback"
      )).map((fact) => fact.id)).toEqual(["declaration:stable"]);
    } finally {
      await db.close();
    }
  });

  it("rejects stale parent revisions and competing full or incremental reservations", async () => {
    const { db, generations } = await store();
    try {
      await beginInitial(generations, "generation:guard");
      await generations.commitFull("generation:guard");
      await expect(generations.reserveIncremental({
        revision: "revision:stale",
        expectedActiveGeneration: "generation:guard",
        expectedActiveRevision: "revision:not-active"
      })).rejects.toThrow(/expected active generation\/revision/u);
      await generations.reserveIncremental({
        revision: "revision:held",
        expectedActiveGeneration: "generation:guard",
        expectedActiveRevision: "generation:guard"
      });
      await expect(generations.beginFull({
        generation: "generation:competitor",
        createdAt: "2026-01-02T00:00:00.000Z",
        expectedActiveGeneration: "generation:guard",
        expectedActiveRevision: "generation:guard"
      })).rejects.toThrow(/already staging revision revision:held/u);
      await generations.abandonIncremental("revision:held");
      expect(await generations.reservedRevision()).toBeUndefined();
    } finally {
      await db.close();
    }
  });

  it("recovers an expired incremental reservation without changing active data", async () => {
    const { db, generations } = await store();
    try {
      await beginInitial(generations, "generation:lease");
      await generations.commitFull("generation:lease");
      await generations.reserveIncremental({
        revision: "revision:expired",
        expectedActiveGeneration: "generation:lease",
        expectedActiveRevision: "generation:lease"
      });
      await db.query(
        "MATCH (s:SchemaGenerationState {id: $id}) SET s.pendingLeaseUntil=$leaseUntil;",
        { id: "schema-generation-state:workspace:test", leaseUntil: "2026-01-01T00:02:00.000Z" }
      );
      expect(await generations.recoverExpiredReservation(new Date("2026-01-01T00:03:00.000Z")))
        .toEqual(expect.objectContaining({ kind: "incremental", revision: "revision:expired", generation: "generation:lease" }));
      expect(await generations.activeGeneration()).toBe("generation:lease");
      expect(await generations.activeRevision()).toBe("generation:lease");
      expect(await generations.reservation()).toBeUndefined();
    } finally {
      await db.close();
    }
  });

  it("plans contribution visibility from affected roots and entities only", async () => {
    const { db, generations } = await store();
    try {
      await beginInitial(generations, "generation:contributions");
      await generations.appendFullGenerationBatch({
        generation: "generation:contributions",
        facts: fullFacts(),
        contributions: ["root:a", "root:b"].flatMap((rootReferenceId) => [
            { entityKind: "schema-spec" as const, entityId: "spec:shared" },
            {
              entityKind: "logical-relation" as const,
              entityId: "relation:shared",
              payload: { fromSpecId: "spec:owner", toSpecId: "spec:shared", kind: "USES_SCHEMA", evidenceId: `evidence:${rootReferenceId}` }
            }
          ].map((contribution) => ({ ...contribution, rootReferenceId })))
      });
      await generations.commitFull("generation:contributions");

      const retained = await generations.contributionVisibilityForReplacements({
        replacements: [{ rootReferenceId: "root:a", contributions: [] }]
      });
      expect(retained).toEqual(expect.arrayContaining([
        expect.objectContaining({ entityKind: "schema-spec", entityId: "spec:shared", previousCount: 2, nextCount: 1 }),
        expect.objectContaining({ entityKind: "logical-relation", entityId: "relation:shared", previousCount: 2, nextCount: 1 })
      ]));
      expect(retained.find((item) => item.entityKind === "logical-relation")?.previousContributions).toHaveLength(2);

      const removed = await generations.contributionVisibilityForReplacements({
        replacements: [
          { rootReferenceId: "root:a", contributions: [] },
          { rootReferenceId: "root:b", contributions: [] }
        ]
      });
      expect(removed.every((item) => item.nextCount === 0)).toBe(true);
    } finally {
      await db.close();
    }
  });

  it("supports targeted source and reverse-declaration reads from denormalized facts", async () => {
    const { db, generations } = await store();
    try {
      await beginInitial(generations, "generation:targeted");
      const roots: Array<SchemaRootReference & OwnedSchemaFact> = ["a", "b"].map((suffix) => ({
        id: `root:${suffix}`,
        repoId: "repo:a",
        ownerSpecId: `spec:${suffix}`,
        ownerFileId: `file:${suffix}`,
        sourceFileId: `file:${suffix}`,
        relationKind: "USES_SCHEMA",
        languageId: "typescript",
        frameworkId: "test",
        rawTypeExpression: "Payload",
        resolutionContextId: `context:${suffix}`,
        slot: { kind: "field" },
        evidenceId: `evidence:${suffix}`,
        generation: ""
      }));
      const contexts: Array<ResolutionContextFact & OwnedSchemaFact> = [];
      const dependencies: Array<SchemaDependencyFact & OwnedSchemaFact> = [];
      for (const root of roots) {
        contexts.push({
          id: root.resolutionContextId,
          languageId: "typescript",
          repoId: "repo:a",
          resolutionScopeId: "module:shared",
          fileId: root.ownerFileId,
          sourceFileId: root.ownerFileId,
          imports: [],
          enclosingDeclarationIds: [],
          genericBindings: [],
          generation: ""
        });
        dependencies.push({
          id: `dependency:${root.id}`,
          repoId: "repo:a",
          sourceFileId: root.ownerFileId,
          rootReferenceId: root.id,
          declarationId: root.id === "root:a" ? "declaration:changed" : "declaration:other",
          fieldPath: [],
          generation: ""
        });
      }
      const fingerprint: SchemaBehaviorFingerprint = {
        id: "schema-behavior:typescript",
        languageId: "typescript",
        repoId: "repo:a",
        resolutionScopeId: "module:shared",
        adapterVersion: "1",
        ruleSetVersion: "rules-1",
        serializationVersion: "wire-1",
        maxDepth: 12,
        maxTypesPerRoot: 256,
        buildInputsHash: "inputs",
        generation: ""
      };
      await generations.appendFullGenerationBatch({
        generation: "generation:targeted",
        facts: fullFacts({
          resolutionContexts: contexts,
          roots,
          dependencies,
          fingerprints: [fingerprint]
        }),
        contributions: []
      });
      await generations.commitFull("generation:targeted");

      expect((await generations.factsBySources("roots", [{ repoId: "repo:a", fileId: "file:a" }])).map((fact) => fact.id))
        .toEqual(["root:a"]);
      expect((await generations.rootsDependingOnDeclarations<SchemaRootReference & OwnedSchemaFact>(["declaration:changed"])).map((fact) => fact.id))
        .toEqual(["root:a"]);
      expect(await generations.behaviorFingerprintsByRepos<SchemaBehaviorFingerprint>(["repo:missing", "repo:a"]))
        .toEqual([{ ...fingerprint, generation: "generation:targeted" }]);
      const pendingRoot: SchemaRootReference & OwnedSchemaFact = {
        ...roots[0]!,
        id: "root:pending",
        ownerSpecId: "spec:pending",
        ownerFileId: "file:pending",
        sourceFileId: "file:pending",
        resolutionContextId: "context:pending"
      };
      expect((await generations.affectedRoots({
        touchedSources: [{ repoId: "repo:a", fileId: "file:b" }],
        changedDeclarationIds: ["declaration:changed"],
        changedResolutionScopes: [{
          languageId: "typescript",
          repoId: "repo:a",
          resolutionScopeId: "module:shared"
        }],
        pendingRoots: [pendingRoot]
      })).map((fact) => fact.id)).toEqual(["root:a", "root:b", "root:pending"]);
    } finally {
      await db.close();
    }
  });

  it("rejects old or incomplete revision state for changed-only and watch", async () => {
    const { db, generations } = await store();
    try {
      await beginInitial(generations, "generation:version");
      await generations.commitFull("generation:version");
      await db.query("MATCH (s:SchemaGenerationState) SET s.schemaIndexVersion=$version;", { version: "3" });
      await expect(generations.assertIncrementalCompatible("changed-only")).rejects.toThrow(/clean generated graph\/internal\/lexical artifacts/u);
      await expect(generations.assertIncrementalCompatible("watch")).rejects.toThrow(/clean generated graph\/internal\/lexical artifacts/u);
      await db.query(
        "MATCH (s:SchemaGenerationState) SET s.schemaIndexVersion=$schemaVersion, s.lexicalProjectionVersion=$lexicalVersion;",
        { schemaVersion: SCHEMA_INDEX_VERSION, lexicalVersion: "1" }
      );
      await expect(generations.assertIncrementalCompatible("changed-only")).rejects.toThrow(/Lexical projection version 1/u);
      await expect(generations.assertIncrementalCompatible("watch")).rejects.toThrow(/clean generated graph\/internal\/lexical artifacts/u);
    } finally {
      await db.close();
    }
  });
});
