import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CrossRepoExtraction } from "../src/core/contracts/extraction/crossRepoContracts.js";
import { applyIncrementalSchemaMutation, buildCombinedIncrementalSchemaVisibility, stageSchemaGenerationFacts } from "../src/core/schema/staging.js";
import type { SchemaGenerationStore } from "../src/core/schema/generationStore.js";
import { stableFactId } from "../src/core/schema/model.js";
import type { LexicalDocument } from "../src/core/retrieval/types.js";
import { KuzuGraphDB } from "../src/adapters/graph-db/kuzu/KuzuGraphDB.js";
import type { ContractSpecNode, SemanticRelationEdge } from "../src/core/parsing/types.js";

function extraction(): CrossRepoExtraction {
  return {
    contracts: [],
    evidence: [],
    entities: [],
    repoContracts: [],
    repoDependencies: [],
    contractEntities: [],
    operations: [],
    workflows: [],
    operationRepos: [],
    workflowOperations: [],
    packageUsages: [],
    contractSpecs: [{
      id: "spec:source",
      contractId: "contract:source",
      specKind: "schema",
      repoId: "repo:one",
      fileId: "file:source",
      evidenceId: "evidence:spec",
      canonicalKey: "Source",
      specJson: "{}",
      confidence: 1
    }],
    contractSpecEdges: [],
    semanticRelations: [
      {
        fromSpecId: "spec:source",
        toSpecId: "spec:target",
        kind: "USES_SCHEMA",
        evidenceId: "evidence:first",
        reason: "first path",
        confidence: 0.8
      },
      {
        fromSpecId: "spec:source",
        toSpecId: "spec:target",
        kind: "USES_SCHEMA",
        evidenceId: "evidence:second",
        reason: "second path",
        confidence: 0.9
      }
    ],
    schemaInternalFacts: {
      declarations: [],
      resolutionContexts: [],
      resolutionScopeDependencies: [],
      roots: [],
      dependencies: [],
      provenance: [],
      diagnostics: [],
      fingerprints: []
    },
    schemaDeclarations: []
  };
}

describe("schema generation contribution staging", () => {
  it("physically GCs a shared spec and relation only after the final contribution disappears", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "repohelix-schema-gc-"));
    const db = await KuzuGraphDB.open(path.join(directory, "graph"));
    const scope = { workspaceId: "workspace:schema-gc", generation: "generation:active" };
    const source: ContractSpecNode = {
      id: "spec:source",
      contractId: "contract:source",
      specKind: "schema",
      repoId: "repo:one",
      fileId: "file:source",
      evidenceId: "evidence:source",
      canonicalKey: "Source",
      specJson: "{}",
      confidence: 1,
      batchId: "batch:initial",
      indexedAt: "2026-01-01T00:00:00.000Z",
      active: true
    };
    const target: ContractSpecNode = {
      ...source,
      id: "spec:target",
      contractId: "contract:target",
      fileId: "file:target",
      evidenceId: "evidence:target",
      canonicalKey: "Target"
    };
    const relation: SemanticRelationEdge = {
      fromSpecId: source.id,
      toSpecId: target.id,
      kind: "USES_SCHEMA",
      evidenceId: "evidence:root",
      reason: "field target",
      confidence: 1,
      batchId: "batch:initial",
      active: true
    };
    const store = {
      applyActiveReplacementBatch: vi.fn(async () => undefined)
    } as unknown as SchemaGenerationStore;
    try {
      await db.initSchema("schema-gc-test");
      await db.upsertContractSpec(source, scope);
      await db.upsertContractSpec(target, scope);
      await db.addSemanticRelation(relation, scope);
      await applyIncrementalSchemaMutation({
        db,
        store,
        workspaceId: scope.workspaceId,
        generation: scope.generation,
        revision: "revision:one-root-left",
        mutation: {
          sourceFactReplacements: [],
          behaviorFingerprintReplacements: [],
          contributionReplacements: [],
          upsertLexicalDocuments: [],
          deleteLexicalDocumentIds: [],
          visibilityChanges: [
            {
              entityKind: "schema-spec",
              entityId: target.id,
              previousCount: 2,
              nextCount: 1,
              previousContributions: [],
              contributions: [{ rootReferenceId: "root:b", entityKind: "schema-spec", entityId: target.id, payload: target }]
            },
            {
              entityKind: "logical-relation",
              entityId: "relation:source-target",
              previousCount: 2,
              nextCount: 1,
              previousContributions: [],
              contributions: [{ rootReferenceId: "root:b", entityKind: "logical-relation", entityId: "relation:source-target", payload: relation }]
            }
          ]
        }
      });
      expect(await db.query<{ count: number }>(
        "MATCH (n:ContractSpec) WHERE n.workspaceId=$workspaceId AND n.generation=$generation AND n.id=$id RETURN count(n) AS count",
        { ...scope, id: target.id }
      )).toEqual([{ count: 1 }]);

      await applyIncrementalSchemaMutation({
        db,
        store,
        workspaceId: scope.workspaceId,
        generation: scope.generation,
        revision: "revision:no-roots-left",
        mutation: {
          sourceFactReplacements: [],
          behaviorFingerprintReplacements: [],
          contributionReplacements: [],
          upsertLexicalDocuments: [],
          deleteLexicalDocumentIds: [],
          visibilityChanges: [
            {
              entityKind: "logical-relation",
              entityId: "relation:source-target",
              previousCount: 1,
              nextCount: 0,
              previousContributions: [{ rootReferenceId: "root:b", entityKind: "logical-relation", entityId: "relation:source-target", payload: relation }],
              contributions: []
            },
            {
              entityKind: "schema-spec",
              entityId: target.id,
              previousCount: 1,
              nextCount: 0,
              previousContributions: [{ rootReferenceId: "root:b", entityKind: "schema-spec", entityId: target.id, payload: target }],
              contributions: []
            }
          ]
        }
      });
      const [specRows, relationRows] = await Promise.all([
        db.query<{ count: number }>(
          "MATCH (n:ContractSpec) WHERE n.workspaceId=$workspaceId AND n.generation=$generation AND n.id=$id RETURN count(n) AS count",
          { ...scope, id: target.id }
        ),
        db.query<{ count: number }>(
          "MATCH (:ContractSpec)-[r:SEMANTIC_REL]->(:ContractSpec) WHERE r.workspaceId=$workspaceId AND r.generation=$generation RETURN count(r) AS count",
          scope
        )
      ]);
      expect(specRows).toEqual([{ count: 0 }]);
      expect(relationRows).toEqual([{ count: 0 }]);
    } finally {
      await db.close();
    }
  }, 20000);

  it("does not rewrite a semantically unchanged lexical document when only its contribution count changes", async () => {
    const document = {
      id: "lexical:schema:shared",
      canonicalId: "spec:schema:shared",
      workspaceId: "workspace:test",
      repoId: "repo:one",
      kind: "contractSpec",
      title: "Shared",
      path: "src/shared.ts",
      searchableText: "shared schema payload",
      tokens: ["shared", "schema", "payload"],
      active: true,
      sourceHash: "hash:shared",
      batchId: "batch:previous",
      renderRef: "render:shared"
    } satisfies LexicalDocument;
    const store = {
      contributionVisibilityForReplacements: vi.fn(async () => [{
        entityKind: "lexical-document" as const,
        entityId: document.id,
        previousCount: 2,
        nextCount: 1,
        previousContributions: [{
          rootReferenceId: "root:a",
          entityKind: "lexical-document" as const,
          entityId: document.id,
          payload: document
        }],
        contributions: [{
          rootReferenceId: "root:b",
          entityKind: "lexical-document" as const,
          entityId: document.id,
          payload: { ...document, batchId: "batch:next" }
        }]
      }])
    } as unknown as SchemaGenerationStore;

    const mutation = await buildCombinedIncrementalSchemaVisibility({
      store,
      generation: "generation:active",
      mutations: [{
        sourceFactReplacements: [],
        behaviorFingerprintReplacements: [],
        contributionReplacements: [{ rootReferenceId: "root:a", contributions: [] }],
        visibilityChanges: [],
        upsertLexicalDocuments: [],
        deleteLexicalDocumentIds: []
      }]
    });

    expect(mutation.upsertLexicalDocuments).toEqual([]);
    expect(mutation.deleteLexicalDocumentIds).toEqual([]);
  });

  it("stages one evidence-independent logical relation contribution with deterministic evidence attributes", async () => {
    const replacements: Array<{
      rootReferenceId: string;
      contributions: readonly { entityKind: string; entityId: string; payload?: unknown }[];
    }> = [];
    const store = {
      activeFacts: vi.fn(async () => []),
      activeContributions: vi.fn(async () => []),
      replaceContributions: vi.fn(async (input: {
        rootReferenceId: string;
        contributions: readonly { entityKind: string; entityId: string; payload?: unknown }[];
      }) => {
        replacements.push(input);
      }),
      reconcilePendingContributionVisibility: vi.fn(async () => ({ lexicalDocumentIds: [] }))
    } as unknown as SchemaGenerationStore;

    await stageSchemaGenerationFacts({
      store,
      generation: "generation:pending",
      parsedFiles: [],
      extraction: extraction(),
      lexicalDocuments: []
    });

    const logicalRelations = replacements
      .find((replacement) => replacement.rootReferenceId === "declaration:spec:source")!
      .contributions.filter((contribution) => contribution.entityKind === "logical-relation");
    expect(logicalRelations).toHaveLength(1);
    expect(logicalRelations[0]).toEqual(expect.objectContaining({
      payload: expect.objectContaining({ evidenceId: "evidence:second", reason: "second path", confidence: 0.9 })
    }));
  });

  it("retains root-specific evidence in separate contributions for one shared logical relation", async () => {
    const value = extraction();
    const relationId = stableFactId("schema-relation", {
      fromSpecId: "spec:source",
      toSpecId: "spec:target",
      kind: "USES_SCHEMA"
    });
    value.schemaInternalFacts.roots = ["a", "b"].map((suffix) => ({
      id: `root:${suffix}`,
      repoId: "repo:one",
      ownerSpecId: "spec:source",
      ownerFileId: `file:${suffix}`,
      relationKind: "REQUEST_SCHEMA",
      languageId: "typescript",
      frameworkId: "test",
      rawTypeExpression: "Target",
      resolutionContextId: `context:${suffix}`,
      slot: { kind: "parameter", index: 0 },
      evidenceId: `evidence:${suffix}`,
      generation: ""
    }));
    value.schemaInternalFacts.provenance = ["a", "b"].map((suffix) => ({
      id: `provenance:${suffix}`,
      relationId,
      rootReferenceId: `root:${suffix}`,
      sourceFileId: `file:${suffix}`,
      rawTypeExpression: "Target",
      typePath: [],
      fieldPath: [],
      declarationIds: [],
      resolution: "resolved",
      evidenceId: `evidence:${suffix}`,
      generation: ""
    }));
    const replacements: Array<{
      rootReferenceId: string;
      contributions: readonly { entityKind: string; entityId: string; payload?: unknown }[];
    }> = [];
    const store = {
      activeFacts: vi.fn(async () => []),
      activeContributions: vi.fn(async () => []),
      replaceContributions: vi.fn(async (input: {
        rootReferenceId: string;
        contributions: readonly { entityKind: string; entityId: string; payload?: unknown }[];
      }) => replacements.push(input)),
      reconcilePendingContributionVisibility: vi.fn(async () => ({ lexicalDocumentIds: [] }))
    } as unknown as SchemaGenerationStore;

    await stageSchemaGenerationFacts({
      store,
      generation: "generation:pending",
      parsedFiles: [],
      extraction: value,
      lexicalDocuments: []
    });

    const evidenceByRoot = new Map(replacements
      .filter((replacement) => replacement.rootReferenceId.startsWith("root:"))
      .map((replacement) => [
        replacement.rootReferenceId,
        (replacement.contributions.find((contribution) => contribution.entityKind === "logical-relation")?.payload as { evidenceId?: string } | undefined)?.evidenceId
      ]));
    expect(evidenceByRoot).toEqual(new Map([
      ["root:a", "evidence:a"],
      ["root:b", "evidence:b"]
    ]));
  });

  it("preserves an existing source owner when its referenced root is absent", async () => {
    const value = extraction();
    value.schemaInternalFacts.dependencies = [{
      id: "dependency:owned",
      rootReferenceId: "root:missing",
      declarationId: "declaration:target",
      fieldPath: ["target"],
      generation: "",
      repoId: "repo:one",
      sourceFileId: "file:owned"
    } as CrossRepoExtraction["schemaInternalFacts"]["dependencies"][number] & { repoId: string; sourceFileId: string }];
    const replacements: Array<{ kind: string; repoId: string; fileId: string; facts: readonly { id: string; sourceFileId?: string }[] }> = [];
    const store = {
      replaceSourceFacts: vi.fn(async (input: { kind: string; repoId: string; fileId: string; facts: readonly { id: string; sourceFileId?: string }[] }) => {
        replacements.push(input);
      }),
      activeFacts: vi.fn(async () => []),
      activeContributions: vi.fn(async () => []),
      replaceContributions: vi.fn(async () => undefined),
      reconcilePendingContributionVisibility: vi.fn(async () => ({ lexicalDocumentIds: [] }))
    } as unknown as SchemaGenerationStore;
    const parsedFiles = ["file:owned", "file:other"].map((fileId) => ({
      repoId: "repo:one", fileId, path: `${fileId}.ts`, language: "typescript", hash: "hash", loc: 1,
      imports: [], symbols: [], calls: []
    }));

    await stageSchemaGenerationFacts({
      store,
      generation: "generation:pending",
      parsedFiles,
      extraction: value,
      lexicalDocuments: []
    });

    expect(replacements.find((item) => item.kind === "dependencies" && item.fileId === "file:owned")?.facts)
      .toEqual([expect.objectContaining({ id: "dependency:owned", sourceFileId: "file:owned" })]);
    expect(replacements.find((item) => item.kind === "dependencies" && item.fileId === "file:other")?.facts).toEqual([]);
  });

  it("stages behavior fingerprints by repo/language/scope instead of source replacement", async () => {
    const value = extraction();
    value.schemaInternalFacts.fingerprints = [{
      id: "schema-behavior:scope",
      languageId: "typescript",
      repoId: "repo:one",
      resolutionScopeId: "module:models",
      adapterVersion: "1",
      ruleSetVersion: "rules-1",
      serializationVersion: "wire-1",
      maxDepth: 12,
      maxTypesPerRoot: 256,
      buildInputsHash: "inputs:shape-and-context",
      generation: ""
    }];
    const sourceReplacements: Array<{ kind: string }> = [];
    const behaviorReplacements: Array<{
      replacement: { repoId: string; languageId: string; resolutionScopeId: string; facts: readonly { id: string }[] };
    }> = [];
    const store = {
      replaceSourceFacts: vi.fn(async (input: { kind: string }) => sourceReplacements.push(input)),
      replaceBehaviorFingerprints: vi.fn(async (input: {
        replacement: { repoId: string; languageId: string; resolutionScopeId: string; facts: readonly { id: string }[] };
      }) => behaviorReplacements.push(input)),
      replaceContributions: vi.fn(async () => undefined)
    } as unknown as SchemaGenerationStore;

    await stageSchemaGenerationFacts({
      store,
      generation: "generation:pending",
      parsedFiles: [{
        repoId: "repo:one", fileId: "file:source", path: "source.ts", language: "typescript", hash: "hash", loc: 1,
        imports: [], symbols: [], calls: []
      }],
      extraction: value,
      lexicalDocuments: []
    });

    expect(sourceReplacements.some((replacement) => replacement.kind === "fingerprints")).toBe(false);
    expect(behaviorReplacements).toEqual([expect.objectContaining({
      replacement: expect.objectContaining({
        repoId: "repo:one",
        languageId: "typescript",
        resolutionScopeId: "module:models",
        facts: [expect.objectContaining({ id: "schema-behavior:scope" })]
      })
    })]);
  });
});
