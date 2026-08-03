import { extractFacts } from "./helpers/extractFacts.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { javaSchemaExtractor } from "../src/core/contracts/extraction/builtin/javaSchemaExtractor.js";
import { parseSourceFile } from "../src/core/parsing/parserRegistry.js";
import { canonicalSerialize } from "../src/core/schema/model.js";
import { repoId } from "../src/shared/path.js";

describe("Java declaration prepass", () => {
  it("indexes classes, records, enums, interfaces, multiple declarations, and member types", async () => {
    const bundle = await extract(`
package example.model;
interface View { String label(); }
enum Currency { USD, JPY }
record Price(java.math.BigDecimal amount, Currency currency) {}
class Envelope<T extends View> {
  static class Member { private String value; }
  private T payload;
}
class PlainName { private Price price; }
`);
    expect(bundle.contractSpecs).toHaveLength(0);
    expect(bundle.semanticRelations).toHaveLength(0);
    expect(bundle.schemaDeclarations.map((candidate) => candidate.displayName)).toEqual([
      "Currency", "Envelope", "Member", "PlainName", "Price", "View"
    ]);
    expect(bundle.schemaDeclarations.find((candidate) => candidate.displayName === "Price")?.declarationKind).toBe("record");
    expect(bundle.schemaDeclarations.find((candidate) => candidate.displayName === "Currency")?.shape).toEqual({ kind: "enum", values: ["JPY", "USD"] });
    expect(bundle.schemaDeclarations.find((candidate) => candidate.displayName === "Envelope")?.typeParameterBounds).toMatchObject({
      T: [{ kind: "reference", name: "View" }]
    });
    expect(bundle.schemaDeclarations.find((candidate) => candidate.displayName === "Member")?.declaration.canonicalName).toBe("example.model.Envelope.Member");
  });

  it("applies source-visible Jackson and field rules without name suffixes", async () => {
    const bundle = await extract(`
package example.model;
class ArbitraryBusinessName {
  static String CONSTANT;
  transient String cache;
  @com.fasterxml.jackson.annotation.JsonIgnore String secret;
  @com.fasterxml.jackson.annotation.JsonProperty("wire_name") String sourceName;
  int count;
  Integer optionalCount;
}
`);
    const candidate = bundle.schemaDeclarations[0]!;
    expect(candidate.displayName).toBe("ArbitraryBusinessName");
    expect(candidate.shape.kind).toBe("object");
    if (candidate.shape.kind !== "object") throw new Error("Expected object shape");
    expect(candidate.shape.fields.map((field) => [field.sourceName, field.serializedName, field.nullable])).toEqual([
      ["count", "count", false],
      ["optionalCount", "optionalCount", true],
      ["sourceName", "wire_name", true]
    ]);
  });

  it("produces identical declaration artifacts for reversed file input", async () => {
    const first = await parsed("src/main/java/example/A.java", "package example; class A { B b; }");
    const second = await parsed("src/main/java/example/B.java", "package example; class B { A a; }");
    const repo = repository();
    const forward = await extractFacts(javaSchemaExtractor, { repos: [repo], parsedFiles: [first, second], repoResolver: () => repo });
    const reverse = await extractFacts(javaSchemaExtractor, { repos: [repo], parsedFiles: [second, first], repoResolver: () => repo });
    const normalize = (values: typeof forward.schemaDeclarations) => values.map(canonicalSerialize).sort();
    expect(normalize(forward.schemaDeclarations)).toEqual(normalize(reverse.schemaDeclarations));
  });
});

async function extract(source: string) {
  const file = await parsed("src/main/java/example/Model.java", source);
  const repo = repository();
  return extractFacts(javaSchemaExtractor, { repos: [repo], parsedFiles: [file], repoResolver: () => repo });
}

async function parsed(relativePath: string, source: string) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "repohelix-java-declarations-"));
  const absolutePath = path.join(directory, relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, source, "utf8");
  return parseSourceFile({ repoId: repository().id, absolutePath, relativePath, language: "java" });
}

function repository() {
  return { id: repoId("java-schema"), name: "java-schema", path: "", remoteUrl: "", branch: "", commitSha: "", language: "java", indexedAt: "now" };
}
