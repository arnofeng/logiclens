import { describe, expect, it, vi } from "vitest";
import type { GraphDB } from "../src/core/graph-model/db.js";
import type { GraphFactsBatch } from "../src/core/graph-model/facts.js";
import { reconcileWithActiveSchemaCatalog } from "../src/core/indexing/orchestrator.js";
import type { ParsedFile, RepoNode } from "../src/core/parsing/types.js";
import { schemaDeclarationVisibilityTarget } from "../src/core/schema/sourceScopes.js";

const repo: RepoNode = {
  id: "repo:catalog-read",
  name: "catalog-read",
  path: "C:/workspace/catalog-read",
  remoteUrl: "",
  branch: "",
  commitSha: "",
  language: "typescript",
  indexedAt: "2026-08-02T00:00:00.000Z"
};

const changedFile: ParsedFile = {
  repoId: repo.id,
  fileId: "file:repo:catalog-read:src/changed.ts",
  path: "src/changed.ts",
  language: "typescript",
  hash: "changed",
  loc: 1,
  source: "export const changed = true;",
  imports: [],
  symbols: [],
  calls: []
};

function emptyFacts(): GraphFactsBatch {
  return {
    batchId: "batch:catalog-read",
    workspaceId: "workspace:catalog-read",
    generation: "generation:active",
    systemName: "catalog-read",
    indexedAt: "2026-08-02T00:00:00.000Z",
    repos: [repo],
    parsedFiles: [changedFile],
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
      operations: [],
      workflows: [],
      repoContracts: [],
      repoDependencies: [],
      contractEntities: [],
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

describe("targeted incremental schema catalog reads", () => {
  it("derives bounded canonical import selectors for every migrated non-Java language", async () => {
    const source = (input: Pick<ParsedFile, "fileId" | "path" | "language" | "source" | "imports">): ParsedFile => ({
      repoId: repo.id,
      hash: input.fileId,
      loc: 1,
      symbols: [],
      calls: [],
      ...input
    });
    const importRef = (fileId: string, module: string) => ({
      fileId,
      module,
      raw: module,
      line: 1
    });
    const files = [
      source({
        fileId: "file:ts",
        path: "src/publisher.ts",
        language: "typescript",
        source: "",
        imports: [importRef("file:ts", "./models")]
      }),
      source({
        fileId: "file:go",
        path: "cmd/publisher.go",
        language: "go",
        source: "package main",
        imports: [importRef("file:go", "example.com/service/pkg/contracts")]
      }),
      source({
        fileId: "file:proto",
        path: "api/service.proto",
        language: "proto",
        source: "package api;",
        imports: [importRef("file:proto", "models/payload.proto")]
      }),
      source({
        fileId: "file:python",
        path: "app/publisher.py",
        language: "python",
        source: "",
        imports: [importRef("file:python", ".models")]
      }),
      source({
        fileId: "file:graphql",
        path: "src/query.graphql",
        language: "graphql",
        source: "",
        imports: [importRef("file:graphql", "./types.graphql")]
      }),
      source({
        fileId: "file:csharp",
        path: "src/Publisher.cs",
        language: "csharp",
        source: "namespace Acme.Publishers;",
        imports: [importRef("file:csharp", "Acme.Models")]
      })
    ];
    const target = await schemaDeclarationVisibilityTarget({ files, candidates: [] });
    expect(target.exactScopes).toEqual(expect.arrayContaining([
      expect.objectContaining({ languageId: "typescript", resolutionScopeId: "module:src/models" }),
      expect.objectContaining({ languageId: "proto", resolutionScopeId: "package:api" }),
      expect.objectContaining({ languageId: "python", resolutionScopeId: "module:app.models.py" }),
      expect.objectContaining({ languageId: "graphql", resolutionScopeId: "module:src/types.graphql" }),
      expect.objectContaining({ languageId: "csharp", resolutionScopeId: "namespace:Acme.Models" })
    ]));
    expect(target.scopePrefixes).toContainEqual(expect.objectContaining({
      languageId: "go",
      resolutionScopePrefix: "package:example.com/service/pkg/contracts:"
    }));
    expect(target.sources.map((item) => item.fileId)).toEqual(expect.arrayContaining([
      `file:${repo.id}:models/payload.proto`,
      `file:${repo.id}:api/models/payload.proto`
    ]));
  });

  it("does not read the previous active catalog during a full snapshot reconciliation", async () => {
    const query = vi.fn(async () => {
      throw new Error("full reconciliation attempted an active provider read");
    });
    await reconcileWithActiveSchemaCatalog(
      { query } as unknown as GraphDB,
      "workspace:catalog-read",
      emptyFacts(),
      [changedFile],
      { incremental: false, removedSources: [], repoPaths: new Map([[repo.id, repo.path]]) }
    );
    expect(query).not.toHaveBeenCalled();
  });

  it("uses source/scope/identity predicates instead of reads proportional to unrelated declarations", async () => {
    const queries: string[] = [];
    const query = vi.fn(async (cypher: string) => {
      queries.push(cypher);
      return [];
    });
    await reconcileWithActiveSchemaCatalog(
      { query } as unknown as GraphDB,
      "workspace:catalog-read",
      emptyFacts(),
      [changedFile],
      { incremental: true, removedSources: [], repoPaths: new Map([[repo.id, repo.path]]) }
    );

    const declarationReads = queries.filter((cypher) => cypher.includes("TypeDeclarationFact"));
    expect(declarationReads.length).toBeGreaterThan(0);
    expect(declarationReads.every((cypher) =>
      (cypher.includes("f.repoId = $repoId") && (cypher.includes("f.fileId = $fileId")
        || cypher.includes("f.resolutionScopeId = $resolutionScopeId")
        || cypher.includes("f.resolutionScopeId STARTS WITH $resolutionScopePrefix")))
      || cypher.includes("f.id IN $storageIds"))).toBe(true);
    expect(queries.some((cypher) => cypher.includes("specKind = 'schema'")
      && !cypher.includes("storageId IN $storageIds"))).toBe(false);
    expect(queries.some((cypher) => cypher.includes("RETURN f.payload AS payload")
      && !cypher.includes("fileId = $fileId")
      && !cypher.includes("resolutionScopeId")
      && !cypher.includes("id IN $storageIds")
      && !cypher.includes("rootReferenceId IN $rootReferenceIds"))).toBe(false);
  });
});
