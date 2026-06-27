import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseSourceFile } from "../src/parsers/parserRegistry.js";
import { goSchemaExtractor } from "../src/extractors/builtin/goSchemaExtractor.js";
import { repoId } from "../src/shared/path.js";
import type { ExtractorFactBundle } from "../src/extractors/crossRepoContracts.js";
import type { SchemaSpec } from "../src/contracts/spec.js";

async function extract(source: string): Promise<ExtractorFactBundle> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-go-schema-"));
  const rel = "src/models.go";
  const abs = path.join(dir, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, source, "utf8");
  const repo = { id: repoId("go-schema"), name: "go-schema", path: dir, remoteUrl: "", branch: "", commitSha: "", language: "go", indexedAt: "now" } as any;
  const parsed = await parseSourceFile({ repoId: repo.id, absolutePath: abs, relativePath: rel, language: "go" });
  const bundle = await goSchemaExtractor.extract({ repos: [repo], parsedFiles: [parsed], repoResolver: () => repo });
  await fs.rm(dir, { recursive: true, force: true });
  return bundle;
}

function schemaSpecFromBundle(bundle: ExtractorFactBundle, contractKey: string): SchemaSpec | undefined {
  const spec = bundle.contractSpecs.find((s) => {
    const contract = bundle.contracts.find((c) => c.id === s.contractId);
    return contract?.key === contractKey;
  });
  if (!spec) return undefined;
  return JSON.parse(spec.specJson) as SchemaSpec;
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
    expect(spec!.fields).toHaveLength(3);
    expect(spec!.fields[0]).toMatchObject({ name: "SKU", type: "string" });
    expect(spec!.fields[1]).toMatchObject({ name: "Quantity", type: "number" });
    expect(spec!.fields[2]).toMatchObject({ name: "Price", type: "number" });
    expect(spec!.language).toBe("go");
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
    for (const f of spec!.fields) byName[f.name] = f.type;
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
    const avatar = spec!.fields.find((f) => f.name === "Avatar");
    expect(avatar).toBeDefined();
    expect(avatar!.type).toBe("string?");
    expect(avatar!.nullable).toBe(true);
    const age = spec!.fields.find((f) => f.name === "Age");
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
    const tags = spec!.fields.find((f) => f.name === "Tags");
    expect(tags!.type).toBe("array<string>");
    const items = spec!.fields.find((f) => f.name === "Items");
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
    expect(spec!.fields[0]!.type).toBe("map");
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
    expect(extSpec!.fields).toHaveLength(2);
    const embedded = extSpec!.fields.find((f) => f.name === "BaseDTO");
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
    expect(spec!.fields).toHaveLength(4);
    const names = spec!.fields.map((f) => f.name);
    expect(names).toContain("X");
    expect(names).toContain("Y");
    expect(names).toContain("Z");
    expect(names).toContain("Label");
  });

  // -- Schema classification -----------------------------------------------

  it("classifies structs ending in DTO / Schema as dto/schema", async () => {
    const bundle = await extract("package models\n" +
      "type ProductDTO struct { Name string }\n" +
      "type OrderSchema struct { ID string }\n" +
      "type OrderPayload struct { Data string }\n");
    const contracts = bundle.contracts;
    const keys = contracts.map((c) => c.key).sort();
    expect(keys).toContain("productdto");
    expect(keys).toContain("orderschema");
    expect(keys).toContain("orderpayload");
  });

  // -- Non-DTO structs are skipped ------------------------------------------

  it("skips structs that do not match DTO/Schema naming patterns", async () => {
    const bundle = await extract("package models\n" +
      "type OrderService struct { repo string }\n" +
      "type Handler struct { db string }\n");
    const specs = bundle.contractSpecs.filter((s) => s.specKind === "schema");
    expect(specs).toHaveLength(0);
  });

  // -- Contract evidence ---------------------------------------------------

  it("emits evidence with rule go-schema-fields and confidence 0.75", async () => {
    const bundle = await extract("package models\n" +
      "type UserDTO struct { Name string }\n");
    const evidenceNodes = bundle.evidence.filter((e) => e.rule === "go-schema-fields");
    expect(evidenceNodes.length).toBeGreaterThanOrEqual(1);
    for (const ev of evidenceNodes) {
      expect(ev.confidence).toBe(0.75);
    }
  });

  // -- Business entity wiring -----------------------------------------------

  it("wires up business entity for DTO structs", async () => {
    const bundle = await extract("package models\n" +
      "type OrderDTO struct { ID string }\n");
    const entities = bundle.entities.filter((e) => e.kind === "domain");
    const orderEntity = entities.find((e) => e.name === "Order");
    expect(orderEntity).toBeDefined();
  });

  // -- No duplicate from sharedSymbolExtractor ------------------------------

  it("produces exactly one contract per DTO (no sharedSymbolExtractor dup)", async () => {
    const bundle = await extract("package models\n" +
      "type UniqueDTO struct { ID string }\n");
    const contracts = bundle.contracts.filter((c) => c.key === "uniquedto");
    expect(contracts).toHaveLength(1);
  });

  // -- Embedded structs (USES_SCHEMA) ---------------------------------------

  it("emits a USES_SCHEMA edge for an embedded struct", async () => {
    const bundle = await extract("package models\n" +
      "type OrderResponseDTO struct {\n" +
      "    BaseResponseDTO\n" +
      "    OrderID string\n" +
      "}\n");
    const spec = bundle.contractSpecs.find(
      (s) => bundle.contracts.find((c) => c.id === s.contractId)?.key === "orderresponsedto"
    );
    expect(spec).toBeDefined();

    const rel = bundle.semanticRelations.find(
      (r) => r.kind === "USES_SCHEMA" && r.toSpecId === "schema-ref:BaseResponseDTO"
    );
    expect(rel).toBeDefined();
    expect(rel!.fromSpecId).toBe(`spec:${spec!.contractId}:pending`);
    expect(rel!.reason).toContain("embeds");
  });

  it("unwraps pointer and qualified embeds to the bare type name", async () => {
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
    expect(refs).toContain("schema-ref:BaseModelDTO");
    expect(refs).toContain("schema-ref:TimestampsDTO");
  });

  it("does not emit USES_SCHEMA for a struct without embeds", async () => {
    const bundle = await extract("package models\n" +
      "type PlainDTO struct { ID string }\n");
    const rels = bundle.semanticRelations.filter((r) => r.kind === "USES_SCHEMA");
    expect(rels).toHaveLength(0);
  });
});
