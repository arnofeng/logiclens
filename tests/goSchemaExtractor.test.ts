import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { objectSchemaFields } from "./helpers/schemaModel.js";
import { parseSourceFile } from "../src/core/parsing/parserRegistry.js";
import { goSchemaExtractor } from "../src/core/contracts/extraction/builtin/goSchemaExtractor.js";
import { repoId } from "../src/shared/path.js";
import type { ExtractorFactBundle } from "../src/core/contracts/extraction/crossRepoContracts.js";
import { reconcileNonJavaSchemaFacts } from "../src/core/contracts/extraction/nonJavaSchemaReconciler.js";
import type { SchemaSpec } from "../src/core/contracts/spec.js";
import { createSchemaSpec } from "../src/core/schema/model.js";

async function extract(source: string): Promise<ExtractorFactBundle> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "test-go-schema-"));
  const rel = "src/models.go";
  const abs = path.join(dir, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, source, "utf8");
  const repo = { id: repoId("go-schema"), name: "go-schema", path: dir, remoteUrl: "", branch: "", commitSha: "", language: "go", indexedAt: "now" } as any;
  const parsed = await parseSourceFile({ repoId: repo.id, absolutePath: abs, relativePath: rel, language: "go" });
  const extracted = await goSchemaExtractor.extract({ repos: [repo], parsedFiles: [parsed], repoResolver: () => repo });
  const reconciled = reconcileNonJavaSchemaFacts(extracted.contractSpecs, extracted.semanticRelations, extracted.schemaDeclarations);
  const bundle = { ...extracted, contractSpecs: reconciled.contractSpecs, semanticRelations: reconciled.semanticRelations };
  await fs.rm(dir, { recursive: true, force: true });
  return bundle;
}

function schemaSpecFromBundle(bundle: ExtractorFactBundle, contractKey: string): SchemaSpec | undefined {
  const spec = bundle.contractSpecs.find((s) => {
    const contract = bundle.contracts.find((c) => c.id === s.contractId);
    return contract?.key === contractKey;
  });
  if (spec) return JSON.parse(spec.specJson) as SchemaSpec;
  const candidate = bundle.schemaDeclarations.find((item) => item.declaration.canonicalName.toLowerCase() === contractKey);
  return candidate ? createSchemaSpec(candidate) : undefined;
}

describe("Go Schema Extractor", () => {
  // -- Basic struct extraction ----------------------------------------------

  it("extracts fields from a simple struct DTO", async () => {
    const bundle = await extract("package models\n" +
      "type CreateOrderRequestDTO struct {\n" +
      "    SKU      string\n" +
      "    Quantity int\n" +
      "    Price    float64\n" +
      "}\n");
    const spec = schemaSpecFromBundle(bundle, "createorderrequestdto");
    expect(spec).toBeDefined();
    expect(objectSchemaFields(spec!)).toHaveLength(3);
    expect(objectSchemaFields(spec!)[0]).toMatchObject({ name: "SKU", type: "string" });
    expect(objectSchemaFields(spec!)[1]).toMatchObject({ name: "Quantity", type: "number" });
    expect(objectSchemaFields(spec!)[2]).toMatchObject({ name: "Price", type: "number" });
    expect(spec!.languageId).toBe("go");
  });

  it("handles Go primitive types", async () => {
    const bundle = await extract("package models\n" +
      "type TypeDemoDTO struct {\n" +
      "    Name    string\n" +
      "    Active  bool\n" +
      "    Count   int32\n" +
      "    Ratio   float64\n" +
      "    Created string\n" + // string for time
      "}\n");
    const spec = schemaSpecFromBundle(bundle, "typedemodto");
    expect(spec).toBeDefined();
    const byName: Record<string, string> = {};
    for (const f of objectSchemaFields(spec!)) byName[f.name] = f.type;
    expect(byName["Name"]).toBe("string");
    expect(byName["Active"]).toBe("boolean");
    expect(byName["Count"]).toBe("number");
    expect(byName["Ratio"]).toBe("number");
  });

  // -- Pointer type (nullable) ----------------------------------------------

  it("handles pointer types as nullable signal", async () => {
    const bundle = await extract("package models\n" +
      "type UserDTO struct {\n" +
      "    Name   string\n" +
      "    Avatar *string\n" +
      "    Age    *int\n" +
      "}\n");
    const spec = schemaSpecFromBundle(bundle, "userdto");
    expect(spec).toBeDefined();
    const avatar = objectSchemaFields(spec!).find((f) => f.name === "Avatar");
    expect(avatar).toBeDefined();
    expect(avatar!.type).toBe("string?");
    expect(avatar!.nullable).toBe(true);
    const age = objectSchemaFields(spec!).find((f) => f.name === "Age");
    expect(age).toBeDefined();
    expect(age!.type).toBe("number?");
    expect(age!.nullable).toBe(true);
  });

  // -- Slice type -----------------------------------------------------------

  it("handles slice types", async () => {
    const bundle = await extract("package models\n" +
      "type OrderDTO struct {\n" +
      "    Tags  []string\n" +
      "    Items []OrderItem\n" +
      "}\n");
    const spec = schemaSpecFromBundle(bundle, "orderdto");
    expect(spec).toBeDefined();
    const tags = objectSchemaFields(spec!).find((f) => f.name === "Tags");
    expect(tags!.type).toBe("array<string>");
    const items = objectSchemaFields(spec!).find((f) => f.name === "Items");
    expect(items!.type).toBe("array<OrderItem>");
  });

  // -- Map type -------------------------------------------------------------

  it("handles map types", async () => {
    const bundle = await extract("package models\n" +
      "type ConfigDTO struct {\n" +
      "    Meta map[string]interface{}\n" +
      "}\n");
    const spec = schemaSpecFromBundle(bundle, "configdto");
    expect(spec).toBeDefined();
    expect(objectSchemaFields(spec!)[0]!.type).toBe("map<string,any>");
  });

  // -- Embedded struct ------------------------------------------------------

  it("records embedded struct by type name", async () => {
    const bundle = await extract("package models\n" +
      "type BaseDTO struct {\n" +
      "    ID string\n" +
      "}\n" +
      "type ExtendedDTO struct {\n" +
      "    BaseDTO\n" +
      "    Extra string\n" +
      "}\n");
    const extSpec = schemaSpecFromBundle(bundle, "extendeddto");
    expect(extSpec).toBeDefined();
    expect(objectSchemaFields(extSpec!)).toHaveLength(2);
    const embedded = objectSchemaFields(extSpec!).find((f) => f.name === "BaseDTO");
    expect(embedded).toBeDefined();
    expect(embedded!.type).toBe("BaseDTO");
  });

  // -- Multi-name field (a, b int) ------------------------------------------

  it("expands multi-name fields like \"X, Y int\"", async () => {
    const bundle = await extract("package models\n" +
      "type CoordsDTO struct {\n" +
      "    X, Y, Z float64\n" +
      "    Label   string\n" +
      "}\n");
    const spec = schemaSpecFromBundle(bundle, "coordsdto");
    expect(spec).toBeDefined();
    expect(objectSchemaFields(spec!)).toHaveLength(4);
    const names = objectSchemaFields(spec!).map((f) => f.name);
    expect(names).toContain("X");
    expect(names).toContain("Y");
    expect(names).toContain("Z");
    expect(names).toContain("Label");
  });

  // -- Schema classification -----------------------------------------------

  it("indexes structs independent of suffix without public materialization", async () => {
    const bundle = await extract("package models\n" +
      "type ProductDTO struct { Name string }\n" +
      "type OrderSchema struct { ID string }\n" +
      "type OrderPayload struct { Data string }\n");
    const keys = bundle.schemaDeclarations.map((item) => item.declaration.canonicalName.toLowerCase()).sort();
    expect(keys).toContain("productdto");
    expect(keys).toContain("orderschema");
    expect(keys).toContain("orderpayload");
    expect(bundle.contractSpecs.filter((spec) => spec.specKind === "schema")).toHaveLength(0);
  });

  // -- Non-DTO structs are skipped ------------------------------------------

  it("indexes explicit Go structs but does not materialize isolated declarations", async () => {
    const bundle = await extract("package models\n" +
      "type OrderService struct { repo string }\n" +
      "type Handler struct { db string }\n");
    expect(bundle.schemaDeclarations).toHaveLength(2);
    expect(bundle.contractSpecs.filter((s) => s.specKind === "schema")).toHaveLength(0);
  });

  // -- Contract evidence ---------------------------------------------------

  it("retains declaration evidence for later materialization", async () => {
    const bundle = await extract("package models\n" +
      "type UserDTO struct { Name string }\n");
    expect(bundle.schemaDeclarations[0]?.evidence).toMatchObject({ rule: "go-schema-declaration", confidence: 0.75 });
    expect(bundle.evidence.filter((e) => e.rule === "go-schema-fields")).toHaveLength(0);
  });

  // -- Business entity wiring -----------------------------------------------

  it("does not wire a business entity for an isolated declaration", async () => {
    const bundle = await extract("package models\n" +
      "type OrderDTO struct { ID string }\n");
    expect(bundle.schemaDeclarations).toHaveLength(1);
    expect(bundle.entities.filter((e) => e.kind === "domain")).toHaveLength(0);
  });

  // -- No duplicate from sharedSymbolExtractor ------------------------------

  it("produces exactly one declaration candidate per struct", async () => {
    const bundle = await extract("package models\n" +
      "type UniqueDTO struct { ID string }\n");
    expect(bundle.schemaDeclarations.filter((item) => item.displayName === "UniqueDTO")).toHaveLength(1);
    expect(bundle.contracts.filter((c) => c.key === "uniquedto")).toHaveLength(0);
  });

  it("indexes empty and generic structs as declarations without eager public materialization", async () => {
    const bundle = await extract("package models\n" +
      "type Empty struct {}\n" +
      "type Page[T any] struct { Item T }\n");
    expect(bundle.schemaDeclarations.find((candidate) => candidate.displayName === "Empty")).toMatchObject({
      typeParameters: [],
      shape: { kind: "object", fields: [] }
    });
    expect(bundle.schemaDeclarations.find((candidate) => candidate.displayName === "Page")?.typeParameters).toEqual(["T"]);
    expect(bundle.contractSpecs.filter((spec) => spec.specKind === "schema")).toHaveLength(0);
  });

  // -- Embedded structs (USES_SCHEMA) ---------------------------------------

  it("records embedded declaration dependencies without publishing isolated schemas", async () => {
    const bundle = await extract("package models\n" +
      "type BaseResponseDTO struct { ID string }\n" +
      "type OrderResponseDTO struct {\n" +
      "    BaseResponseDTO\n" +
      "    OrderID string\n" +
      "}\n");
    const candidate = bundle.schemaDeclarations.find((item) => item.displayName === "OrderResponseDTO");
    expect(candidate?.shape.kind === "object" ? candidate.shape.baseTypes : undefined).toEqual([
      { kind: "reference", name: "BaseResponseDTO" }
    ]);
    expect(bundle.semanticRelations.filter((r) => r.kind === "USES_SCHEMA")).toHaveLength(0);
  });

  it("keeps pointer and qualified embeds unresolved when no declaration proves them", async () => {
    const bundle = await extract("package models\n" +
      "import \"models/base\"\n" +
      "type AuditedDTO struct {\n" +
      "    *BaseModelDTO\n" +
      "    base.TimestampsDTO\n" +
      "    Name string\n" +
      "}\n");
    const refs = bundle.semanticRelations
      .filter((r) => r.kind === "USES_SCHEMA")
      .map((r) => r.toSpecId);
    expect(refs).toHaveLength(0);
    const audited = schemaSpecFromBundle(bundle, "auditeddto");
    expect(audited?.shape.kind === "object" ? audited.shape.baseTypes : undefined).toEqual([
      { kind: "nullable", inner: { kind: "reference", name: "BaseModelDTO" } },
      { kind: "reference", name: "base.TimestampsDTO" }
    ]);
  });

  it("preserves qualified generic embedded types recursively", async () => {
    const bundle = await extract("package models\n" +
      "type Item struct { ID string }\n" +
      "type Audited struct { ID string }\n" +
      "type Page[T any] struct { Value T }\n" +
      "type Result struct {\n" +
      "    Page[Item]\n" +
      "    pkg.Audited\n" +
      "    Name string\n" +
      "}\n");
    const result = bundle.schemaDeclarations.find((candidate) => candidate.displayName === "Result");
    expect(result?.shape.kind === "object" ? result.shape.baseTypes : undefined).toEqual([
      {
        kind: "application",
        target: { kind: "reference", name: "Page" },
        arguments: [{ kind: "reference", name: "Item" }]
      },
      { kind: "reference", name: "pkg.Audited" }
    ]);
  });

  it("does not emit USES_SCHEMA for a struct without embeds", async () => {
    const bundle = await extract("package models\n" +
      "type PlainDTO struct { ID string }\n");
    const rels = bundle.semanticRelations.filter((r) => r.kind === "USES_SCHEMA");
    expect(rels).toHaveLength(0);
  });
});
