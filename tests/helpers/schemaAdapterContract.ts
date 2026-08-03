import { expect } from "vitest";
import { IndexedTypeSystemAdapter, type IndexedSchemaDeclaration, type IndexedTypeSystemRules } from "../../src/core/schema/indexedTypeSystemAdapter.js";
import { materializeSchemaRoot } from "../../src/core/schema/materializer.js";
import {
  canonicalSerialize,
  schemaSpecId,
  typeDeclarationIdentityId,
  typeInstanceIdentityId,
  type ResolutionContextFact,
  type SchemaFieldSpec,
  type SchemaRootReference,
  type TypeDeclarationIdentity
} from "../../src/core/schema/model.js";

export const SCHEMA_ADAPTER_LANGUAGES = [
  "java",
  "typescript",
  "python",
  "go",
  "proto",
  "graphql",
  "csharp"
] as const;

export function runSchemaAdapterContract(languageId: string): void {
  const generation = "generation:adapter-contract";
  const scope = { languageId, repoId: "repo:consumer", resolutionScopeId: "scope:main" };
  const otherRepoScope = { languageId, repoId: "repo:other", resolutionScopeId: "scope:main" };
  const a = declaration(scope, "fixture.A", [field("b", "B")], generation);
  const b = declaration(scope, "fixture.B", [field("a", "A")], generation);
  const user = declaration(scope, "fixture.User", [], generation);
  const page = declaration(scope, "fixture.Page", [variableField("item", "T")], generation, ["T"]);
  const firstChoice = declaration({ ...scope, resolutionScopeId: "scope:first" }, "first.Choice", [], generation);
  const secondChoice = declaration({ ...scope, resolutionScopeId: "scope:second" }, "second.Choice", [], generation);
  const invisible = declaration(otherRepoScope, "other.Hidden", [], generation);
  const declarations = [a, b, user, page, firstChoice, secondChoice, invisible];
  const context: ResolutionContextFact = {
    id: `context:${languageId}`,
    ...scope,
    fileId: "file:owner",
    imports: [a, b, user, page, firstChoice, secondChoice].map((item) => ({
      localName: item.fact.identity.canonicalName.split(".").at(-1)!,
      canonicalName: item.fact.identity.canonicalName,
      declarationId: item.fact.id,
      resolutionScopeId: item.fact.identity.resolutionScopeId,
      kind: "named" as const
    })),
    enclosingDeclarationIds: [],
    genericBindings: [],
    generation
  };
  const rules = adapterRules(languageId, 8, 32);
  const forward = new IndexedTypeSystemAdapter(rules, declarations, [context]);
  const reversed = new IndexedTypeSystemAdapter(rules, [...declarations].reverse(), [context]);

  expect(typeDeclarationIdentityId(a.fact.identity)).toBe(a.fact.id);
  expect(typeDeclarationIdentityId({ ...a.fact.identity })).toBe(a.fact.id);
  expect(forward.resolveType(forward.parseTypeExpression("Hidden", context), context).kind).toBe("unresolved");
  expect(forward.resolveType(forward.parseTypeExpression("other.Hidden", context), context).kind).toBe("unresolved");

  const forwardPage = forward.resolveType(forward.parseTypeExpression("Page<User>", context), context);
  const reversedPage = reversed.resolveType(reversed.parseTypeExpression("Page<User>", context), context);
  expect(forwardPage.kind).toBe("resolved");
  expect(reversedPage.kind).toBe("resolved");
  if (forwardPage.kind !== "resolved" || reversedPage.kind !== "resolved") throw new Error("generic fixture did not resolve");
  expect(typeInstanceIdentityId(forwardPage.instance)).toBe(typeInstanceIdentityId(reversedPage.instance));
  expect(schemaSpecId(forwardPage.instance)).toBe(schemaSpecId(reversedPage.instance));

  const ambiguousForward = forward.resolveType(forward.parseTypeExpression("Choice", context), context);
  const ambiguousReverse = reversed.resolveType(reversed.parseTypeExpression("Choice", context), context);
  expect(ambiguousForward.kind).toBe("ambiguous");
  expect(ambiguousReverse.kind).toBe("ambiguous");
  if (ambiguousForward.kind !== "ambiguous" || ambiguousReverse.kind !== "ambiguous") throw new Error("ambiguity fixture did not stay ambiguous");
  expect(ambiguousForward.diagnostic.candidates).toEqual(ambiguousReverse.diagnostic.candidates);
  expect(ambiguousForward.diagnostic.candidates).toHaveLength(2);

  const externalForward = forward.resolveType(forward.parseTypeExpression("external.Clock", context), context);
  const externalReverse = reversed.resolveType(reversed.parseTypeExpression("external.Clock", context), context);
  expect(externalForward).toMatchObject({ kind: "external", canonicalName: "external.Clock" });
  expect(externalReverse).toMatchObject({ kind: "external", canonicalName: "external.Clock" });
  if (externalForward.kind !== "external" || externalReverse.kind !== "external") throw new Error("external fixture did not resolve");
  expect(externalForward.diagnostic.id).toBe(externalReverse.diagnostic.id);

  const partialGenericCases = [
    { code: "unresolved" as const, raw: "Page<Missing>", expression: forward.parseTypeExpression("Page<Missing>", context) },
    { code: "ambiguous" as const, raw: "Page<Choice>", expression: forward.parseTypeExpression("Page<Choice>", context) },
    { code: "external" as const, raw: "Page<external.Clock>", expression: forward.parseTypeExpression("Page<external.Clock>", context) },
    {
      code: "unsupported" as const,
      raw: "Page<opaque>",
      expression: {
        kind: "application" as const,
        target: { kind: "reference" as const, name: "Page" },
        arguments: [{ kind: "opaque" as const, languageId, canonicalText: "opaque" }]
      }
    }
  ];
  for (const partialCase of partialGenericCases) {
    const partialRoot = root(languageId, generation, `root:partial:${partialCase.code}`, partialCase.raw);
    const partial = materializeSchemaRoot({
      adapter: forward,
      root: partialRoot,
      context,
      initialExpression: partialCase.expression
    });
    expect(partial.types, partialCase.code).toEqual([]);
    expect(partial.relations, partialCase.code).toEqual([]);
    expect(partial.provenance, partialCase.code).toEqual([]);
    expect(partial.diagnostics, partialCase.code).toEqual([expect.objectContaining({
      code: partialCase.code,
      rootReferenceId: partialRoot.id,
      typePath: [expect.objectContaining({ kind: "application" })]
    })]);
    expect(canonicalSerialize(partial.diagnostics[0]!.typePath)).toContain("Page");
  }

  const cycleRoot = root(languageId, generation, "root:cycle", "A");
  const cycle = materializeSchemaRoot({ adapter: forward, root: cycleRoot, context });
  expect(new Set(cycle.types.map((item) => item.identity.declarationId))).toEqual(new Set([a.fact.id, b.fact.id]));
  expect(cycle.relations).toHaveLength(3);
  expect(cycle.provenance).toHaveLength(3);
  expect(cycle.provenance.find((fact) => fact.fieldPath.length === 0)).toMatchObject({
    rootReferenceId: cycleRoot.id,
    resolution: "resolved",
    sourceFileId: cycleRoot.ownerFileId
  });
  expect(cycle.provenance.filter((fact) => fact.fieldPath.length > 0).every((fact) => fact.declarationIds.length > 0)).toBe(true);
  const reversedCycle = materializeSchemaRoot({ adapter: reversed, root: cycleRoot, context });
  expect(reversedCycle.relations).toEqual(cycle.relations);
  expect(reversedCycle.provenance).toEqual(cycle.provenance);

  const depthAdapter = new IndexedTypeSystemAdapter(adapterRules(languageId, 0, 32), declarations, [context]);
  const depth = materializeSchemaRoot({ adapter: depthAdapter, root: root(languageId, generation, "root:depth", "A"), context });
  expect(depth.diagnostics).toEqual([expect.objectContaining({
    code: "truncated",
    fieldPath: ["b"],
    limit: { kind: "depth", value: 0 },
    typePath: expect.arrayContaining([expect.objectContaining({ kind: "reference", name: "B" })])
  })]);
  const typesAdapter = new IndexedTypeSystemAdapter(adapterRules(languageId, 8, 1), declarations, [context]);
  const types = materializeSchemaRoot({ adapter: typesAdapter, root: root(languageId, generation, "root:types", "A"), context });
  expect(types.diagnostics).toEqual([expect.objectContaining({
    code: "truncated",
    fieldPath: ["b"],
    limit: { kind: "types", value: 1 }
  })]);
}

function adapterRules(languageId: string, maxDepth: number, maxTypesPerRoot: number): IndexedTypeSystemRules {
  return {
    languageId,
    adapterVersion: "contract-1",
    ruleSetVersion: "contract-rules-1",
    serializationVersion: "contract-wire-1",
    maxDepth,
    maxTypesPerRoot,
    scalars: { string: "string" },
    externalSymbols: ["external"],
    wrappers: []
  };
}

function declaration(
  scope: { languageId: string; repoId: string; resolutionScopeId: string },
  canonicalName: string,
  fields: SchemaFieldSpec[],
  generation: string,
  typeParameters: string[] = []
): IndexedSchemaDeclaration {
  const identity: TypeDeclarationIdentity = { ...scope, canonicalName };
  return {
    fact: {
      id: typeDeclarationIdentityId(identity),
      identity,
      fileId: `file:${canonicalName}`,
      declarationKind: "class",
      typeParameters,
      generation
    },
    shape: { kind: "object", fields }
  };
}

function field(name: string, typeName: string): SchemaFieldSpec {
  return {
    sourceName: name,
    serializedName: name,
    type: { kind: "unresolved", normalizedExpression: { kind: "reference", name: typeName }, diagnosticId: `diagnostic:${name}` },
    optional: false,
    nullable: false,
    sourceLocation: { fileId: `file:${name}` }
  };
}

function variableField(name: string, variable: string): SchemaFieldSpec {
  return {
    sourceName: name,
    serializedName: name,
    type: { kind: "unresolved", normalizedExpression: { kind: "variable", name: variable }, diagnosticId: `diagnostic:${name}` },
    optional: false,
    nullable: false,
    sourceLocation: { fileId: `file:${name}` }
  };
}

function root(languageId: string, generation: string, id: string, rawTypeExpression: string): SchemaRootReference {
  return {
    id,
    repoId: "repo:consumer",
    ownerSpecId: "spec:owner",
    ownerFileId: "file:owner",
    relationKind: "RESPONSE_SCHEMA",
    languageId,
    frameworkId: "adapter-contract",
    rawTypeExpression,
    resolutionContextId: `context:${languageId}`,
    slot: { kind: "return" },
    evidenceId: "evidence:root",
    generation
  };
}
