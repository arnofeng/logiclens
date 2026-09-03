import { describe, expect, it, vi } from "vitest";
import type { GraphDB, GraphValue } from "../src/core/graph-model/db.js";
import type { GraphFactsBatch } from "../src/core/graph-model/facts.js";
import { publicNodeStorageId } from "../src/core/graph-model/publicGraphGeneration.js";
import type { IncrementalIndexMutationSet, IncrementalRepoMutation } from "../src/core/indexing/incrementalMutation.js";
import { validateIncrementalIndexMutationEndpoints } from "../src/core/indexing/incrementalValidation.js";
import type { ContractSpecNode, EvidenceNode, RepoNode, SemanticRelationEdge } from "../src/core/parsing/types.js";
import type { OwnedSchemaFact } from "../src/core/schema/generationStore.js";
import type {
  SchemaDependencyFact,
  SchemaRelationProvenance,
  SchemaRootReference,
  TypeDeclarationFact
} from "../src/core/schema/model.js";

const WORKSPACE_ID = "workspace:incremental-validation";
const GENERATION = "generation:active";

function repo(id: string): RepoNode {
  return {
    id,
    name: id,
    path: `/workspace/${id}`,
    remoteUrl: "",
    branch: "main",
    commitSha: "commit",
    language: "typescript",
    indexedAt: "2026-01-01T00:00:00.000Z"
  };
}

function emptyFacts(): GraphFactsBatch {
  return {
    batchId: "batch:incremental-validation",
    workspaceId: WORKSPACE_ID,
    generation: GENERATION,
    systemName: "validation-test",
    indexedAt: "2026-01-01T00:00:00.000Z",
    repos: [],
    parsedFiles: [],
    files: [],
    code: [],
    sections: [],
    entities: [],
    operations: [],
    workflows: [],
    contracts: [],
    evidence: [],
    contains: [],
    imports: [],
    calls: [],
    mentions: [],
    sectionDescribesRepos: [],
    sectionDocumentsCode: [],
    sectionReferencesFile: [],
    repoContracts: [],
    packageUsages: [],
    contractEntities: [],
    operationRepos: [],
    workflowOperations: [],
    repoDependencies: [],
    contractSpecs: [],
    contractSpecEdges: [],
    semanticRelations: [],
    crossRepo: {
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
      contractSpecs: [],
      contractSpecEdges: [],
      semanticRelations: [],
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
    }
  };
}

function mutationSet(facts: GraphFactsBatch): IncrementalIndexMutationSet {
  const mutation: IncrementalRepoMutation = {
    batchId: facts.batchId,
    indexedAt: facts.indexedAt,
    repos: facts.repos,
    parsedFiles: [],
    selection: { mode: "merge", fast: false, fallbackToMerge: false },
    publicGraph: {
      facts,
      touchedFileIds: [],
      deletedFileIds: [],
      activeFileIdsByRepo: new Map(),
      replacement: {
        sourceFileIds: [],
        deletedFileIds: [],
        existingEvidenceIds: [],
        staleCodeIds: [],
        staleSectionIds: [],
        staleEvidenceIds: [],
        staleSpecIds: [],
        orphanEntityIds: [],
        orphanOperationIds: [],
        orphanWorkflowIds: [],
        orphanContractIds: []
      }
    },
    schema: emptySchemaMutation(),
    summaries: { kind: "none" }
  };
  return {
    workspaceId: WORKSPACE_ID,
    targetGeneration: GENERATION,
    expectedActiveRevision: "revision:previous",
    nextRevision: "revision:next",
    repoMutations: [mutation],
    schemaVisibility: emptySchemaMutation(),
    schemaSupportGc: {
      deletedSpecIds: [],
      evidenceIds: [],
      contractIds: [],
      entityIds: []
    },
    dependencyMutation: {
      affectedSpecIds: [],
      affectedContractIds: [],
      upsertSemanticRelations: [],
      upsertRepoDependencies: []
    },
    publicGraphStatsDelta: {
      repos: 0,
      files: 0,
      codeNodes: 0,
      sectionNodes: 0,
      callEdges: 0,
      importEdges: 0,
      entities: 0
    }
  };
}

function emptySchemaMutation() {
  return {
    sourceFactReplacements: [],
    behaviorFingerprintReplacements: [],
    contributionReplacements: [],
    visibilityChanges: []
  };
}

type QueryResponder = (
  statement: string,
  params?: Record<string, GraphValue>
) => Promise<unknown[]>;

function dbWithQuery(responder: QueryResponder): GraphDB {
  const query: GraphDB["query"] = async <T = Record<string, GraphValue>>(
    statement: string,
    params?: Record<string, GraphValue>
  ): Promise<T[]> => await responder(statement, params) as T[];
  return { query } as unknown as GraphDB;
}

describe("incremental endpoint validation", () => {
  it("rejects a missing relationship endpoint", async () => {
    const facts = emptyFacts();
    facts.files.push({
      id: "file:source",
      repoId: "repo:source",
      path: "source.ts",
      directory: "",
      language: "typescript",
      hash: "hash",
      loc: 1
    });
    facts.imports.push({
      fromFileId: "file:source",
      toFileId: "file:missing",
      module: "./missing.js",
      raw: "./missing.js"
    });
    const query = vi.fn<QueryResponder>(async () => []);

    await expect(validateIncrementalIndexMutationEndpoints(dbWithQuery(query), mutationSet(facts)))
      .rejects.toThrow("dangling File endpoint(s): file:missing (IMPORTS target)");
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("rejects an endpoint scheduled for deletion without querying the parent snapshot", async () => {
    const facts = emptyFacts();
    facts.files.push({
      id: "file:source",
      repoId: "repo:source",
      path: "source.ts",
      directory: "",
      language: "typescript",
      hash: "hash",
      loc: 1
    });
    facts.imports.push({
      fromFileId: "file:source",
      toFileId: "file:deleted",
      module: "./deleted.js",
      raw: "./deleted.js"
    });
    const mutation = mutationSet(facts);
    mutation.repoMutations[0]!.publicGraph.replacement.deletedFileIds.push("file:deleted");
    const query = vi.fn<QueryResponder>(async () => []);

    await expect(validateIncrementalIndexMutationEndpoints(dbWithQuery(query), mutation))
      .rejects.toThrow("dangling File endpoint(s): file:deleted (IMPORTS target)");
    expect(query).not.toHaveBeenCalled();
  });

  it("uses exact generation-scoped storage IDs for existing endpoints", async () => {
    const facts = emptyFacts();
    facts.files.push({
      id: "file:source",
      repoId: "repo:source",
      path: "source.ts",
      directory: "",
      language: "typescript",
      hash: "hash",
      loc: 1
    });
    facts.imports.push({
      fromFileId: "file:source",
      toFileId: "file:existing",
      module: "./existing.js",
      raw: "./existing.js"
    });
    const query = vi.fn<QueryResponder>(async (_statement, params) => {
      expect(params).toEqual({
        workspaceId: WORKSPACE_ID,
        generation: GENERATION,
        storageIds: [publicNodeStorageId(GENERATION, "file:existing")]
      });
      return [{ id: "file:existing" }];
    });

    await expect(validateIncrementalIndexMutationEndpoints(dbWithQuery(query), mutationSet(facts)))
      .resolves.toBeUndefined();
    expect(query).toHaveBeenCalledWith(expect.stringContaining("n.storageId IN $storageIds"), expect.any(Object));
    expect(query).toHaveBeenCalledWith(expect.stringContaining("n.generation = $generation"), expect.any(Object));
  });

  it("validates prepared dependency contracts and relation provenance evidence", async () => {
    const facts = emptyFacts();
    facts.repos.push(repo("repo:consumer"), repo("repo:producer"));
    facts.contracts.push(
      { id: "contract:consumer", kind: "api", key: "consumer", name: "consumer", description: "" },
      { id: "contract:producer", kind: "api", key: "producer", name: "producer", description: "" }
    );
    facts.contractSpecs.push(
      schemaSpec("spec:consumer", "contract:consumer", "repo:consumer"),
      schemaSpec("spec:producer", "contract:producer", "repo:producer")
    );
    const mutation = mutationSet(facts);
    mutation.dependencyMutation = {
      affectedSpecIds: ["spec:consumer", "spec:producer"],
      affectedContractIds: ["contract:consumer", "contract:producer"],
      upsertSemanticRelations: [{
        fromSpecId: "spec:consumer",
        toSpecId: "spec:producer",
        kind: "USES_SCHEMA",
        evidenceId: "evidence:missing-provenance",
        reason: "typed dependency",
        confidence: 1
      }],
      upsertRepoDependencies: [{
        fromRepoId: "repo:consumer",
        toRepoId: "repo:producer",
        dependencyType: "shared-contract",
        sourceContractId: "contract:consumer",
        targetContractId: "contract:producer",
        evidenceId: "evidence:missing-provenance",
        raw: "typed dependency",
        confidence: 1
      }]
    };
    const query = vi.fn<QueryResponder>(async () => []);

    await expect(validateIncrementalIndexMutationEndpoints(dbWithQuery(query), mutation))
      .rejects.toThrow(
        "evidence:missing-provenance (prepared DEPENDS_ON evidence, prepared SEMANTIC_REL evidence)"
      );
  });

  it("treats schema contribution specs as pending upserts and validates their provenance", async () => {
    const facts = emptyFacts();
    facts.repos.push(repo("repo:schema"));
    const proof = evidence("evidence:schema-root", "repo:schema");
    facts.evidence.push(proof);
    const source = schemaSpec("spec:schema-source", "contract:schema-source", "repo:schema");
    const target = schemaSpec("spec:schema-target", "contract:schema-target", "repo:schema");
    const relation: SemanticRelationEdge = {
      fromSpecId: source.id,
      toSpecId: target.id,
      kind: "USES_SCHEMA",
      evidenceId: proof.id,
      reason: "shared target",
      confidence: 1
    };
    const mutation = mutationSet(facts);
    mutation.schemaVisibility = {
      ...emptySchemaMutation(),
      visibilityChanges: [
        visibility("schema-spec", source.id, source),
        visibility("schema-spec", target.id, target),
        visibility("logical-relation", "relation:source-target", relation)
      ]
    };
    const query = vi.fn<QueryResponder>(async () => []);

    await expect(validateIncrementalIndexMutationEndpoints(dbWithQuery(query), mutation))
      .resolves.toBeUndefined();
    expect(query).not.toHaveBeenCalled();
  });

  it("resolves dependency declaration and root endpoints with bounded exact-ID reads", async () => {
    const mutation = mutationSet(emptyFacts());
    mutation.repoMutations[0]!.schema.sourceFactReplacements = [{
      kind: "dependencies",
      repoId: "repo:schema",
      fileId: "file:owner",
      facts: [dependency("dependency:existing", "root:existing", "declaration:existing")]
    }];
    const query = vi.fn<QueryResponder>(async (statement, params) => {
      if (statement.includes("TypeDeclarationFact")) {
        expect(params).toEqual({ generation: GENERATION, factIds: ["declaration:existing"] });
        return [{ id: "declaration:existing" }];
      }
      if (statement.includes("SchemaRootFact")) {
        expect(params).toEqual({ generation: GENERATION, factIds: ["root:existing"] });
        return [{ id: "root:existing" }];
      }
      throw new Error(`Unexpected validation query: ${statement}`);
    });

    await expect(validateIncrementalIndexMutationEndpoints(dbWithQuery(query), mutation))
      .resolves.toBeUndefined();
    expect(query).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("f.factId IN $factIds"), expect.any(Object));
  });

  it("rejects a dependency that points at a declaration tombstoned by source replacement", async () => {
    const mutation = mutationSet(emptyFacts());
    mutation.repoMutations[0]!.schema.sourceFactReplacements = [
      {
        kind: "declarations",
        repoId: "repo:schema",
        fileId: "file:deleted",
        facts: []
      },
      {
        kind: "dependencies",
        repoId: "repo:schema",
        fileId: "file:owner",
        facts: [dependency("dependency:stale", "root:existing", "declaration:deleted")]
      }
    ];
    const query = vi.fn<QueryResponder>(async (statement) => {
      if (statement.includes("f.repoId = $repoId")) return [{ factId: "declaration:deleted" }];
      throw new Error(`Tombstoned declaration must not be looked up as active: ${statement}`);
    });

    await expect(validateIncrementalIndexMutationEndpoints(dbWithQuery(query), mutation))
      .rejects.toThrow(
        "dangling Schema declaration endpoint(s): declaration:deleted (Schema dependency dependency:stale)"
      );
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("validates provenance root, relation, declaration, and optional evidence endpoints", async () => {
    const facts = emptyFacts();
    facts.repos.push(repo("repo:schema"));
    facts.evidence.push(evidence("evidence:root", "repo:schema"));
    const mutation = mutationSet(facts);
    mutation.repoMutations[0]!.schema.sourceFactReplacements = [
      {
        kind: "declarations",
        repoId: "repo:schema",
        fileId: "file:model",
        facts: [declaration("declaration:payload", "file:model")]
      },
      {
        kind: "roots",
        repoId: "repo:schema",
        fileId: "file:owner",
        facts: [root("root:payload", "file:owner")]
      },
      {
        kind: "provenance",
        repoId: "repo:schema",
        fileId: "file:owner",
        facts: [provenance({
          id: "provenance:payload",
          rootReferenceId: "root:payload",
          relationId: "relation:payload",
          declarationIds: ["declaration:payload"],
          evidenceId: "evidence:root",
          resolution: "resolved"
        })]
      }
    ];
    const source = schemaSpec("spec:source", "contract:source", "repo:schema");
    const target = schemaSpec("spec:target", "contract:target", "repo:schema");
    mutation.schemaVisibility = {
      ...emptySchemaMutation(),
      visibilityChanges: [
        visibility("schema-spec", source.id, source),
        visibility("schema-spec", target.id, target),
        visibility("logical-relation", "relation:payload", {
          fromSpecId: source.id,
          toSpecId: target.id,
          kind: "USES_SCHEMA",
          evidenceId: "evidence:root",
          reason: "resolved payload",
          confidence: 1
        })
      ]
    };
    const query = vi.fn<QueryResponder>(async (statement) => {
      if (statement.includes("f.repoId = $repoId")) return [];
      throw new Error(`All endpoints are supplied by the replacement overlay: ${statement}`);
    });

    await expect(validateIncrementalIndexMutationEndpoints(dbWithQuery(query), mutation))
      .resolves.toBeUndefined();
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("rejects provenance that points at a root tombstoned in the same next view", async () => {
    const mutation = mutationSet(emptyFacts());
    mutation.repoMutations[0]!.schema.sourceFactReplacements = [
      {
        kind: "roots",
        repoId: "repo:schema",
        fileId: "file:owner",
        facts: []
      },
      {
        kind: "provenance",
        repoId: "repo:schema",
        fileId: "file:owner",
        facts: [provenance({
          id: "provenance:stale-root",
          rootReferenceId: "root:deleted",
          relationId: "relation:existing",
          declarationIds: [],
          resolution: "external"
        })]
      }
    ];
    const query = vi.fn<QueryResponder>(async (statement) => {
      if (statement.includes("f.repoId = $repoId")) return [{ factId: "root:deleted" }];
      throw new Error(`Tombstoned root must fail before relation lookup: ${statement}`);
    });

    await expect(validateIncrementalIndexMutationEndpoints(dbWithQuery(query), mutation))
      .rejects.toThrow(
        "dangling Schema root endpoint(s): root:deleted (Schema provenance provenance:stale-root)"
      );
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("uses an exact contribution lookup and invents no declaration or evidence for external provenance", async () => {
    const mutation = mutationSet(emptyFacts());
    mutation.repoMutations[0]!.schema.sourceFactReplacements = [
      {
        kind: "roots",
        repoId: "repo:schema",
        fileId: "file:owner",
        facts: [root("root:external", "file:owner")]
      },
      {
        kind: "provenance",
        repoId: "repo:schema",
        fileId: "file:owner",
        facts: [provenance({
          id: "provenance:external",
          rootReferenceId: "root:external",
          relationId: "relation:external",
          declarationIds: [],
          resolution: "external"
        })]
      }
    ];
    const query = vi.fn<QueryResponder>(async (statement, params) => {
      if (statement.includes("f.repoId = $repoId")) return [];
      if (statement.includes("SchemaContribution")) {
        expect(params).toEqual({
          generation: GENERATION,
          entityKind: "logical-relation",
          entityIds: ["relation:external"]
        });
        return [{ id: "relation:external" }];
      }
      throw new Error(`External provenance invented an endpoint lookup: ${statement}`);
    });

    await expect(validateIncrementalIndexMutationEndpoints(dbWithQuery(query), mutation))
      .resolves.toBeUndefined();
    expect(query).toHaveBeenCalledTimes(2);
    expect(query).not.toHaveBeenCalledWith(expect.stringContaining("TypeDeclarationFact"), expect.anything());
    expect(query).toHaveBeenCalledWith(expect.stringContaining("c.entityId IN $entityIds"), expect.any(Object));
  });

  it("rejects provenance whose logical relation is removed by contribution reconciliation", async () => {
    const mutation = mutationSet(emptyFacts());
    mutation.repoMutations[0]!.schema.sourceFactReplacements = [
      {
        kind: "roots",
        repoId: "repo:schema",
        fileId: "file:owner",
        facts: [root("root:relation-owner", "file:owner")]
      },
      {
        kind: "provenance",
        repoId: "repo:schema",
        fileId: "file:owner",
        facts: [provenance({
          id: "provenance:deleted-relation",
          rootReferenceId: "root:relation-owner",
          relationId: "relation:deleted",
          declarationIds: [],
          resolution: "external"
        })]
      }
    ];
    mutation.schemaVisibility = {
      ...emptySchemaMutation(),
      visibilityChanges: [{
        entityKind: "logical-relation",
        entityId: "relation:deleted",
        previousCount: 1,
        nextCount: 0,
        previousContributions: [{
          rootReferenceId: "root:old",
          entityKind: "logical-relation",
          entityId: "relation:deleted"
        }],
        contributions: []
      }]
    };
    const query = vi.fn<QueryResponder>(async (statement) => {
      if (statement.includes("f.repoId = $repoId")) return [];
      throw new Error(`Deleted relation must fail before an active lookup: ${statement}`);
    });

    await expect(validateIncrementalIndexMutationEndpoints(dbWithQuery(query), mutation))
      .rejects.toThrow(
        "dangling Schema relation endpoint(s): relation:deleted (Schema provenance provenance:deleted-relation)"
      );
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("rejects a missing optional provenance evidence endpoint when the fact supplies one", async () => {
    const mutation = mutationSet(emptyFacts());
    mutation.repoMutations[0]!.schema.sourceFactReplacements = [
      {
        kind: "roots",
        repoId: "repo:schema",
        fileId: "file:owner",
        facts: [root("root:with-evidence", "file:owner")]
      },
      {
        kind: "provenance",
        repoId: "repo:schema",
        fileId: "file:owner",
        facts: [provenance({
          id: "provenance:missing-evidence",
          rootReferenceId: "root:with-evidence",
          relationId: "relation:existing",
          declarationIds: [],
          evidenceId: "evidence:missing",
          resolution: "external"
        })]
      }
    ];
    const query = vi.fn<QueryResponder>(async (statement) => {
      if (statement.includes("f.repoId = $repoId")) return [];
      if (statement.includes("SchemaContribution")) return [{ id: "relation:existing" }];
      if (statement.includes("MATCH (n:Evidence)")) return [];
      throw new Error(`Unexpected validation query: ${statement}`);
    });

    await expect(validateIncrementalIndexMutationEndpoints(dbWithQuery(query), mutation))
      .rejects.toThrow(
        "dangling Evidence endpoint(s): evidence:missing (Schema provenance provenance:missing-evidence)"
      );
    expect(query).toHaveBeenCalledTimes(3);
  });

  it("rejects a stable public node identity scheduled for both upsert and support GC", async () => {
    const facts = emptyFacts();
    facts.entities.push({
      id: "entity:shared",
      name: "Shared",
      kind: "domain",
      description: "Pending overlay entity"
    });
    const mutation = mutationSet(facts);
    mutation.schemaSupportGc!.entityIds = ["entity:shared"];
    const query = vi.fn<QueryResponder>(async () => []);

    await expect(validateIncrementalIndexMutationEndpoints(dbWithQuery(query), mutation))
      .rejects.toThrow(
        "Incremental public graph mutation cannot both upsert and delete Entity: entity:shared."
      );
    expect(query).not.toHaveBeenCalled();
  });
});

function schemaSpec(id: string, contractId: string, repoId: string): ContractSpecNode {
  return {
    id,
    contractId,
    specKind: "schema",
    repoId,
    fileId: `file:${id}`,
    evidenceId: `evidence:${id}`,
    canonicalKey: id,
    specJson: "{}",
    confidence: 1,
    batchId: "batch:incremental-validation",
    indexedAt: "2026-01-01T00:00:00.000Z",
    active: true
  };
}

function evidence(id: string, repoId: string): EvidenceNode {
  return {
    id,
    repoId,
    fileId: "file:evidence",
    filePath: "evidence.ts",
    line: 1,
    raw: "evidence",
    rule: "test",
    confidence: 1
  };
}

function visibility(
  entityKind: "schema-spec" | "logical-relation",
  entityId: string,
  payload: ContractSpecNode | SemanticRelationEdge
) {
  return {
    entityKind,
    entityId,
    previousCount: 0,
    nextCount: 1,
    previousContributions: [],
    contributions: [{ rootReferenceId: "root:test", entityKind, entityId, payload }]
  };
}

function declaration(id: string, fileId: string): TypeDeclarationFact & OwnedSchemaFact {
  return {
    id,
    identity: {
      languageId: "typescript",
      repoId: "repo:schema",
      resolutionScopeId: "module:schema",
      canonicalName: "schema.Payload"
    },
    fileId,
    declarationKind: "interface",
    typeParameters: [],
    generation: GENERATION,
    repoId: "repo:schema",
    sourceFileId: fileId
  };
}

function root(id: string, ownerFileId: string): SchemaRootReference & OwnedSchemaFact {
  return {
    id,
    repoId: "repo:schema",
    ownerSpecId: "spec:owner",
    ownerFileId,
    relationKind: "EVENT_PAYLOAD",
    languageId: "typescript",
    frameworkId: "test",
    rawTypeExpression: "Payload",
    resolutionContextId: "context:owner",
    slot: { kind: "payload" },
    evidenceId: "evidence:root",
    generation: GENERATION,
    sourceFileId: ownerFileId
  };
}

function dependency(id: string, rootReferenceId: string, declarationId: string): SchemaDependencyFact {
  return {
    id,
    rootReferenceId,
    declarationId,
    fieldPath: [],
    generation: GENERATION
  };
}

function provenance(input: {
  id: string;
  rootReferenceId: string;
  relationId: string;
  declarationIds: string[];
  resolution: SchemaRelationProvenance["resolution"];
  evidenceId?: string;
}): SchemaRelationProvenance {
  return {
    id: input.id,
    relationId: input.relationId,
    rootReferenceId: input.rootReferenceId,
    rawTypeExpression: "Payload",
    typePath: [],
    fieldPath: [],
    declarationIds: input.declarationIds,
    resolution: input.resolution,
    evidenceId: input.evidenceId,
    generation: GENERATION
  };
}
