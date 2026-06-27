import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseSourceFile } from "../src/core/parsing/parserRegistry.js";
import { javaSchemaExtractor } from "../src/core/contracts/extraction/builtin/javaSchemaExtractor.js";
import { repoId } from "../src/shared/path.js";
import type { ExtractorFactBundle } from "../src/core/contracts/extraction/crossRepoContracts.js";
import type { SchemaSpec } from "../src/core/contracts/spec.js";

async function extract(source: string): Promise<ExtractorFactBundle> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-java-schema-"));
  const rel = "src/main/java/com/example/Model.java";
  const abs = path.join(dir, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, source, "utf8");
  const repo = { id: repoId("java-schema"), name: "java-schema", path: dir, remoteUrl: "", branch: "", commitSha: "", language: "java", indexedAt: "now" } as any;
  const parsed = await parseSourceFile({ repoId: repo.id, absolutePath: abs, relativePath: rel, language: "java" });
  const bundle = await javaSchemaExtractor.extract({ repos: [repo], parsedFiles: [parsed], repoResolver: () => repo });
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

describe("Java Schema Extractor", () => {
  // -- Basic POJO field extraction -----------------------------------------

  it("extracts fields from a simple POJO DTO", async () => {
    const bundle = await extract(`
public class CreateOrderRequestDTO {
    private String sku;
    private int quantity;
    private double price;
}`);
    const spec = schemaSpecFromBundle(bundle, "createorderrequestdto");
    expect(spec).toBeDefined();
    expect(spec!.fields).toHaveLength(3);
    expect(spec!.fields[0]).toMatchObject({ name: "sku", type: "string" });
    expect(spec!.fields[1]).toMatchObject({ name: "quantity", type: "number" });
    expect(spec!.fields[2]).toMatchObject({ name: "price", type: "number" });
    expect(spec!.language).toBe("java");
  });

  it("maps Java boxed types to normalized primitives", async () => {
    const bundle = await extract(`
public class TypeDemoDTO {
    private Integer count;
    private Long timestamp;
    private Double amount;
    private Boolean active;
    private String name;
    private BigDecimal total;
    private BigInteger hash;
    private LocalDate created;
    private UUID id;
}`);
    const spec = schemaSpecFromBundle(bundle, "typedemodto");
    expect(spec).toBeDefined();
    expect(spec!.fields).toHaveLength(9);
    const byName = Object.fromEntries(spec!.fields.map((f) => [f.name, f.type]));
    expect(byName["count"]).toBe("number");
    expect(byName["timestamp"]).toBe("number");
    expect(byName["amount"]).toBe("number");
    expect(byName["active"]).toBe("boolean");
    expect(byName["name"]).toBe("string");
    expect(byName["total"]).toBe("number");
    expect(byName["hash"]).toBe("bigint");
    expect(byName["created"]).toBe("date");
    expect(byName["id"]).toBe("uuid");
  });

  // -- Lombok @Data --------------------------------------------------------

  it("extracts fields from a Lombok @Data class", async () => {
    const bundle = await extract(`
import lombok.Data;

@Data
public class OrderDTO {
    private String orderId;
    private int itemCount;
}`);
    const spec = schemaSpecFromBundle(bundle, "orderdto");
    expect(spec).toBeDefined();
    expect(spec!.fields).toHaveLength(2);
    expect(spec!.fields[0]).toMatchObject({ name: "orderId", type: "string" });
    expect(spec!.fields[1]).toMatchObject({ name: "itemCount", type: "number" });

    // Verify framework is recorded as "lombok"
    const specNode = bundle.contractSpecs.find(
      (s) => s.contractId === bundle.contracts.find((c) => c.key === "orderdto")?.id
    );
    expect(specNode).toBeDefined();
    expect(specNode!.framework).toBe("lombok");
  });

  // -- Generic type wrappers -----------------------------------------------

  it("handles Optional<T> — marks as nullable", async () => {
    const bundle = await extract(`
public class UserDTO {
    private String name;
    private Optional<String> nickname;
    private Optional<Integer> age;
}`);
    const spec = schemaSpecFromBundle(bundle, "userdto");
    expect(spec).toBeDefined();
    expect(spec!.fields).toHaveLength(3);
    const nickname = spec!.fields.find((f) => f.name === "nickname");
    expect(nickname).toBeDefined();
    expect(nickname!.type).toBe("string?");
    const age = spec!.fields.find((f) => f.name === "age");
    expect(age).toBeDefined();
    expect(age!.type).toBe("number?");
  });

  it("handles List<T> as array type", async () => {
    const bundle = await extract(`
public class OrderDTO {
    private List<String> tags;
    private List<OrderItem> items;
    private ArrayList<Integer> quantities;
}`);
    const spec = schemaSpecFromBundle(bundle, "orderdto");
    expect(spec).toBeDefined();
    const tags = spec!.fields.find((f) => f.name === "tags");
    expect(tags!.type).toBe("array<string>");
    const items = spec!.fields.find((f) => f.name === "items");
    expect(items!.type).toBe("array<OrderItem>");
    const quantities = spec!.fields.find((f) => f.name === "quantities");
    expect(quantities!.type).toBe("array<number>");
  });

  it("handles Set<T> as array type", async () => {
    const bundle = await extract(`
public class TagsDTO {
    private Set<String> uniqueTags;
}`);
    const spec = schemaSpecFromBundle(bundle, "tagsdto");
    expect(spec).toBeDefined();
    expect(spec!.fields[0]!.type).toBe("array<string>");
  });

  it("handles Map<K,V> as map type", async () => {
    const bundle = await extract(`
public class ConfigDTO {
    private Map<String, String> settings;
    private HashMap<String, Object> metadata;
}`);
    const spec = schemaSpecFromBundle(bundle, "configdto");
    expect(spec).toBeDefined();
    expect(spec!.fields[0]!.type).toBe("map");
    expect(spec!.fields[1]!.type).toBe("map");
  });

  // -- Inheritance ---------------------------------------------------------

  it("records parent class name but does not expand parent fields", async () => {
    const bundle = await extract(`
public class OrderResponseDTO extends BaseResponseDTO {
    private String orderId;
    private String status;
}`);
    const spec = schemaSpecFromBundle(bundle, "orderresponsedto");
    expect(spec).toBeDefined();
    // Only fields from this class, not from BaseResponseDTO
    expect(spec!.fields).toHaveLength(2);
    expect(spec!.fields[0]!.name).toBe("orderId");
    expect(spec!.fields[1]!.name).toBe("status");

    // Should have a USES_SCHEMA edge to BaseResponseDTO
    const rel = bundle.semanticRelations.find(
      (r) => r.kind === "USES_SCHEMA" && r.toSpecId === "schema-ref:BaseResponseDTO"
    );
    expect(rel).toBeDefined();
    expect(rel!.reason).toContain("extends");
  });

  // -- Static / transient fields are skipped --------------------------------

  it("skips static and transient fields", async () => {
    const bundle = await extract(`
public class EntityDTO {
    private static final long serialVersionUID = 1L;
    private transient int cachedHash;
    private String name;
    private int age;
}`);
    const spec = schemaSpecFromBundle(bundle, "entitydto");
    expect(spec).toBeDefined();
    // Only "name" and "age" should be present
    expect(spec!.fields).toHaveLength(2);
    const names = spec!.fields.map((f) => f.name).sort();
    expect(names).toEqual(["age", "name"]);
  });

  // -- Schema classification -----------------------------------------------

  it("classifies classes ending in DTO as dto kind", async () => {
    const bundle = await extract(`
public class ProductDTO { private String name; }
public class OrderSchema { private String id; }
public class OrderPayload { private String data; }`);

    const contracts = bundle.contracts;
    const keys = contracts.map((c) => c.key).sort();
    expect(keys).toContain("productdto");
    expect(keys).toContain("orderschema");
    expect(keys).toContain("orderpayload");
  });

  // -- Non-DTO classes are skipped ------------------------------------------

  it("skips classes that do not match DTO/Schema naming patterns", async () => {
    const bundle = await extract(`
public class OrderController { private String service; }
public class OrderService { private String repo; }`);

    const specs = bundle.contractSpecs.filter((s) => s.specKind === "schema");
    expect(specs).toHaveLength(0);
  });

  // -- Contract evidence ---------------------------------------------------

  it("emits evidence with rule java-schema-fields and confidence 0.75", async () => {
    const bundle = await extract(`
public class UserDTO { private String name; }`);

    const evidenceNodes = bundle.evidence.filter((e) => e.rule === "java-schema-fields");
    expect(evidenceNodes.length).toBeGreaterThanOrEqual(1);
    for (const ev of evidenceNodes) {
      expect(ev.confidence).toBe(0.75);
    }
  });

  // -- No duplicate from sharedSymbolExtractor ------------------------------

  it("does not produce duplicate contracts from sharedSymbolExtractor", async () => {
    // The sharedSymbolExtractor skips schema/dto for Java files.
    // This test verifies the javaSchemaExtractor itself produces exactly one contract.
    const bundle = await extract(`
public class UniqueDTO { private String id; }`);

    const contracts = bundle.contracts.filter((c) => c.key === "uniquedto");
    expect(contracts).toHaveLength(1);
  });

  // -- Business entity wiring -----------------------------------------------

  it("wires up business entity for schema contracts", async () => {
    const bundle = await extract(`
public class OrderDTO { private String id; }`);

    const entities = bundle.entities.filter((e) => e.kind === "domain");
    expect(entities.length).toBeGreaterThanOrEqual(1);
    const orderEntity = entities.find((e) => e.name === "Order");
    expect(orderEntity).toBeDefined();
  });
});
