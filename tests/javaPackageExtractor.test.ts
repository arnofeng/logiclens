import { describe, expect, it } from "vitest";
import { javaPackageExtractor } from "../src/core/contracts/extraction/builtin/javaPackageExtractor.js";

describe("javaPackageExtractor", () => {
  it("declares java as its supported language", () => {
    expect(javaPackageExtractor.languages).toEqual(["java"]);
  });

  it("has the correct extractor name", () => {
    expect(javaPackageExtractor.name).toBe("builtin:java-package");
  });

  it("skips non-java files and returns empty bundle", async () => {
    const result = await javaPackageExtractor.extract({
      repos: [],
      parsedFiles: [
        {
          repoId: "repo:a",
          fileId: "file:py:1",
          path: "src/main.py",
          language: "python",
          hash: "hash1",
          loc: 10,
          imports: [{ fileId: "file:py:1", module: "os", raw: "import os", line: 1 }],
          symbols: [],
          calls: []
        },
        {
          repoId: "repo:a",
          fileId: "file:ts:1",
          path: "src/index.ts",
          language: "typescript",
          hash: "hash2",
          loc: 10,
          imports: [{ fileId: "file:ts:1", module: "react", raw: "import React from 'react'", line: 1 }],
          symbols: [],
          calls: []
        }
      ],
      repoResolver: () => undefined,
      aliasOverrides: []
    });

    expect(result.contracts).toEqual([]);
    expect(result.evidence).toEqual([]);
    expect(result.repoContracts).toEqual([]);
  });

  it("extracts package contract from java file with facts.packageName", async () => {
    const result = await javaPackageExtractor.extract({
      repos: [],
      parsedFiles: [
        {
          repoId: "repo:a",
          fileId: "file:java:1",
          path: "src/main/java/com/example/MyService.java",
          language: "java",
          hash: "hash1",
          loc: 20,
          imports: [],
          symbols: [],
          calls: [],
          facts: { repoId: "repo:a", fileId: "file:java:1", path: "src/main/java/com/example/MyService.java", language: "java", packageName: "com.example", imports: [], symbols: [], annotations: [], decorators: [], calls: [], literals: [] }
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
          repoId: "repo:a",
          fileId: "file:java:2",
          path: "src/main/java/com/example/service/OrderService.java",
          language: "java",
          hash: "hash2",
          loc: 30,
          imports: [],
          symbols: [],
          calls: [],
          facts: { repoId: "repo:a", fileId: "file:java:2", path: "src/main/java/com/example/service/OrderService.java", language: "java", imports: [], symbols: [], annotations: [], decorators: [], calls: [], literals: [] }
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
          repoId: "repo:a",
          fileId: "file:java:3",
          path: "MyService.java",
          language: "java",
          hash: "hash3",
          loc: 5,
          imports: [],
          symbols: [],
          calls: [],
          facts: { repoId: "repo:a", fileId: "file:java:3", path: "MyService.java", language: "java", imports: [], symbols: [], annotations: [], decorators: [], calls: [], literals: [] }
        }
      ],
      repoResolver: () => undefined,
      aliasOverrides: []
    });

    // No package can be inferred from the root-level file path
    expect(result.contracts).toEqual([]);
  });

  it("does NOT extract import contracts (handled by importPackageExtractor)", async () => {
    const result = await javaPackageExtractor.extract({
      repos: [],
      parsedFiles: [
        {
          repoId: "repo:a",
          fileId: "file:java:4",
          path: "src/main/java/com/example/Consumer.java",
          language: "java",
          hash: "hash4",
          loc: 15,
          imports: [
            { fileId: "file:java:4", module: "com.google.common.collect.ImmutableList", raw: "import com.google.common.collect.ImmutableList;", line: 3 }
          ],
          symbols: [],
          calls: [],
          facts: { repoId: "repo:a", fileId: "file:java:4", path: "src/main/java/com/example/Consumer.java", language: "java", packageName: "com.example", imports: [], symbols: [], annotations: [], decorators: [], calls: [], literals: [] }
        }
      ],
      repoResolver: () => undefined,
      aliasOverrides: []
    });

    // Only the package contract from facts.packageName, no import contracts
    expect(result.contracts.length).toBe(1);
    expect(result.contracts[0].key).toBe("com.example");
    // No consumer relations — imports are handled by importPackageExtractor
    const consumerRelations = result.repoContracts.filter((e) => e.role === "consumer");
    expect(consumerRelations).toEqual([]);
  });

  it("produces owner evidence for the java package", async () => {
    const result = await javaPackageExtractor.extract({
      repos: [],
      parsedFiles: [
        {
          repoId: "repo:a",
          fileId: "file:java:5",
          path: "src/main/java/com/example/Main.java",
          language: "java",
          hash: "hash5",
          loc: 10,
          imports: [],
          symbols: [],
          calls: [],
          facts: { repoId: "repo:a", fileId: "file:java:5", path: "src/main/java/com/example/Main.java", language: "java", packageName: "com.example", imports: [], symbols: [], annotations: [], decorators: [], calls: [], literals: [] }
        }
      ],
      repoResolver: () => undefined,
      aliasOverrides: []
    });

    expect(result.evidence.length).toBe(1);
    expect(result.evidence[0]).toMatchObject({
      repoId: "repo:a",
      rule: "java-package-path",
      raw: "package com.example"
    });

    const ownerRelations = result.repoContracts.filter((e) => e.role === "owner");
    expect(ownerRelations.length).toBe(1);
  });

  it("handles multiple java files from different repos", async () => {
    const result = await javaPackageExtractor.extract({
      repos: [],
      parsedFiles: [
        {
          repoId: "repo:a",
          fileId: "file:java:1",
          path: "src/main/java/com/service-a/Main.java",
          language: "java",
          hash: "hash1",
          loc: 10,
          imports: [],
          symbols: [],
          calls: [],
          facts: { repoId: "repo:a", fileId: "file:java:1", path: "src/main/java/com/service-a/Main.java", language: "java", packageName: "com.service-a", imports: [], symbols: [], annotations: [], decorators: [], calls: [], literals: [] }
        },
        {
          repoId: "repo:b",
          fileId: "file:java:2",
          path: "src/main/java/com/service-b/Main.java",
          language: "java",
          hash: "hash2",
          loc: 10,
          imports: [],
          symbols: [],
          calls: [],
          facts: { repoId: "repo:b", fileId: "file:java:2", path: "src/main/java/com/service-b/Main.java", language: "java", packageName: "com.service-b", imports: [], symbols: [], annotations: [], decorators: [], calls: [], literals: [] }
        }
      ],
      repoResolver: () => undefined,
      aliasOverrides: []
    });

    expect(result.contracts.length).toBe(2);
    expect(result.contracts.map((c) => c.key).sort()).toEqual(["com.service-a", "com.service-b"]);
  });
});
