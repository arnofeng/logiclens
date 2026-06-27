import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseSourceFile } from "../src/parsers/parserRegistry.js";
import { tsSchemaExtractor } from "../src/extractors/builtin/tsSchemaExtractor.js";
import { repoId } from "../src/utils/path.js";
import type { ExtractorFactBundle } from "../src/extractors/crossRepoContracts.js";
import type { SchemaSpec } from "../src/contracts/spec.js";

async function extract(source: string): Promise<ExtractorFactBundle> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-ts-schema-"));
  const rel = "src/types.ts";
  const abs = path.join(dir, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, source, "utf8");
  const repo = { id: repoId("ts-schema"), name: "ts-schema", path: dir, remoteUrl: "", branch: "", commitSha: "", language: "typescript", indexedAt: "now" } as any;
  const parsed = await parseSourceFile({ repoId: repo.id, absolutePath: abs, relativePath: rel, language: "typescript" });
  const bundle = await tsSchemaExtractor.extract({ repos: [repo], parsedFiles: [parsed], repoResolver: () => repo });
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

describe("TypeScript Schema Extractor", () => {
  // -- Basic interface extraction ------------------------------------------

  it("extracts fields from a simple DTO interface", async () => {
    const bundle = await extract(`
export interface CreateOrderDTO {
  sku: string;
  quantity: number;
  price: number;
}`);
    const spec = schemaSpecFromBundle(bundle, "createorderdto");
    expect(spec).toBeDefined();
    expect(spec!.fields).toHaveLength(3);
    expect(spec!.fields[0]).toMatchObject({ name: "sku", type: "string", optional: false });
    expect(spec!.fields[1]).toMatchObject({ name: "quantity", type: "number", optional: false });
    expect(spec!.fields[2]).toMatchObject({ name: "price", type: "number", optional: false });
    expect(spec!.language).toBe("typescript");
  });

  it("extracts optional fields (marked with ?)", async () => {
    const bundle = await extract(`
export interface OrderDTO {
  id: string;
  couponCode?: string;
  notes?: string;
}`);
    const spec = schemaSpecFromBundle(bundle, "orderdto");
    expect(spec).toBeDefined();
    const optional = spec!.fields.filter((f) => f.optional);
    expect(optional).toHaveLength(2);
    expect(optional[0]!.name).toBe("couponCode");
    expect(optional[1]!.name).toBe("notes");
  });

  it("extracts fields with nested type references", async () => {
    const bundle = await extract(`
export interface OrderDTO {
  id: string;
  items: OrderItem[];
  meta: Record<string, any>;
}`);
    const spec = schemaSpecFromBundle(bundle, "orderdto");
    expect(spec).toBeDefined();
    expect(spec!.fields).toHaveLength(3);
    const itemsField = spec!.fields.find((f) => f.name === "items");
    expect(itemsField).toBeDefined();
    expect(itemsField!.type).toBe("array<OrderItem>");
    const metaField = spec!.fields.find((f) => f.name === "meta");
    expect(metaField).toBeDefined();
    expect(metaField!.type).toBe("map");
  });

  it("detects nullable from union with null", async () => {
    const bundle = await extract(`
export interface UserDTO {
  name: string;
  avatar: string | null;
  bio: string | undefined;
}`);
    const spec = schemaSpecFromBundle(bundle, "userdto");
    expect(spec).toBeDefined();
    expect(spec!.fields).toHaveLength(3);
    const avatar = spec!.fields.find((f) => f.name === "avatar");
    expect(avatar).toBeDefined();
    expect(avatar!.type).toBe("string?");
    // "?" at end of normalized type name signals nullable
    expect(avatar!.type.endsWith("?")).toBe(true);
  });

  it("skips index signatures [key: string]: Type", async () => {
    const bundle = await extract(`
export interface StringMapDTO {
  [key: string]: string;
  count: number;
}`);
    const spec = schemaSpecFromBundle(bundle, "stringmapdto");
    expect(spec).toBeDefined();
    // Only "count" should be present; index signature is skipped
    expect(spec!.fields).toHaveLength(1);
    expect(spec!.fields[0]!.name).toBe("count");
  });

  it("skips method signatures", async () => {
    const bundle = await extract(`
export interface WithMethodsDTO {
  id: string;
  validate(): boolean;
  toJSON(): object;
}`);
    const spec = schemaSpecFromBundle(bundle, "withmethodsdto");
    expect(spec).toBeDefined();
    expect(spec!.fields).toHaveLength(1);
    expect(spec!.fields[0]!.name).toBe("id");
  });

  // -- Generic type parameters ---------------------------------------------

  it("extracts generic type argument references", async () => {
    const bundle = await extract(`
export interface ApiResponseDTO<T> {
  data: T;
  error?: string;
}`);
    const spec = schemaSpecFromBundle(bundle, "apiresponsedto");
    expect(spec).toBeDefined();
    // Generic parameter T is a reference, not a primitive
    const dataField = spec!.fields.find((f) => f.name === "data");
    expect(dataField).toBeDefined();
    expect(dataField!.type).toBe("T");
  });

  // -- Type alias (object type) --------------------------------------------

  it("extracts fields from a type alias with object type", async () => {
    const bundle = await extract(`
export type OrderPayload = {
  orderId: string;
  amount: number;
  currency: string;
};`);
    const spec = schemaSpecFromBundle(bundle, "orderpayload");
    expect(spec).toBeDefined();
    expect(spec!.fields).toHaveLength(3);
    expect(spec!.fields[0]).toMatchObject({ name: "orderId", type: "string" });
    expect(spec!.fields[1]).toMatchObject({ name: "amount", type: "number" });
  });

  // -- TS utility types (Omit / Pick / Partial / Required / Readonly) ------

  it("unwraps Partial<T> to extract base type fields", async () => {
    const bundle = await extract(`
export interface BaseOrderDTO {
  id: string;
  name: string;
  price: number;
}
export type UpdateOrderDTO = Partial<BaseOrderDTO> & {
  version: number;
};`);
    // Check that the base interface was extracted
    const baseSpec = schemaSpecFromBundle(bundle, "baseorderdto");
    expect(baseSpec).toBeDefined();
    expect(baseSpec!.fields).toHaveLength(3);

    // Check that the intersection type fields are extracted
    const updateSpec = schemaSpecFromBundle(bundle, "updateorderdto");
    expect(updateSpec).toBeDefined();
    // Should have at least the "version" field from the intersection
    const versionField = updateSpec!.fields.find((f) => f.name === "version");
    expect(versionField).toBeDefined();
  });

  it("unwraps Pick<T,K> — records base type reference via USES_SCHEMA", async () => {
    const bundle = await extract(`
export interface FullOrderDTO {
  id: string;
  sku: string;
  price: number;
  createdAt: Date;
  updatedAt: Date;
}
export type OrderSummaryDTO = Pick<FullOrderDTO, 'id' | 'sku' | 'price'>;`);

    // FullOrderDTO should have its fields extracted
    const fullSpec = schemaSpecFromBundle(bundle, "fullorderdto");
    expect(fullSpec).toBeDefined();
    expect(fullSpec!.fields.length).toBeGreaterThanOrEqual(5);

    // OrderSummaryDTO should have a pending USES_SCHEMA edge to FullOrderDTO
    const rel = bundle.semanticRelations.find(
      (r) => r.kind === "USES_SCHEMA" && r.toSpecId === "schema-ref:FullOrderDTO"
    );
    expect(rel).toBeDefined();
    expect(rel!.reason).toContain("FullOrderDTO");
  });

  it("unwraps Omit<T,K> — records base type reference", async () => {
    const bundle = await extract(`
export interface UserDTO {
  id: string;
  password: string;
  email: string;
}
export type PublicUserDTO = Omit<UserDTO, 'password'>;`);

    const rel = bundle.semanticRelations.find(
      (r) => r.kind === "USES_SCHEMA" && r.toSpecId === "schema-ref:UserDTO"
    );
    expect(rel).toBeDefined();
  });

  it("unwraps Readonly<T> — records base type reference", async () => {
    const bundle = await extract(`
export interface ConfigDTO { theme: string; }
export type ReadonlyConfigDTO = Readonly<ConfigDTO>;`);

    const rel = bundle.semanticRelations.find(
      (r) => r.kind === "USES_SCHEMA" && r.toSpecId === "schema-ref:ConfigDTO"
    );
    expect(rel).toBeDefined();
  });

  it("unwraps Required<T> — records base type reference", async () => {
    const bundle = await extract(`
export interface PartialUserDTO { name?: string; email?: string; }
export type FullUserDTO = Required<PartialUserDTO>;`);

    const rel = bundle.semanticRelations.find(
      (r) => r.kind === "USES_SCHEMA" && r.toSpecId === "schema-ref:PartialUserDTO"
    );
    expect(rel).toBeDefined();
  });

  // -- Schema classification -----------------------------------------------

  it("classifies interfaces ending in DTO / Dto / Payload as dto", async () => {
    const bundle = await extract(`
export interface CreateUserDTO { name: string; }
export interface OrderPayload { id: string; }
export interface UpdateUserDto { email: string; }`);

    const dtoContracts = bundle.contracts.filter((c) => c.kind === "dto");
    expect(dtoContracts.length).toBeGreaterThanOrEqual(3);
    const keys = dtoContracts.map((c) => c.key).sort();
    expect(keys).toContain("createuserdto");
    expect(keys).toContain("orderpayload");
    expect(keys).toContain("updateuserdto");
  });

  it("classifies interfaces ending in Schema as schema", async () => {
    const bundle = await extract(`
export interface OrderSchema { id: string; name: string; }`);

    const schemaContracts = bundle.contracts.filter((c) => c.kind === "schema");
    const keys = schemaContracts.map((c) => c.key);
    expect(keys).toContain("orderschema");
  });

  // -- Producer / shared role ----------------------------------------------

  it("marks schema contracts with shared role", async () => {
    const bundle = await extract(`
export interface ProductDTO { id: string; name: string; }`);

    const relations = bundle.relations.filter((r) => r.kind === "repo-contract");
    const productRelation = relations.find((r) => {
      const contract = bundle.contracts.find((c) => c.id === r.contractId);
      return contract?.key === "productdto";
    });
    expect(productRelation).toBeDefined();
    expect(productRelation!.role).toBe("shared");
  });

  // -- Non-DTO/Schema interfaces are skipped --------------------------------

  it("skips interfaces that do not match DTO/Schema naming patterns", async () => {
    const bundle = await extract(`
export interface Props { className?: string; }
export interface State { loading: boolean; }
export interface Config { debug: boolean; }`);

    // "Props" and "State" don't match DTO/Schema patterns
    const dtoSpecs = bundle.contractSpecs.filter((s) => s.specKind === "schema");
    // None should be produced for these non-DTO interfaces
    expect(dtoSpecs).toHaveLength(0);
  });

  // -- Contract evidence ---------------------------------------------------

  it("emits evidence with rule ts-schema-fields and confidence 0.75", async () => {
    const bundle = await extract(`
export interface UserDTO { name: string; }`);

    const evidenceNodes = bundle.evidence.filter((e) => e.rule === "ts-schema-fields");
    expect(evidenceNodes.length).toBeGreaterThanOrEqual(1);
    for (const ev of evidenceNodes) {
      expect(ev.confidence).toBe(0.75);
    }
  });

  // -- Business entity wiring -----------------------------------------------

  it("wires up business entity for schema contracts", async () => {
    const bundle = await extract(`
export interface OrderDTO { id: string; }`);

    const entities = bundle.entities.filter((e) => e.kind === "domain");
    expect(entities.length).toBeGreaterThanOrEqual(1);
    const orderEntity = entities.find((e) => e.name === "Order");
    expect(orderEntity).toBeDefined();
  });
});
