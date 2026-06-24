import { describe, expect, it } from "vitest";
import { javaPackageExtractor } from "../src/extractors/builtin/javaPackageExtractor.js";

describe("javaPackageExtractor", () => {
  it("has the correct extractor name", () => {
    expect(javaPackageExtractor.name).toBe("builtin:java-package");
  });

  it("skips non-java files and returns empty bundle", async () => {
    const result = await javaPackageExtractor.extract({
      repos: [],
      parsedFiles: [
        {
          id: "file:py:1",
          repoId: "repo:a",
          fileId: "file:py:1",
          path: "src/main.py",
          language: "python",
          hash: "hash1",
          loc: 10,
          imports: [],
          symbols: [],
          calls: [],
          facts: {}
        },
        {
          id: "file:ts:1",
          repoId: "repo:a",
          fileId: "file:ts:1",
          path: "src/index.ts",
          language: "typescript",
          hash: "hash2",
          loc: 10,
          imports: [],
          symbols: [],
          calls: [],
          facts: {}
        }
      ],
      repoResolver: () => undefined,
      aliasOverrides: []
    });

    expect(result.contracts).toEqual([]);
    expect(result.evidence).toEqual([]);
    expect(result.relations).toEqual([]);
  });

  it("extracts package contract from java file with facts.packageName", async () => {
    const result = await javaPackageExtractor.extract({
      repos: [],
      parsedFiles: [
        {
          id: "file:java:1",
          repoId: "repo:a",
          fileId: "file:java:1",
          path: "src/main/java/com/example/MyService.java",
          language: "java",
          hash: "hash1",
          loc: 20,
          imports: [],
          symbols: [],
          calls: [],
          facts: { packageName: "com.example" }
        }
      ],
      repoResolver: () => undefined,
      aliasOverrides: []
    });

    expect(result.contracts.length).toBe(1);
    expect(result.contracts[0]).toMatchObject({
      kind: "package",
      key: "com.example",
      name: "com.example"
    });
  });

  it("extracts package contract from java file path when facts.packageName is missing", async () => {
    const result = await javaPackageExtractor.extract({
      repos: [],
      parsedFiles: [
        {
          id: "file:java:2",
          repoId: "repo:a",
          fileId: "file:java:2",
          path: "src/main/java/com/example/service/OrderService.java",
          language: "java",
          hash: "hash2",
          loc: 30,
          imports: [],
          symbols: [],
          calls: [],
          facts: {}
        }
      ],
      repoResolver: () => undefined,
      aliasOverrides: []
    });

    expect(result.contracts.length).toBe(1);
    expect(result.contracts[0]).toMatchObject({
      kind: "package",
      key: "com.example.service"
    });
  });

  it("skips java files with no package name in facts or path", async () => {
    const result = await javaPackageExtractor.extract({
      repos: [],
      parsedFiles: [
        {
          id: "file:java:3",
          repoId: "repo:a",
          fileId: "file:java:3",
          path: "MyService.java",
          language: "java",
          hash: "hash3",
          loc: 5,
          imports: [],
          symbols: [],
          calls: [],
          facts: {}
        }
      ],
      repoResolver: () => undefined,
      aliasOverrides: []
    });

    // No package can be inferred from the root-level file path
    expect(result.contracts).toEqual([]);
  });

  it("extracts consumer contract from java file imports", async () => {
    const result = await javaPackageExtractor.extract({
      repos: [],
      parsedFiles: [
        {
          id: "file:java:4",
          repoId: "repo:a",
          fileId: "file:java:4",
          path: "src/main/java/com/example/Consumer.java",
          language: "java",
          hash: "hash4",
          loc: 15,
          imports: [
            { module: "com.google.common.collect.ImmutableList", raw: "import com.google.common.collect.ImmutableList;", line: 3 }
          ],
          symbols: [],
          calls: [],
          facts: { packageName: "com.example" }
        }
      ],
      repoResolver: () => undefined,
      aliasOverrides: []
    });

    // Should have the package contract (owner) + imported package contract (consumer)
    expect(result.contracts.length).toBeGreaterThanOrEqual(2);
    const consumerContract = result.contracts.find((c) => c.key === "com.google.common.collect");
    expect(consumerContract).toBeDefined();
    expect(consumerContract!.kind).toBe("package");
  });

  it("skips relative imports (starting with dot)", async () => {
    const result = await javaPackageExtractor.extract({
      repos: [],
      parsedFiles: [
        {
          id: "file:java:5",
          repoId: "repo:a",
          fileId: "file:java:5",
          path: "src/main/java/com/example/Main.java",
          language: "java",
          hash: "hash5",
          loc: 10,
          imports: [
            { module: ".Helper", raw: "import .Helper;", line: 2 },
            { module: "..utils.Util", raw: "import ..utils.Util;", line: 3 }
          ],
          symbols: [],
          calls: [],
          facts: { packageName: "com.example" }
        }
      ],
      repoResolver: () => undefined,
      aliasOverrides: []
    });

    // Only the package contract from facts.packageName, no consumer contracts from relative imports
    expect(result.contracts.length).toBe(1);
    expect(result.contracts[0].key).toBe("com.example");
  });
});
