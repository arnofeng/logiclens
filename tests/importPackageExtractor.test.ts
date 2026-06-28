import { describe, expect, it } from "vitest";
import { importPackageExtractor } from "../src/core/contracts/extraction/builtin/importPackageExtractor.js";

describe("importPackageExtractor", () => {
  it("has the correct extractor name", () => {
    expect(importPackageExtractor.name).toBe("builtin:import-package");
  });

  it("has no languages or frameworks restriction (runs for all repos)", () => {
    expect(importPackageExtractor.languages).toBeUndefined();
    expect(importPackageExtractor.frameworks).toBeUndefined();
  });

  it("skips markdown files (not parsed code files)", async () => {
    const result = await importPackageExtractor.extract({
      repos: [],
      parsedFiles: [
        {
          repoId: "repo:a",
          fileId: "file:md:1",
          path: "README.md",
          language: "markdown",
          hash: "hash1",
          loc: 5,
          imports: [{ fileId: "file:md:1", module: "some-package", raw: "import something from 'some-package'", line: 1 }],
          symbols: [],
          calls: []
        }
      ],
      repoResolver: () => undefined,
      aliasOverrides: []
    });

    expect(result.contracts).toEqual([]);
    expect(result.repoContracts).toEqual([]);
  });

  it("skips relative imports starting with dot", async () => {
    const result = await importPackageExtractor.extract({
      repos: [],
      parsedFiles: [
        {
          repoId: "repo:a",
          fileId: "file:ts:1",
          path: "src/index.ts",
          language: "typescript",
          hash: "hash1",
          loc: 10,
          imports: [
            { fileId: "file:ts:1", module: "./utils", raw: "import { util } from './utils'", line: 1 },
            { fileId: "file:ts:1", module: "../shared", raw: "import { shared } from '../shared'", line: 2 }
          ],
          symbols: [],
          calls: []
        }
      ],
      repoResolver: () => undefined,
      aliasOverrides: []
    });

    expect(result.contracts).toEqual([]);
  });

  it("extracts consumer contract from TypeScript imports", async () => {
    const result = await importPackageExtractor.extract({
      repos: [],
      parsedFiles: [
        {
          repoId: "repo:a",
          fileId: "file:ts:1",
          path: "src/app.ts",
          language: "typescript",
          hash: "hash1",
          loc: 15,
          imports: [
            { fileId: "file:ts:1", module: "@fixture/service-b", raw: "import { Payment } from '@fixture/service-b'", line: 3 }
          ],
          symbols: [],
          calls: []
        }
      ],
      repoResolver: () => undefined,
      aliasOverrides: []
    });

    expect(result.contracts.length).toBe(1);
    expect(result.contracts[0]).toMatchObject({
      kind: "package",
      key: "@fixture/service-b"
    });
    // Should have a consumer repo-contract relation
    const consumerRelations = result.repoContracts.filter((e) => e.role === "consumer");
    expect(consumerRelations.length).toBe(1);
    expect((consumerRelations[0] as any).repoId).toBe("repo:a");
  });

  it("extracts consumer contract from Python imports", async () => {
    const result = await importPackageExtractor.extract({
      repos: [],
      parsedFiles: [
        {
          repoId: "repo:py",
          fileId: "file:py:1",
          path: "src/app.py",
          language: "python",
          hash: "hash1",
          loc: 10,
          imports: [
            { fileId: "file:py:1", module: "fastapi", raw: "from fastapi import FastAPI", line: 1 },
            { fileId: "file:py:1", module: "requests", raw: "import requests", line: 2 }
          ],
          symbols: [],
          calls: []
        }
      ],
      repoResolver: () => undefined,
      aliasOverrides: []
    });

    expect(result.contracts.length).toBe(2);
    expect(result.contracts.map((c) => c.key).sort()).toEqual(["fastapi", "requests"]);
    expect(result.contracts.every((c) => c.kind === "package")).toBe(true);
  });

  it("extracts consumer contract from Go imports", async () => {
    const result = await importPackageExtractor.extract({
      repos: [],
      parsedFiles: [
        {
          repoId: "repo:go",
          fileId: "file:go:1",
          path: "src/main.go",
          language: "go",
          hash: "hash1",
          loc: 10,
          imports: [
            { fileId: "file:go:1", module: "net/http", raw: 'import "net/http"', line: 3 }
          ],
          symbols: [],
          calls: []
        }
      ],
      repoResolver: () => undefined,
      aliasOverrides: []
    });

    expect(result.contracts.length).toBe(1);
    expect(result.contracts[0]).toMatchObject({ kind: "package", key: "net/http" });
  });

  it("uses raw module specifier as contract key for non-Java files", async () => {
    const result = await importPackageExtractor.extract({
      repos: [],
      parsedFiles: [
        {
          repoId: "repo:a",
          fileId: "file:ts:1",
          path: "src/app.ts",
          language: "typescript",
          hash: "hash1",
          loc: 5,
          imports: [
            { fileId: "file:ts:1", module: "@scope/pkg/SubClass", raw: "import { SubClass } from '@scope/pkg/SubClass'", line: 1 }
          ],
          symbols: [],
          calls: []
        }
      ],
      repoResolver: () => undefined,
      aliasOverrides: []
    });

    // For non-Java, the full module specifier is used as the contract key (lowercased by canonicalContractKey)
    expect(result.contracts[0].key).toBe("@scope/pkg/subclass");
  });

  it("uses packageContractKeyForImport for Java imports (strips class suffix)", async () => {
    const result = await importPackageExtractor.extract({
      repos: [],
      parsedFiles: [
        {
          repoId: "repo:a",
          fileId: "file:java:1",
          path: "src/main/java/com/example/Consumer.java",
          language: "java",
          hash: "hash1",
          loc: 10,
          imports: [
            { fileId: "file:java:1", module: "com.google.common.collect.ImmutableList", raw: "import com.google.common.collect.ImmutableList;", line: 3 }
          ],
          symbols: [],
          calls: []
        }
      ],
      repoResolver: () => undefined,
      aliasOverrides: []
    });

    // For Java, the class suffix is stripped — contract key is just the package
    expect(result.contracts[0].key).toBe("com.google.common.collect");
  });

  it("does NOT call pushResolvedPackageOwner for Java imports", async () => {
    const result = await importPackageExtractor.extract({
      repos: [],
      parsedFiles: [
        {
          repoId: "repo:a",
          fileId: "file:java:1",
          path: "src/main/java/com/example/Main.java",
          language: "java",
          hash: "hash1",
          loc: 10,
          imports: [
            { fileId: "file:java:1", module: "com.other.Service", raw: "import com.other.Service;", line: 2 }
          ],
          symbols: [],
          calls: []
        }
      ],
      repoResolver: () => undefined,
      aliasOverrides: []
    });

    // Java imports should NOT trigger pushResolvedPackageOwner
    // (no owner evidence because there's no package.json-based identity for Java packages)
    const ownerRelations = result.repoContracts.filter((e) => e.role === "owner");
    expect(ownerRelations).toEqual([]);
  });

  it("pushes packageUsages entries for each import", async () => {
    const result = await importPackageExtractor.extract({
      repos: [],
      parsedFiles: [
        {
          repoId: "repo:a",
          fileId: "file:ts:1",
          path: "src/app.ts",
          language: "typescript",
          hash: "hash1",
          loc: 10,
          imports: [
            { fileId: "file:ts:1", module: "lodash", raw: "import _ from 'lodash'", line: 1 },
            { fileId: "file:ts:1", module: "react", raw: "import React from 'react'", line: 2 }
          ],
          symbols: [],
          calls: []
        }
      ],
      repoResolver: () => undefined,
      aliasOverrides: []
    });

    // Check that the relations include package-usage entries
    const packageUsages = result.packageUsages;
    expect(packageUsages.length).toBe(2);
  });

  it("handles empty imports array", async () => {
    const result = await importPackageExtractor.extract({
      repos: [],
      parsedFiles: [
        {
          repoId: "repo:a",
          fileId: "file:ts:1",
          path: "src/app.ts",
          language: "typescript",
          hash: "hash1",
          loc: 5,
          imports: [],
          symbols: [],
          calls: []
        }
      ],
      repoResolver: () => undefined,
      aliasOverrides: []
    });

    expect(result.contracts).toEqual([]);
    expect(result.repoContracts).toEqual([]);
  });

  it("handles empty parsedFiles array", async () => {
    const result = await importPackageExtractor.extract({
      repos: [],
      parsedFiles: [],
      repoResolver: () => undefined,
      aliasOverrides: []
    });

    expect(result.contracts).toEqual([]);
    expect(result.repoContracts).toEqual([]);
  });

  it("processes imports from multiple files across different repos and languages", async () => {
    const result = await importPackageExtractor.extract({
      repos: [],
      parsedFiles: [
        {
          repoId: "repo:a",
          fileId: "file:ts:1",
          path: "src/app.ts",
          language: "typescript",
          hash: "hash1",
          loc: 10,
          imports: [
            { fileId: "file:ts:1", module: "@fixture/service-b", raw: "import { X } from '@fixture/service-b'", line: 1 }
          ],
          symbols: [],
          calls: []
        },
        {
          repoId: "repo:b",
          fileId: "file:py:1",
          path: "src/main.py",
          language: "python",
          hash: "hash2",
          loc: 10,
          imports: [
            { fileId: "file:py:1", module: "fastapi", raw: "from fastapi import FastAPI", line: 1 }
          ],
          symbols: [],
          calls: []
        },
        {
          repoId: "repo:c",
          fileId: "file:go:1",
          path: "src/main.go",
          language: "go",
          hash: "hash3",
          loc: 10,
          imports: [
            { fileId: "file:go:1", module: "net/http", raw: 'import "net/http"', line: 3 }
          ],
          symbols: [],
          calls: []
        }
      ],
      repoResolver: () => undefined,
      aliasOverrides: []
    });

    expect(result.contracts.length).toBe(3);
    const keys = result.contracts.map((c) => c.key).sort();
    expect(keys).toEqual(["@fixture/service-b", "fastapi", "net/http"]);
  });

  it("does not produce evidence for markdown files mixed with code files", async () => {
    const result = await importPackageExtractor.extract({
      repos: [],
      parsedFiles: [
        {
          repoId: "repo:a",
          fileId: "file:md:1",
          path: "README.md",
          language: "markdown",
          hash: "hash1",
          loc: 5,
          imports: [{ fileId: "file:md:1", module: "some-pkg", raw: "import x from 'some-pkg'", line: 1 }],
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
          imports: [{ fileId: "file:ts:1", module: "real-pkg", raw: "import { x } from 'real-pkg'", line: 1 }],
          symbols: [],
          calls: []
        }
      ],
      repoResolver: () => undefined,
      aliasOverrides: []
    });

    // Only the TypeScript file's import should produce a contract
    expect(result.contracts.length).toBe(1);
    expect(result.contracts[0].key).toBe("real-pkg");
  });
});
