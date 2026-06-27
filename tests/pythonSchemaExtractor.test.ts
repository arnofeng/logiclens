import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseSourceFile } from "../src/parsers/parserRegistry.js";
import { pythonSchemaExtractor } from "../src/extractors/builtin/pythonSchemaExtractor.js";
import { repoId } from "../src/utils/path.js";
import type { ExtractorFactBundle } from "../src/extractors/crossRepoContracts.js";
import type { SchemaSpec } from "../src/contracts/spec.js";

async function extract(source: string): Promise<ExtractorFactBundle> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-py-schema-"));
  const rel = "src/models.py";
  const abs = path.join(dir, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, source, "utf8");
  const repo = { id: repoId("py-schema"), name: "py-schema", path: dir, remoteUrl: "", branch: "", commitSha: "", language: "python", indexedAt: "now" } as any;
  const parsed = await parseSourceFile({ repoId: repo.id, absolutePath: abs, relativePath: rel, language: "python" });
  const bundle = await pythonSchemaExtractor.extract({ repos: [repo], parsedFiles: [parsed], repoResolver: () => repo });
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

describe("Python Schema Extractor", () => {
  // -- @dataclass -----------------------------------------------------------

  it("extracts fields from a @dataclass decorated class", async () => {
    const bundle = await extract(`
from dataclasses import dataclass

@dataclass
class CreateOrderDTO:
    sku: str
    quantity: int
    price: float
    active: bool
`);
    const spec = schemaSpecFromBundle(bundle, "createorderdto");
    expect(spec).toBeDefined();
    expect(spec!.fields).toHaveLength(4);
    expect(spec!.fields[0]).toMatchObject({ name: "sku", type: "string" });
    expect(spec!.fields[1]).toMatchObject({ name: "quantity", type: "number" });
    expect(spec!.fields[2]).toMatchObject({ name: "price", type: "number" });
    expect(spec!.fields[3]).toMatchObject({ name: "active", type: "boolean" });
    expect(spec!.language).toBe("python");
  });

  it("detects Optional[T] fields via default None", async () => {
    const bundle = await extract(`
from dataclasses import dataclass
from typing import Optional

@dataclass
class OrderDTO:
    order_id: str
    coupon_code: Optional[str] = None
    notes: str = ""
`);
    const spec = schemaSpecFromBundle(bundle, "orderdto");
    expect(spec).toBeDefined();
    expect(spec!.fields).toHaveLength(3);
    const coupon = spec!.fields.find((f) => f.name === "coupon_code");
    expect(coupon).toBeDefined();
    // Optional[T] is unwrapped to T?
    expect(coupon!.type).toBe("string?");
    // Default None marks it as optional
    expect(coupon!.optional).toBe(true);
  });

  it("handles Python generic types in annotations", async () => {
    const bundle = await extract(`
from dataclasses import dataclass
from typing import List, Dict, Optional

@dataclass
class OrderPayload:
    tags: List[str]
    items: List[OrderItem]
    meta: Dict[str, str]
`);
    const spec = schemaSpecFromBundle(bundle, "orderpayload");
    expect(spec).toBeDefined();
    const tags = spec!.fields.find((f) => f.name === "tags");
    expect(tags!.type).toBe("array<string>");
    const items = spec!.fields.find((f) => f.name === "items");
    expect(items!.type).toBe("array<OrderItem>");
    const meta = spec!.fields.find((f) => f.name === "meta");
    expect(meta!.type).toBe("map");
  });

  // -- TypedDict ------------------------------------------------------------

  it("extracts fields from a TypedDict subclass", async () => {
    const bundle = await extract(`
from typing import TypedDict

class OrderSchema(TypedDict):
    order_id: str
    amount: float
    status: str
`);
    const spec = schemaSpecFromBundle(bundle, "orderschema");
    expect(spec).toBeDefined();
    expect(spec!.fields).toHaveLength(3);
    expect(spec!.fields[0]).toMatchObject({ name: "order_id", type: "string" });
    expect(spec!.fields[1]).toMatchObject({ name: "amount", type: "number" });
  });

  it("records framework as python-typeddict for TypedDict", async () => {
    const bundle = await extract(`
from typing import TypedDict
class ConfigDTO(TypedDict):
    key: str
`);
    const specNode = bundle.contractSpecs.find((s) => s.specKind === "schema");
    expect(specNode).toBeDefined();
    expect(specNode!.framework).toBe("python-typeddict");
  });

  // -- NamedTuple -----------------------------------------------------------

  it("extracts fields from a NamedTuple subclass", async () => {
    const bundle = await extract(`
from typing import NamedTuple

class OrderItemDTO(NamedTuple):
    id: str
    name: str
    count: int
`);
    const spec = schemaSpecFromBundle(bundle, "orderitemdto");
    expect(spec).toBeDefined();
    expect(spec!.fields).toHaveLength(3);

    // Verify framework is recorded on the ContractSpecNode
    const specNode = bundle.contractSpecs.find((s) => s.specKind === "schema");
    expect(specNode).toBeDefined();
    expect(specNode!.framework).toBe("python-namedtuple");
  });

  // -- Schema classification -----------------------------------------------

  it("classifies classes ending in DTO / Dto / Payload as dto", async () => {
    const bundle = await extract(`
from dataclasses import dataclass

@dataclass
class ProductDTO:
    name: str

@dataclass
class UpdateUserDto:
    email: str

class EventPayload(TypedDict):
    data: str
`);
    const dtoContracts = bundle.contracts.filter((c) => c.kind === "dto");
    expect(dtoContracts.length).toBeGreaterThanOrEqual(3);
    const keys = dtoContracts.map((c) => c.key).sort();
    expect(keys).toContain("productdto");
    expect(keys).toContain("updateuserdto");
    expect(keys).toContain("eventpayload");
  });

  it("classifies classes ending in Schema as schema kind", async () => {
    const bundle = await extract(`
from typing import TypedDict
class OrderSchema(TypedDict):
    id: str
`);
    const schemaContracts = bundle.contracts.filter((c) => c.kind === "schema");
    expect(schemaContracts.map((c) => c.key)).toContain("orderschema");
  });

  // -- Non-DTO classes are skipped ------------------------------------------

  it("skips regular classes without @dataclass/TypedDict/NamedTuple", async () => {
    const bundle = await extract(`
class OrderService:
    def __init__(self):
        self.repo = None

class OrderController:
    def get_order(self, id: str):
        pass
`);
    const specs = bundle.contractSpecs.filter((s) => s.specKind === "schema");
    expect(specs).toHaveLength(0);
  });

  // -- Contract evidence ---------------------------------------------------

  it("emits evidence with rule python-schema-fields and confidence 0.75", async () => {
    const bundle = await extract(`
from dataclasses import dataclass

@dataclass
class UserDTO:
    name: str
`);
    const evidenceNodes = bundle.evidence.filter((e) => e.rule === "python-schema-fields");
    expect(evidenceNodes.length).toBeGreaterThanOrEqual(1);
    for (const ev of evidenceNodes) {
      expect(ev.confidence).toBe(0.75);
    }
  });

  // -- Business entity wiring -----------------------------------------------

  it("wires up business entity for DTO contracts", async () => {
    const bundle = await extract(`
from dataclasses import dataclass

@dataclass
class OrderDTO:
    id: str
`);
    const entities = bundle.entities.filter((e) => e.kind === "domain");
    const orderEntity = entities.find((e) => e.name === "Order");
    expect(orderEntity).toBeDefined();
  });

  // -- No duplicate from sharedSymbolExtractor ------------------------------

  it("produces exactly one contract per DTO (no sharedSymbolExtractor dup)", async () => {
    const bundle = await extract(`
from dataclasses import dataclass
@dataclass
class UniqueDTO:
    id: str
`);
    const contracts = bundle.contracts.filter((c) => c.key === "uniquedto");
    expect(contracts).toHaveLength(1);
  });

  // -- Inheritance (USES_SCHEMA) --------------------------------------------

  it("emits a USES_SCHEMA edge for a dataclass base class", async () => {
    const bundle = await extract(`
from dataclasses import dataclass
@dataclass
class OrderResponseDTO(BaseResponseDTO):
    order_id: str
`);
    const spec = bundle.contractSpecs.find(
      (s) => bundle.contracts.find((c) => c.id === s.contractId)?.key === "orderresponsedto"
    );
    expect(spec).toBeDefined();

    const rel = bundle.semanticRelations.find(
      (r) => r.kind === "USES_SCHEMA" && r.toSpecId === "schema-ref:BaseResponseDTO"
    );
    expect(rel).toBeDefined();
    expect(rel!.fromSpecId).toBe(`spec:${spec!.contractId}:pending`);
    expect(rel!.reason).toContain("inherits");
  });

  it("excludes TypedDict/NamedTuple markers and object from USES_SCHEMA", async () => {
    const bundle = await extract(`
from typing import TypedDict
class ShipmentDTO(BaseShipmentDTO, TypedDict):
    extra: str
`);
    const refs = bundle.semanticRelations
      .filter((r) => r.kind === "USES_SCHEMA")
      .map((r) => r.toSpecId);
    expect(refs).toContain("schema-ref:BaseShipmentDTO");
    expect(refs).not.toContain("schema-ref:TypedDict");
    expect(refs).not.toContain("schema-ref:object");
  });

  it("does not emit USES_SCHEMA for a class without base classes", async () => {
    const bundle = await extract(`
from dataclasses import dataclass
@dataclass
class PlainDTO:
    id: str
`);
    const rels = bundle.semanticRelations.filter((r) => r.kind === "USES_SCHEMA");
    expect(rels).toHaveLength(0);
  });
});
