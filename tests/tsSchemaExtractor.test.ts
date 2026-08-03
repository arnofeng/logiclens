import { extractFacts } from "./helpers/extractFacts.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { objectSchemaFields } from "./helpers/schemaModel.js";
import { parseSourceFile } from "../src/core/parsing/parserRegistry.js";
import { tsSchemaExtractor } from "../src/core/contracts/extraction/builtin/tsSchemaExtractor.js";
import { repoId } from "../src/shared/path.js";
import type { ExtractedFacts } from "../src/core/contracts/extraction/contracts.js";
import { reconcileNonJavaSchemaFacts } from "../src/core/contracts/extraction/nonJavaSchemaReconciler.js";
import type { SchemaSpec } from "../src/core/contracts/spec.js";
import { createSchemaSpec } from "../src/core/schema/model.js";

async function extract(source: string): Promise<ExtractedFacts> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "test-ts-schema-"));
  const rel = "src/types.ts";
  const abs = path.join(dir, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, source, "utf8");
  const repo = { id: repoId("ts-schema"), name: "ts-schema", path: dir, remoteUrl: "", branch: "", commitSha: "", language: "typescript", indexedAt: "now" } as any;
  const parsed = await parseSourceFile({ repoId: repo.id, absolutePath: abs, relativePath: rel, language: "typescript" });
  const extracted = await extractFacts(tsSchemaExtractor, { repos: [repo], parsedFiles: [parsed], repoResolver: () => repo });
  const reconciled = reconcileNonJavaSchemaFacts(extracted.contractSpecs, extracted.semanticRelations, extracted.schemaDeclarations);
  const bundle = { ...extracted, contractSpecs: reconciled.contractSpecs, semanticRelations: reconciled.semanticRelations };
  await fs.rm(dir, { recursive: true, force: true });
  return bundle;
}

function schemaSpecFromBundle(bundle: ExtractedFacts, contractKey: string): SchemaSpec | undefined {
  const spec = bundle.contractSpecs.find((s) => {
    const contract = bundle.contracts.find((c) => c.id === s.contractId);
    return contract?.key === contractKey;
  });
  if (spec) return JSON.parse(spec.specJson) as SchemaSpec;
  const candidate = bundle.schemaDeclarations.find((item) => item.declaration.canonicalName.toLowerCase() === contractKey);
  return candidate ? createSchemaSpec(candidate) : undefined;
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
    expect(objectSchemaFields(spec!)).toHaveLength(3);
    expect(objectSchemaFields(spec!)[0]).toMatchObject({ name: "sku", type: "string", optional: false });
    expect(objectSchemaFields(spec!)[1]).toMatchObject({ name: "quantity", type: "number", optional: false });
    expect(objectSchemaFields(spec!)[2]).toMatchObject({ name: "price", type: "number", optional: false });
    expect(spec!.languageId).toBe("typescript");
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
    const optional = objectSchemaFields(spec!).filter((f) => f.optional);
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
    expect(objectSchemaFields(spec!)).toHaveLength(3);
    const itemsField = objectSchemaFields(spec!).find((f) => f.name === "items");
    expect(itemsField).toBeDefined();
    expect(itemsField!.type).toBe("array<OrderItem>");
    const metaField = objectSchemaFields(spec!).find((f) => f.name === "meta");
    expect(metaField).toBeDefined();
    // Declaration candidates preserve the source application until a typed
    // root supplies a resolution context; the adapter then canonicalizes the
    // builtin Record symbol to a map without pre-empting user shadowing.
    expect(metaField!.type).toBe("Record<string,any>");
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
    expect(objectSchemaFields(spec!)).toHaveLength(3);
    const avatar = objectSchemaFields(spec!).find((f) => f.name === "avatar");
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
    expect(objectSchemaFields(spec!)).toHaveLength(1);
    expect(objectSchemaFields(spec!)[0]!.name).toBe("count");
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
    expect(objectSchemaFields(spec!)).toHaveLength(1);
    expect(objectSchemaFields(spec!)[0]!.name).toBe("id");
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
    const dataField = objectSchemaFields(spec!).find((f) => f.name === "data");
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
    expect(objectSchemaFields(spec!)).toHaveLength(3);
    expect(objectSchemaFields(spec!)[0]).toMatchObject({ name: "orderId", type: "string" });
    expect(objectSchemaFields(spec!)[1]).toMatchObject({ name: "amount", type: "number" });
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
    expect(objectSchemaFields(baseSpec!)).toHaveLength(3);

    // Check that the intersection type fields are extracted
    const updateSpec = schemaSpecFromBundle(bundle, "updateorderdto");
    expect(updateSpec).toBeDefined();
    // Should have at least the "version" field from the intersection
    const versionField = objectSchemaFields(updateSpec!).find((f) => f.name === "version");
    expect(versionField).toBeDefined();
  });

  it("unwraps Pick<T,K> → records base type reference via USES_SCHEMA", async () => {
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
    expect(objectSchemaFields(fullSpec!).length).toBeGreaterThanOrEqual(5);

    expect(bundle.schemaDeclarations.find((item) => item.displayName === "OrderSummaryDTO")?.shape).toMatchObject({
      baseTypes: [{ kind: "reference", name: "FullOrderDTO" }]
    });
    expect(bundle.semanticRelations.filter((r) => r.kind === "USES_SCHEMA")).toHaveLength(0);
  });

  it("unwraps Omit<T,K> → records base type reference", async () => {
    const bundle = await extract(`
export interface UserDTO {
  id: string;
  password: string;
  email: string;
}
export type PublicUserDTO = Omit<UserDTO, 'password'>;`);

    expect(bundle.schemaDeclarations.find((item) => item.displayName === "PublicUserDTO")?.shape).toMatchObject({
      baseTypes: [{ kind: "reference", name: "UserDTO" }]
    });
    expect(bundle.semanticRelations.filter((r) => r.kind === "USES_SCHEMA")).toHaveLength(0);
  });

  it("unwraps Readonly<T> → records base type reference", async () => {
    const bundle = await extract(`
export interface ConfigDTO { theme: string; }
export type ReadonlyConfigDTO = Readonly<ConfigDTO>;`);

    expect(bundle.schemaDeclarations.find((item) => item.displayName === "ReadonlyConfigDTO")?.shape).toMatchObject({
      baseTypes: [{ kind: "reference", name: "ConfigDTO" }]
    });
  });

  it("unwraps Required<T> → records base type reference", async () => {
    const bundle = await extract(`
export interface PartialUserDTO { name?: string; email?: string; }
export type FullUserDTO = Required<PartialUserDTO>;`);

    expect(bundle.schemaDeclarations.find((item) => item.displayName === "FullUserDTO")?.shape).toMatchObject({
      baseTypes: [{ kind: "reference", name: "PartialUserDTO" }]
    });
  });

  it("preserves interface inheritance and recursive field Type IR", async () => {
    const bundle = await extract(`
export interface User { id: string; }
export interface Admin { role: string; }
export interface Page<T> { value: T; }
export interface Result extends Page<User>, models.Audited {
  actor: User | Admin;
  pages: Page<User>[];
}`);
    const result = bundle.schemaDeclarations.find((candidate) => candidate.displayName === "Result");
    expect(bundle.schemaDeclarations.find((candidate) => candidate.displayName === "Page")?.typeParameters).toEqual(["T"]);
    expect(result?.shape.kind === "object" ? result.shape.baseTypes : undefined).toEqual([
      {
        kind: "application",
        target: { kind: "reference", name: "Page" },
        arguments: [{ kind: "reference", name: "User" }]
      },
      { kind: "reference", name: "models.Audited" }
    ]);
    const fields = result?.shape.kind === "object" ? result.shape.fields : [];
    expect(fields.find((field) => field.sourceName === "actor")?.type).toMatchObject({
      kind: "unresolved",
      normalizedExpression: {
        kind: "union",
        members: [{ kind: "reference", name: "User" }, { kind: "reference", name: "Admin" }]
      }
    });
    expect(fields.find((field) => field.sourceName === "pages")?.type).toMatchObject({
      kind: "unresolved",
      normalizedExpression: {
        kind: "array",
        element: {
          kind: "application",
          target: { kind: "reference", name: "Page" },
          arguments: [{ kind: "reference", name: "User" }]
        }
      }
    });
  });

  // -- Schema classification -----------------------------------------------

  it("indexes declarations independent of naming suffix without public materialization", async () => {
    const bundle = await extract(`
export interface CreateUserDTO { name: string; }
export interface OrderPayload { id: string; }
export interface UpdateUserDto { email: string; }`);

    expect(bundle.contractSpecs.filter((spec) => spec.specKind === "schema")).toHaveLength(0);
    const keys = bundle.schemaDeclarations.map((item) => item.declaration.canonicalName.toLowerCase()).sort();
    expect(keys).toContain("createuserdto");
    expect(keys).toContain("orderpayload");
    expect(keys).toContain("updateuserdto");
  });

  it("indexes interfaces ending in Schema without suffix-triggered materialization", async () => {
    const bundle = await extract(`
export interface OrderSchema { id: string; name: string; }`);

    expect(bundle.schemaDeclarations.map((item) => item.displayName)).toContain("OrderSchema");
    expect(bundle.contractSpecs.filter((spec) => spec.specKind === "schema")).toHaveLength(0);
  });

  // -- Producer / shared role ----------------------------------------------

  it("does not emit a shared role before a declaration becomes reachable", async () => {
    const bundle = await extract(`
export interface ProductDTO { id: string; name: string; }`);

    expect(bundle.schemaDeclarations).toHaveLength(1);
    expect(bundle.repoContracts).toHaveLength(0);
  });

  // -- Non-DTO/Schema interfaces are skipped --------------------------------

  it("indexes explicit TypeScript structures but does not materialize isolated declarations", async () => {
    const bundle = await extract(`
export interface Props { className?: string; }
export interface State { loading: boolean; }
export interface Config { debug: boolean; }`);

    // "Props" and "State" don't match DTO/Schema patterns
    expect(bundle.schemaDeclarations).toHaveLength(3);
    expect(bundle.contractSpecs.filter((s) => s.specKind === "schema")).toHaveLength(0);
  });

  // -- Contract evidence ---------------------------------------------------

  it("retains declaration evidence for later materialization", async () => {
    const bundle = await extract(`
export interface UserDTO { name: string; }`);

    expect(bundle.schemaDeclarations[0]?.evidence).toMatchObject({ rule: "ts-schema-declaration", confidence: 0.75 });
    expect(bundle.evidence.filter((e) => e.rule === "ts-schema-fields")).toHaveLength(0);
  });

  // -- Business entity wiring -----------------------------------------------

  it("does not wire a business entity for an isolated declaration", async () => {
    const bundle = await extract(`
export interface OrderDTO { id: string; }`);

    expect(bundle.schemaDeclarations).toHaveLength(1);
    expect(bundle.entities.filter((e) => e.kind === "domain")).toHaveLength(0);
  });
});
