import { describe, expect, it } from "vitest";
import {
  canonicalSerialize,
  createTypeInstanceIdentity,
  externalSchemaField,
  resolutionScopeIdentityId,
  schemaFieldFromNormalized,
  schemaSpecId,
  typeDeclarationIdentityId,
  typeInstanceIdentityId
} from "../src/core/schema/model.js";
import { assertTypeSystemAdapterContract, createSchemaBehaviorFingerprint } from "../src/core/schema/typeSystem.js";
import { IndexedTypeSystemAdapter } from "../src/core/schema/indexedTypeSystemAdapter.js";
import { materializeSchemaRoot } from "../src/core/schema/materializer.js";

describe("deterministic schema shared model", () => {
  it("uses complete scope identity even when bare scope ids match", () => {
    const a = resolutionScopeIdentityId({ languageId: "java", repoId: "repo:a", resolutionScopeId: "main" });
    const b = resolutionScopeIdentityId({ languageId: "java", repoId: "repo:b", resolutionScopeId: "main" });
    const c = resolutionScopeIdentityId({ languageId: "typescript", repoId: "repo:a", resolutionScopeId: "main" });
    expect(new Set([a, b, c])).toHaveLength(3);
  });

  it("canonicalizes object key order for declaration and instance IDs", () => {
    const declarationA = { languageId: "proto", repoId: "repo:a", resolutionScopeId: "source", canonicalName: "acme.v1.Order" };
    const declarationB = { canonicalName: "acme.v1.Order", resolutionScopeId: "source", repoId: "repo:a", languageId: "proto" };
    expect(typeDeclarationIdentityId(declarationA)).toBe(typeDeclarationIdentityId(declarationB));
    const instance = { declarationId: typeDeclarationIdentityId(declarationA), canonicalTypeArguments: [{ kind: "scalar" as const, name: "string" }] };
    expect(typeInstanceIdentityId(instance)).toBe(typeInstanceIdentityId(JSON.parse(canonicalSerialize(instance))));
  });

  it("refuses partially canonicalized generic identities", () => {
    expect(createTypeInstanceIdentity("declaration:page", [{ kind: "scalar", name: "string" }, undefined])).toBeUndefined();
  });

  it("keeps known external symbols stable and unresolved expressions diagnostic-owned", () => {
    const externalA = externalSchemaField({ languageId: "java", canonicalName: "java.time.Instant", fileId: "file:a", sourceName: "createdAt", optional: false, nullable: false });
    const externalB = externalSchemaField({ languageId: "java", canonicalName: "java.time.Instant", fileId: "file:b", sourceName: "createdAt", optional: false, nullable: false });
    expect(externalA.type).toEqual(externalB.type);
    const a = schemaFieldFromNormalized({ languageId: "typescript", repoId: "repo:a", fileId: "file:a", sourceName: "value", normalizedType: "ExternalThing", optional: false });
    const b = schemaFieldFromNormalized({ languageId: "typescript", repoId: "repo:a", fileId: "file:a", sourceName: "value", normalizedType: "ExternalThing", optional: false });
    expect(a.type.kind).toBe("unresolved");
    expect(a.type).toEqual(b.type);
  });

  it("enforces versioned adapter behavior budgets and stable fingerprints", () => {
    const adapter = {
      languageId: "fixture", adapterVersion: "1", ruleSetVersion: "rules-1", serializationVersion: "wire-1",
      maxDepth: 4, maxTypesPerRoot: 32,
      indexDeclarations: () => [],
      parseTypeExpression: (raw: string) => ({ kind: "reference" as const, name: raw }),
      resolveType: () => ({ kind: "unsupported" as const, diagnostic: { id: "diagnostic", generation: "g", code: "unsupported" as const } }),
      projectType: () => ({ kind: "stop" as const, reason: "unsupported" as const }),
      inspectSchemaShape: () => ({ kind: "object" as const, fields: [] })
    };
    expect(() => assertTypeSystemAdapterContract(adapter)).not.toThrow();
    const input = { languageId: "fixture", repoId: "repo:a", resolutionScopeId: "scope:main", adapterVersion: "1", ruleSetVersion: "rules-1", serializationVersion: "wire-1", maxDepth: 4, maxTypesPerRoot: 32, buildInputsHash: "inputs", generation: "g" };
    expect(createSchemaBehaviorFingerprint(input).id).toBe(createSchemaBehaviorFingerprint({ ...input, generation: "next" }).id);
  });

  it("materializes transparent wrappers, collections, nested declarations, and diagnostics through the shared engine", () => {
    const scope = { languageId: "fixture", repoId: "repo:a", resolutionScopeId: "main" };
    const orderId = typeDeclarationIdentityId({ ...scope, canonicalName: "acme.Order" });
    const userId = typeDeclarationIdentityId({ ...scope, canonicalName: "acme.User" });
    const field = (name: string) => ({
      sourceName: name, serializedName: name,
      type: { kind: "unresolved" as const, normalizedExpression: { kind: "reference" as const, name: "User" }, diagnosticId: `old:${name}` },
      optional: false, nullable: false, sourceLocation: { fileId: "file:order" }
    });
    const adapter = new IndexedTypeSystemAdapter({
      languageId: "fixture", adapterVersion: "1", ruleSetVersion: "rules-1", serializationVersion: "wire-1",
      maxDepth: 8, maxTypesPerRoot: 16,
      scalars: { string: "string" }, externalSymbols: ["std"],
      wrappers: [
        { canonicalSymbol: "fixture.Promise", sourceSymbols: ["Promise"], behavior: "transparent", argumentIndexes: [0] },
        { canonicalSymbol: "fixture.List", sourceSymbols: ["List"], behavior: "collection", argumentIndexes: [0] },
        { canonicalSymbol: "fixture.Stream", sourceSymbols: ["Stream"], behavior: "stop" }
      ]
    }, [
      { fact: { id: orderId, identity: { ...scope, canonicalName: "acme.Order" }, fileId: "file:order", declarationKind: "object", typeParameters: [], generation: "g" }, shape: { kind: "object", fields: [field("user")] } },
      { fact: { id: userId, identity: { ...scope, canonicalName: "acme.User" }, fileId: "file:user", declarationKind: "object", typeParameters: [], generation: "g" }, shape: { kind: "object", fields: [] } }
    ]);
    const context = {
      id: "context",
      ...scope,
      fileId: "file:endpoint",
      imports: [
        { localName: "Order", canonicalName: "acme.Order", declarationId: orderId, resolutionScopeId: scope.resolutionScopeId, kind: "named" as const },
        { localName: "User", canonicalName: "acme.User", declarationId: userId, resolutionScopeId: scope.resolutionScopeId, kind: "named" as const }
      ],
      enclosingDeclarationIds: [],
      genericBindings: [],
      generation: "g"
    };
    const root = {
        id: "root", repoId: "repo:a", ownerSpecId: "endpoint", ownerFileId: "file:endpoint",
        relationKind: "RESPONSE_SCHEMA", languageId: "fixture", frameworkId: "fixture",
        rawTypeExpression: "Promise<List<Order>>", resolutionContextId: context.id,
        slot: { kind: "return" }, evidenceId: "evidence", generation: "g"
      } as const;
    const result = materializeSchemaRoot({ adapter, context, root });
    expect(new Set(result.types.map((item) => item.identity.declarationId))).toEqual(new Set([orderId, userId]));
    expect(result.diagnostics).toEqual([]);
    expect(result.dependencies).toHaveLength(2);
    const orderSpecId = schemaSpecId({ declarationId: orderId, canonicalTypeArguments: [] });
    const userSpecId = schemaSpecId({ declarationId: userId, canonicalTypeArguments: [] });
    expect(result.relations).toEqual(expect.arrayContaining([
      expect.objectContaining({ fromSpecId: "endpoint", toSpecId: orderSpecId, kind: "RESPONSE_SCHEMA" }),
      expect.objectContaining({ fromSpecId: orderSpecId, toSpecId: userSpecId, kind: "USES_SCHEMA" })
    ]));
    expect(result.dependencies.find((dependency) => dependency.declarationId === userId)).toMatchObject({
      rootReferenceId: root.id,
      fromInstanceId: typeInstanceIdentityId({ declarationId: orderId, canonicalTypeArguments: [] })
    });
    expect(result.dependencies.every((dependency) => dependency.rootReferenceId === root.id)).toBe(true);
    expect(result.provenance.every((fact) => fact.rootReferenceId === root.id)).toBe(true);
    expect(result.provenance.find((fact) => fact.fieldPath.length === 0)?.projectionRuleId)
      .toBe("rules-1:fixture.Promise > rules-1:fixture.List");
    const boundary = materializeSchemaRoot({
      adapter,
      context,
      root: { ...root, id: "root:boundary", rawTypeExpression: "Stream<User>" }
    });
    expect(boundary.types).toEqual([]);
    expect(boundary.diagnostics.map((fact) => fact.code)).toEqual(["unsupported"]);
    const repeated = materializeSchemaRoot({ adapter, context, root: { ...root, evidenceId: "different-evidence" } });
    expect(repeated.provenance.map((fact) => [fact.id, fact.relationId])).toEqual(result.provenance.map((fact) => [fact.id, fact.relationId]));
    const unresolved = adapter.resolveType(adapter.parseTypeExpression("Order<Missing>", context), context);
    expect(unresolved.kind).toBe("unresolved");
    expect(adapter.resolveType({ kind: "reference", name: "std.Time" }, context).kind).toBe("external");
  });

  it("retains recursive map key/value IR before and after canonicalization", () => {
    const scalarMap = schemaFieldFromNormalized({
      languageId: "proto", repoId: "repo:a", fileId: "file:map", sourceName: "labels",
      normalizedType: "map<string,array<number>>", optional: false
    });
    expect(scalarMap.type).toEqual({
      kind: "resolved",
      expression: {
        kind: "map",
        key: { kind: "scalar", name: "string" },
        value: { kind: "array", element: { kind: "scalar", name: "number" } }
      }
    });
    const declarationMap = schemaFieldFromNormalized({
      languageId: "go", repoId: "repo:a", fileId: "file:map", sourceName: "orders",
      normalizedType: "map<string,Order>", optional: false
    });
    expect(declarationMap.type).toMatchObject({
      kind: "unresolved",
      normalizedExpression: {
        kind: "map",
        key: { kind: "reference", name: "string" },
        value: { kind: "reference", name: "Order" }
      }
    });
  });

  it("substitutes materialized generic variables through fields without synthetic type-argument traversal", () => {
    const scope = { languageId: "fixture", repoId: "repo:generic", resolutionScopeId: "main" };
    const pageId = typeDeclarationIdentityId({ ...scope, canonicalName: "Page" });
    const userId = typeDeclarationIdentityId({ ...scope, canonicalName: "User" });
    const adapter = new IndexedTypeSystemAdapter({
      languageId: "fixture",
      adapterVersion: "1",
      ruleSetVersion: "rules-generic",
      serializationVersion: "wire-1",
      maxDepth: 4,
      maxTypesPerRoot: 8,
      scalars: {},
      externalSymbols: [],
      wrappers: []
    }, [
      {
        fact: { id: pageId, identity: { ...scope, canonicalName: "Page" }, fileId: "file:page", declarationKind: "object", typeParameters: ["T"], generation: "g" },
        shape: { kind: "object", fields: [{
          sourceName: "item",
          serializedName: "item",
          type: { kind: "unresolved", normalizedExpression: { kind: "variable", name: "T" }, diagnosticId: "diagnostic:T" },
          optional: false,
          nullable: false,
          sourceLocation: { fileId: "file:page" }
        }] }
      },
      {
        fact: { id: userId, identity: { ...scope, canonicalName: "User" }, fileId: "file:user", declarationKind: "object", typeParameters: [], generation: "g" },
        shape: { kind: "object", fields: [] }
      }
    ]);
    const context = {
      id: "context:generic",
      ...scope,
      fileId: "file:owner",
      imports: [],
      enclosingDeclarationIds: [],
      genericBindings: [],
      generation: "g"
    };
    const root = {
      id: "root:generic",
      repoId: scope.repoId,
      ownerSpecId: "spec:owner",
      ownerFileId: context.fileId,
      relationKind: "RESPONSE_SCHEMA",
      languageId: scope.languageId,
      frameworkId: "fixture",
      rawTypeExpression: "Page<User>",
      resolutionContextId: context.id,
      slot: { kind: "return" },
      evidenceId: "evidence:generic",
      generation: "g"
    } as const;
    const result = materializeSchemaRoot({ adapter, root, context });
    expect(result.diagnostics).toEqual([]);
    expect(new Set(result.types.map((type) => type.identity.declarationId))).toEqual(new Set([pageId, userId]));
    expect(result.dependencies.find((dependency) => dependency.declarationId === userId)).toMatchObject({
      fromInstanceId: typeInstanceIdentityId({
        declarationId: pageId,
        canonicalTypeArguments: [{ kind: "type-instance", declarationId: userId, arguments: [] }]
      }),
      fieldPath: ["item"]
    });
    expect(result.dependencies.some((dependency) => dependency.fieldPath.includes("$typeArgument"))).toBe(false);
    expect(adapter.resolveType({ kind: "reference", name: "Page" }, context).kind).toBe("unsupported");
  });

  it("rejects non-scalar map keys while traversing only a valid map value", () => {
    const scope = { languageId: "fixture", repoId: "repo:map", resolutionScopeId: "main" };
    const keyId = typeDeclarationIdentityId({ ...scope, canonicalName: "Key" });
    const valueId = typeDeclarationIdentityId({ ...scope, canonicalName: "Value" });
    const adapter = new IndexedTypeSystemAdapter({
      languageId: "fixture",
      adapterVersion: "1",
      ruleSetVersion: "rules-map",
      serializationVersion: "wire-1",
      maxDepth: 4,
      maxTypesPerRoot: 8,
      scalars: { string: "string" },
      externalSymbols: [],
      wrappers: [{ canonicalSymbol: "fixture.Map", sourceSymbols: ["Map"], behavior: "map-value" }]
    }, [
      { fact: { id: keyId, identity: { ...scope, canonicalName: "Key" }, fileId: "file:key", declarationKind: "object", typeParameters: [], generation: "g" }, shape: { kind: "object", fields: [] } },
      { fact: { id: valueId, identity: { ...scope, canonicalName: "Value" }, fileId: "file:value", declarationKind: "object", typeParameters: [], generation: "g" }, shape: { kind: "object", fields: [] } }
    ]);
    const context = {
      id: "context:map",
      ...scope,
      fileId: "file:owner",
      imports: [],
      enclosingDeclarationIds: [],
      genericBindings: [],
      generation: "g"
    };
    const baseRoot = {
      id: "root:map",
      repoId: scope.repoId,
      ownerSpecId: "spec:owner",
      ownerFileId: context.fileId,
      relationKind: "RESPONSE_SCHEMA",
      languageId: scope.languageId,
      frameworkId: "fixture",
      rawTypeExpression: "Map<Key,Value>",
      resolutionContextId: context.id,
      slot: { kind: "return" },
      evidenceId: "evidence:map",
      generation: "g"
    } as const;
    const invalid = materializeSchemaRoot({ adapter, context, root: baseRoot });
    expect(invalid.types).toEqual([]);
    expect(invalid.diagnostics).toEqual([expect.objectContaining({ code: "unsupported", rootReferenceId: baseRoot.id })]);

    const valid = materializeSchemaRoot({
      adapter,
      context,
      root: { ...baseRoot, id: "root:scalar-map", rawTypeExpression: "Map<string,Value>" }
    });
    expect(valid.diagnostics).toEqual([]);
    expect(valid.types.map((type) => type.identity.declarationId)).toEqual([valueId]);
  });

  it("does not resolve repo-wide simple names or treat qualified user types as builtin wrappers", () => {
    const scope = { languageId: "fixture", repoId: "repo:a", resolutionScopeId: "main" };
    const importedScope = { ...scope, resolutionScopeId: "module:list" };
    const listId = typeDeclarationIdentityId({ ...importedScope, canonicalName: "com.acme.List" });
    const adapter = new IndexedTypeSystemAdapter({
      languageId: "fixture",
      adapterVersion: "1",
      ruleSetVersion: "rules-1",
      serializationVersion: "wire-1",
      maxDepth: 8,
      maxTypesPerRoot: 16,
      scalars: {},
      externalSymbols: [],
      wrappers: [{ canonicalSymbol: "fixture.List", sourceSymbols: ["List"], behavior: "collection", argumentIndexes: [0] }]
    }, [{
      fact: {
        id: listId,
        identity: { ...importedScope, canonicalName: "com.acme.List" },
        fileId: "file:list",
        declarationKind: "object",
        typeParameters: ["T"],
        generation: "g"
      },
      shape: { kind: "object", fields: [] }
    }]);
    const context = {
      id: "context",
      ...scope,
      fileId: "file:consumer",
      imports: [{ localName: "List", canonicalName: "com.acme.List", declarationId: listId, resolutionScopeId: importedScope.resolutionScopeId, kind: "named" as const }],
      enclosingDeclarationIds: [],
      genericBindings: [],
      generation: "g"
    };

    expect(adapter.resolveType({ kind: "reference", name: "List" }, { ...context, imports: [] }).kind).toBe("unresolved");
    expect(adapter.resolveType({ kind: "reference", name: "List" }, context).kind).toBe("unsupported");
    expect(adapter.projectType({
      kind: "application",
      target: { kind: "reference", name: "List" },
      arguments: [{ kind: "reference", name: "Thing" }]
    }, context).kind).toBe("materialized");
    expect(adapter.projectType({
      kind: "application",
      target: { kind: "reference", name: "com.acme.List" },
      arguments: [{ kind: "reference", name: "Thing" }]
    }, context).kind).toBe("materialized");
  });
});
