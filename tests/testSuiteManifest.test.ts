import { describe, expect, it } from "vitest";
import { collectAllTestFiles, filesForSuite, TEST_SUITES } from "../scripts/test.js";

describe("release test suite manifest", () => {
  it.each(Object.entries(TEST_SUITES))("keeps %s deterministically sorted with no duplicates", (_name, files) => {
    expect(files).toEqual([...files].sort());
    expect(new Set(files).size).toBe(files.length);
  });

  it("covers lexical contracts, quality, Ask, and native Kuzu lifecycle gates", () => {
    expect(filesForSuite("retrieval-release")).toEqual(expect.arrayContaining([
      "tests/lexicalContracts.test.ts",
      "tests/lexicalProjectionPerformance.test.ts",
      "tests/retrievalProviderContracts.test.ts",
      "tests/providerLexicalConformance.test.ts",
      "tests/kuzuLexicalLifecycle.test.ts",
      "tests/kuzuWorkspaceLexicalSpike.test.ts",
      "tests/retrieval/workspaceLifecycleConformance.test.ts",
      "tests/workspaceRetrievalQuality.test.ts",
      "tests/workspaceAskRetrieval.test.ts",
      "tests/workspaceUnifiedRetrieval.e2e.test.ts",
    ]));
  });

  it("keeps contract/schema correctness as an independent Kuzu hard gate", () => {
    expect(filesForSuite("contract-schema-release")).toEqual(expect.arrayContaining([
      "tests/contractSchemaRelease.test.ts",
      "tests/indexGenerationAtomicity.test.ts",
      "tests/changedOnlyIncrementalAtomicity.test.ts",
      "tests/schemaAdapterContract.test.ts",
      "tests/schemaQuality.test.ts",
    ]));
  });

  it("covers the new Neo4j E2E and both existing real Neo4j conformance suites", () => {
    expect(filesForSuite("neo4j-integration")).toEqual(expect.arrayContaining([
      "tests/neo4jWorkspaceUnifiedRetrieval.e2e.test.ts",
      "tests/neo4jWorkspaceLexicalSpike.test.ts",
      "tests/retrieval/neo4jWorkspaceLifecycleConformance.test.ts",
      "tests/neo4jContractSchemaRelease.test.ts",
    ]));
  });

  it("keeps default all mode recursive so every test remains collected", () => {
    const all = filesForSuite("all");
    expect(all).toEqual(collectAllTestFiles());
    expect(all).toContain("tests/testSuiteManifest.test.ts");
    expect(all).toContain("packages/plugin-csharp/tests/parser.test.ts");
    expect(all.every((file) => file.endsWith(".test.ts"))).toBe(true);
    expect(all.slice(0, 3)).toEqual([
      "tests/indexGenerationAtomicity.test.ts",
      "tests/contractSchemaRelease.test.ts",
      "tests/changedOnlyIncrementalAtomicity.test.ts",
    ]);
  });
});
