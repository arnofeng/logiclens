import { describe, expect, it } from "vitest";
import { reconcileNonJavaSchemaFacts } from "../src/core/contracts/extraction/nonJavaSchemaReconciler.js";
import type { ContractSpecNode, ParsedFile } from "../src/core/parsing/types.js";
import type { SchemaDeclarationCandidate } from "../src/core/schema/model.js";
import { buildSchemaSourceContexts, resolutionScopeIdForFile, schemaDeclarationVisibilityTarget } from "../src/core/schema/sourceScopes.js";

describe("Java deterministic source scopes", () => {
  it("binds exact cross-module imports, records their scope dependency, and does not leak test sources", async () => {
    const repoId = "repo:java-modules";
    const api = javaFile(repoId, "file:api", "api/src/main/java/com/example/api/GoodsController.java", `
      package com.example.api;
      import com.example.shared.GoodsPayload;
      class GoodsController { GoodsPayload payload; }
    `);
    const sharedMain = candidate(repoId, "file:shared-main", "shared/src/main/java/com/example/shared/GoodsPayload.java", "com.example.shared.GoodsPayload");
    const sharedTest = candidate(repoId, "file:shared-test", "shared/src/test/java/com/example/shared/GoodsPayload.java", "com.example.shared.GoodsPayload");
    const shadowMain = candidate(repoId, "file:shadow-main", "shadow/src/main/java/com/example/shadow/GoodsPayload.java", "com.example.shadow.GoodsPayload");
    const candidates = [sharedMain, sharedTest, shadowMain];
    const declarations = candidates.map((value) => ({
      id: value.declaration.canonicalName === sharedMain.declaration.canonicalName
        && value.declaration.resolutionScopeId === sharedMain.declaration.resolutionScopeId ? "declaration:shared-main"
        : value.fileId,
      identity: value.declaration,
      fileId: value.fileId,
      declarationKind: "class" as const,
      typeParameters: [],
      candidate: value,
      generation: ""
    }));
    // Use stable declaration IDs produced by reconciliation for the integration
    // assertion below; context selection itself only depends on identity/scope.
    const contexts = buildSchemaSourceContexts([api], declarations, candidates);
    const apiContext = contexts[0]!;
    const bindings = apiContext.imports.filter((binding) => binding.localName === "GoodsPayload");
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      canonicalName: "com.example.shared.GoodsPayload",
      resolutionScopeId: sharedMain.declaration.resolutionScopeId
    });
    const visibility = await schemaDeclarationVisibilityTarget({ files: [api], candidates: [] });
    expect(visibility.scopePrefixes).toContainEqual({
      languageId: "java",
      repoId,
      resolutionScopePrefix: "module:"
    });

    const endpoint: ContractSpecNode = {
      id: "spec:endpoint",
      contractId: "contract:endpoint",
      specKind: "http-endpoint",
      repoId,
      fileId: api.fileId,
      evidenceId: "evidence:endpoint",
      canonicalKey: "POST:/goods",
      framework: "spring-mvc",
      specJson: JSON.stringify({
        kind: "http-endpoint",
        method: "POST",
        path: "/goods",
        pathTemplate: "/goods",
        pathParams: [],
        requestBodyType: "GoodsPayload",
        requestBodySlots: [{ index: 0, name: "body", type: "GoodsPayload" }],
        responseBody: false
      }),
      confidence: 1
    };
    const reconciled = reconcileNonJavaSchemaFacts([endpoint], [], candidates, { sourceFiles: [api] });
    expect(reconciled.internal.resolutionScopeDependencies).toEqual(expect.arrayContaining([
      expect.objectContaining({
        from: expect.objectContaining({ resolutionScopeId: resolutionScopeIdForFile(api) }),
        to: expect.objectContaining({ resolutionScopeId: sharedMain.declaration.resolutionScopeId })
      })
    ]));
    const publicSchemas = reconciled.contractSpecs
      .filter((node) => node.specKind === "schema")
      .map((node) => JSON.parse(node.specJson) as { declaration: { canonicalName: string; resolutionScopeId: string } });
    expect(publicSchemas).toEqual([
      expect.objectContaining({ declaration: sharedMain.declaration })
    ]);
  });
});

function javaFile(repoId: string, fileId: string, path: string, source: string): ParsedFile {
  const imports = [...source.matchAll(/^\s*import\s+(?!static\s+)([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*;/gmu)]
    .map((match, index) => ({ fileId, module: match[1]!, raw: match[0], line: index + 1 }));
  return {
    repoId,
    fileId,
    path,
    language: "java",
    hash: `hash:${fileId}`,
    loc: source.split("\n").length,
    source,
    imports,
    symbols: [],
    calls: []
  };
}

function candidate(repoId: string, fileId: string, filePath: string, canonicalName: string): SchemaDeclarationCandidate {
  const file = javaFile(repoId, fileId, filePath, `package ${canonicalName.slice(0, canonicalName.lastIndexOf("."))}; class GoodsPayload { String id; }`);
  return {
    declaration: {
      languageId: "java",
      repoId,
      resolutionScopeId: resolutionScopeIdForFile(file),
      canonicalName
    },
    displayName: "GoodsPayload",
    declarationKind: "class",
    typeParameters: [],
    shape: { kind: "object", fields: [] },
    fileId,
    filePath,
    framework: "java-source",
    evidence: { line: 1, raw: "class GoodsPayload", rule: "fixture", confidence: 1 }
  };
}
