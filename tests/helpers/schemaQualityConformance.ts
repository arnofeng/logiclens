import { expect } from "vitest";
import type { GraphDB } from "../../src/core/graph-model/db.js";
import { SchemaGenerationStore } from "../../src/core/schema/generationStore.js";
import type {
  SchemaDiagnosticFact,
  SchemaRelationProvenance,
  SchemaRootReference,
  TypeDeclarationFact
} from "../../src/core/schema/model.js";
import { querySchemaQuality } from "../../src/core/schema/quality.js";

export async function runSchemaQualityConformance(db: GraphDB, workspaceId: string): Promise<void> {
  const store = new SchemaGenerationStore(db, workspaceId);
  const oldGeneration = `${workspaceId}:generation:old`;
  const activeGeneration = `${workspaceId}:generation:active`;
  await store.beginFull({
    generation: oldGeneration,
    createdAt: "2026-01-01T00:00:00.000Z",
    expectedActiveGeneration: null,
    expectedActiveRevision: null
  });
  await replaceQualityFacts(store, oldGeneration, "old", "unresolved");
  await store.commitFull(oldGeneration);
  expect((await querySchemaQuality(db, workspaceId, { details: ["unresolved"] })).details)
    .toEqual([expect.objectContaining({ diagnosticId: "diagnostic:old" })]);

  await store.beginFull({
    generation: activeGeneration,
    createdAt: "2026-01-02T00:00:00.000Z",
    expectedActiveGeneration: oldGeneration,
    expectedActiveRevision: oldGeneration
  });
  await replaceQualityFacts(store, activeGeneration, "active", "ambiguous");
  await store.commitFull(activeGeneration);

  const report = await querySchemaQuality(db, workspaceId, {
    groupBy: "language",
    details: ["ambiguous", "unresolved"]
  });
  expect(report.generation).toBe(activeGeneration);
  expect(report.summary.rootOutcomes).toEqual({
    roots: 1,
    resolved: 0,
    unresolved: 0,
    external: 0,
    ambiguous: 1,
    unsupported: 0,
    truncated: 0
  });
  expect(report.summary.diagnosticEntries).toEqual({
    total: 2,
    unresolved: 0,
    external: 0,
    ambiguous: 2,
    unsupported: 0,
    truncated: 0
  });
  expect(report.groups).toEqual([expect.objectContaining({ value: "java" })]);
  expect(report.details.map((detail) => detail.diagnosticId)).toEqual([
    "diagnostic:active",
    "diagnostic:active:second"
  ]);
  expect(JSON.stringify(report)).not.toContain("diagnostic:old");
}

async function replaceQualityFacts(
  store: SchemaGenerationStore,
  generation: string,
  suffix: string,
  code: "unresolved" | "ambiguous"
): Promise<void> {
  const repoId = "repo:quality";
  const fileId = `file:${suffix}`;
  const root: SchemaRootReference = {
    id: `root:${suffix}`,
    repoId,
    ownerSpecId: `spec:${suffix}`,
    ownerFileId: fileId,
    relationKind: "RESPONSE_SCHEMA",
    languageId: "java",
    frameworkId: "spring-mvc",
    rawTypeExpression: "Payload",
    resolutionContextId: `context:${suffix}`,
    slot: { kind: "return" },
    evidenceId: `evidence:${suffix}`,
    generation
  };
  const identity = {
    languageId: "java",
    repoId,
    resolutionScopeId: "module:main",
    canonicalName: `fixture.${suffix}.Payload`
  };
  const declaration: TypeDeclarationFact = {
    id: `declaration:${suffix}`,
    identity,
    fileId,
    declarationKind: "class",
    typeParameters: [],
    candidate: {
      declaration: identity,
      displayName: "Payload",
      typeParameters: [],
      shape: { kind: "object", fields: [] },
      fileId,
      filePath: `src/${suffix}/Payload.java`,
      sourceSymbolId: `symbol:${suffix}`,
      framework: "java-source",
      evidence: { line: 7, raw: `class ${suffix}Payload {}`, rule: "java.class", confidence: 1 }
    },
    generation
  };
  const diagnostic = (id: string, fieldPath: string[]): SchemaDiagnosticFact => ({
    id,
    generation,
    repoId,
    sourceFileId: fileId,
    ownerSpecId: root.ownerSpecId,
    rootReferenceId: root.id,
    scope: { languageId: "java", repoId, resolutionScopeId: "module:main" },
    code,
    symbol: "Payload",
    typePath: [{ kind: "reference", name: "Payload" }],
    fieldPath,
    candidates: code === "ambiguous" ? [identity] : undefined
  });
  const provenance: SchemaRelationProvenance = {
    id: `provenance:${suffix}`,
    relationId: `relation:${suffix}`,
    rootReferenceId: root.id,
    sourceFileId: fileId,
    rawTypeExpression: "Payload",
    typePath: [],
    fieldPath: [],
    declarationIds: [],
    resolution: code,
    generation
  };
  await store.appendFullGenerationBatch({
    generation,
    facts: {
      declarations: [{ ...declaration, repoId, sourceFileId: fileId }],
      resolutionContexts: [],
      resolutionScopeDependencies: [],
      roots: [{ ...root, sourceFileId: fileId }],
      dependencies: [],
      provenance: [{ ...provenance, repoId, sourceFileId: fileId }],
      diagnostics: code === "ambiguous"
        ? [{ ...diagnostic(`diagnostic:${suffix}`, []), sourceFileId: fileId }, { ...diagnostic(`diagnostic:${suffix}:second`, ["nested"]), sourceFileId: fileId }]
        : [{ ...diagnostic(`diagnostic:${suffix}`, []), sourceFileId: fileId }],
      fingerprints: []
    },
    contributions: []
  });
}
