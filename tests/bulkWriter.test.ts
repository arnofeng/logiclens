import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writeGraphFactsWithKuzuAppendCopy, writeGraphFactsWithKuzuBulk, writeGraphFactsWithKuzuBulkUpsert } from "../src/graph/bulkWriter.js";
import { KuzuGraphDB } from "../src/graph/db.js";
import { buildGraphFactsBatch } from "../src/graph/facts.js";
import { writeGraphFactsWithMerge } from "../src/graph/upsert.js";
import { listCode, listContracts, listDependencies, traceContract, traceEntity } from "../src/graph/queries.js";
import { rebuildRepoDependencies } from "../src/graph/rebuildRelations.js";
import { parseSourceFile } from "../src/parsers/parserRegistry.js";
import type { ParsedGraphFile, RepoNode } from "../src/parsers/types.js";
import { repoId } from "../src/shared/path.js";

describe("kuzu bulk graph writer", () => {
  function fixtureRepo(name: string): RepoNode {
    return { id: repoId(name), name, path: path.resolve("tests/fixtures", name), remoteUrl: "", branch: "", commitSha: "", language: "typescript", indexedAt: "now" };
  }

  async function parseFixtureFiles(repoA: RepoNode, repoB: RepoNode): Promise<ParsedGraphFile[]> {
    return Promise.all([
      parseSourceFile({ repoId: repoA.id, absolutePath: path.resolve("tests/fixtures/service-a/src/OrderController.ts"), relativePath: "src/OrderController.ts", language: "typescript" }),
      parseSourceFile({ repoId: repoB.id, absolutePath: path.resolve("tests/fixtures/service-b/src/PaymentService.ts"), relativePath: "src/PaymentService.ts", language: "typescript" })
    ]);
  }

  async function captureGraphView(db: KuzuGraphDB) {
    const stats = await db.stats();
    const activeRelationCounts = {
      contains: Number((await db.query<{ count: number }>("MATCH ()-[r:CONTAINS]->() RETURN count(r) AS count;"))[0]?.count ?? 0),
      imports: Number((await db.query<{ count: number }>("MATCH ()-[r:IMPORTS]->() WHERE r.active IS NULL OR r.active = true RETURN count(r) AS count;"))[0]?.count ?? 0),
      calls: Number((await db.query<{ count: number }>("MATCH ()-[r:CALLS]->() WHERE r.active IS NULL OR r.active = true RETURN count(r) AS count;"))[0]?.count ?? 0)
    };
    const semanticLayer = {
      contractSpecs: Number((await db.query<{ count: number }>("MATCH (s:ContractSpec) RETURN count(s) AS count;"))[0]?.count ?? 0),
      hasSpec: Number((await db.query<{ count: number }>("MATCH (:Contract)-[r:HAS_SPEC]->(:ContractSpec) RETURN count(r) AS count;"))[0]?.count ?? 0),
      semanticRel: Number((await db.query<{ count: number }>("MATCH (:ContractSpec)-[r:SEMANTIC_REL]->(:ContractSpec) RETURN count(r) AS count;"))[0]?.count ?? 0)
    };
    return {
      stats,
      activeRelationCounts,
      semanticLayer,
      code: (await listCode(db, 1000)).map((row) => `${row.repoName}:${row.filePath}:${row.kind}:${row.qualifiedName}:${row.signature}`).sort(),
      contracts: (await listContracts(db, { limit: 1000 })).map((row) => `${row.kind}:${row.key}:${row.producers}:${row.consumers}:${row.shared}`).sort(),
      dependencies: (await listDependencies(db, { limit: 1000 })).map((row) => `${row.fromRepo}->${row.toRepo}:${row.dependencyType}:${row.contractKind}:${row.contractKey}:${row.filePath}:${row.line}:${row.rule}`).sort(),
      traceContract: (await traceContract(db, "api", "/api/order/:id")).map((row) => `${row.repoName}:${row.role}:${row.filePath}:${row.line}:${row.rule}`).sort(),
      traceEntity: (await traceEntity(db, "Order")).map((row) => `${row.repoName}:${row.sourceKind}:${row.name}:${row.filePath}:${row.line}:${row.role}`).sort()
    };
  }

  async function withDb<T>(prefix: string, fn: (db: KuzuGraphDB, dir: string) => Promise<T>): Promise<T> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    const db = await KuzuGraphDB.open(path.join(dir, "graph"));
    try {
      await db.initSchema("bulk-equivalence-test");
      return await fn(db, dir);
    } finally {
      await db.close();
    }
  }

  it("produces equivalent public graph views across writer modes for the same facts", async () => {
    const repoA = fixtureRepo("service-a");
    const repoB = fixtureRepo("service-b");
    const parsed = await parseFixtureFiles(repoA, repoB);
    const repos = [repoA, repoB];
    const facts = await buildGraphFactsBatch({ batchId: "batch:equivalence", indexedAt: "indexed", repos, parsedFiles: parsed, semantic: true });

    const merge = await withDb("logiclens-writer-merge-", async (db) => {
      for (const repo of repos) await db.upsertRepo(repo);
      await writeGraphFactsWithMerge(db, facts);
      await rebuildRepoDependencies(db, { batchId: "batch:deps" });
      return captureGraphView(db);
    });
    const bulkCopy = await withDb("logiclens-writer-bulk-", async (db, dir) => {
      await writeGraphFactsWithKuzuBulk(db, facts, { stagingRoot: path.join(dir, "staging") });
      await rebuildRepoDependencies(db, { batchId: "batch:deps" });
      return captureGraphView(db);
    });
    const appendCopy = await withDb("logiclens-writer-append-", async (db, dir) => {
      await writeGraphFactsWithKuzuAppendCopy(db, facts, { stagingRoot: path.join(dir, "staging") });
      await rebuildRepoDependencies(db, { batchId: "batch:deps" });
      return captureGraphView(db);
    });
    const bulkUpsert = await withDb("logiclens-writer-upsert-", async (db, dir) => {
      await writeGraphFactsWithKuzuBulkUpsert(db, facts, { stagingRoot: path.join(dir, "staging") });
      await rebuildRepoDependencies(db, { batchId: "batch:deps" });
      return captureGraphView(db);
    });

    // Guard: the cross-mode equality below only proves something about the
    // semantic layer if the fixture actually produced one. Without this, every
    // mode emitting zero ContractSpec/HAS_SPEC/SEMANTIC_REL would pass vacuously.
    expect(merge.semanticLayer.contractSpecs).toBeGreaterThan(0);
    expect(merge.semanticLayer.hasSpec).toBeGreaterThan(0);
    expect(merge.semanticLayer.semanticRel).toBeGreaterThan(0);

    expect(bulkCopy).toEqual(merge);
    expect(appendCopy).toEqual(merge);
    expect(bulkUpsert).toEqual(merge);
  }, 30000);

  it("imports a fixture graph into an empty database using csv copy", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-bulk-writer-"));
    const db = await KuzuGraphDB.open(path.join(dir, "graph"));
    try {
      await db.initSchema("bulk-test");
      const repoA = { id: repoId("service-a"), name: "service-a", path: path.resolve("tests/fixtures/service-a"), remoteUrl: "", branch: "", commitSha: "", language: "typescript", indexedAt: "now" };
      const repoB = { id: repoId("service-b"), name: "service-b", path: path.resolve("tests/fixtures/service-b"), remoteUrl: "", branch: "", commitSha: "", language: "typescript", indexedAt: "now" };
      const parsed = await Promise.all([
        parseSourceFile({ repoId: repoA.id, absolutePath: path.resolve("tests/fixtures/service-a/src/OrderController.ts"), relativePath: "src/OrderController.ts", language: "typescript" }),
        parseSourceFile({ repoId: repoB.id, absolutePath: path.resolve("tests/fixtures/service-b/src/PaymentService.ts"), relativePath: "src/PaymentService.ts", language: "typescript" })
      ]);
      const facts = await buildGraphFactsBatch({ batchId: "batch:bulk", indexedAt: "indexed", repos: [repoA, repoB], parsedFiles: parsed, semantic: true });
      const result = await writeGraphFactsWithKuzuBulk(db, facts, { stagingRoot: path.join(dir, "staging") });

      expect(result.copiedTables).toEqual(expect.arrayContaining(["Repo", "File", "Code", "Evidence", "DEPENDS_ON"]));
      const stats = await db.stats();
      expect(stats.repos).toBe(2);
      expect(stats.files).toBe(2);
      expect(stats.codeNodes).toBeGreaterThan(0);
      expect(await traceContract(db, "api", "/api/order/:id")).toEqual(expect.arrayContaining([
        expect.objectContaining({ repoName: "service-a", role: "producer" }),
        expect.objectContaining({ repoName: "service-b", role: "consumer" })
      ]));
      expect(await listDependencies(db)).toEqual(expect.arrayContaining([
        expect.objectContaining({ fromRepo: "service-b", toRepo: "service-a", dependencyType: "api" })
      ]));
      expect(await traceEntity(db, "Order")).toEqual(expect.arrayContaining([
        expect.objectContaining({ repoName: "service-a" }),
        expect.objectContaining({ repoName: "service-b" })
      ]));
    } finally {
      await db.close();
    }
  }, 20000);

  it("upserts a fixture graph without duplicating nodes or relations", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-bulk-upsert-writer-"));
    const db = await KuzuGraphDB.open(path.join(dir, "graph"));
    try {
      await db.initSchema("bulk-upsert-test");
      const repoA = { id: repoId("service-a"), name: "service-a", path: path.resolve("tests/fixtures/service-a"), remoteUrl: "", branch: "", commitSha: "", language: "typescript", indexedAt: "now" };
      const repoB = { id: repoId("service-b"), name: "service-b", path: path.resolve("tests/fixtures/service-b"), remoteUrl: "", branch: "", commitSha: "", language: "typescript", indexedAt: "now" };
      const parsed = await Promise.all([
        parseSourceFile({ repoId: repoA.id, absolutePath: path.resolve("tests/fixtures/service-a/src/OrderController.ts"), relativePath: "src/OrderController.ts", language: "typescript" }),
        parseSourceFile({ repoId: repoB.id, absolutePath: path.resolve("tests/fixtures/service-b/src/PaymentService.ts"), relativePath: "src/PaymentService.ts", language: "typescript" })
      ]);
      const facts = await buildGraphFactsBatch({ batchId: "batch:bulk-upsert", indexedAt: "indexed", repos: [repoA, repoB], parsedFiles: parsed, semantic: true });

      await writeGraphFactsWithKuzuBulkUpsert(db, facts, { stagingRoot: path.join(dir, "staging") });
      await writeGraphFactsWithKuzuBulkUpsert(db, facts, { stagingRoot: path.join(dir, "staging") });

      const stats = await db.stats();
      expect(stats.repos).toBe(2);
      expect(stats.files).toBe(2);
      expect(stats.codeNodes).toBeGreaterThan(0);
      const duplicateCheck = await db.query<{ count: number }>("MATCH (:Repo)-[r:CONSUMES]->(:Contract) RETURN count(r) AS count;");
      expect(Number(duplicateCheck[0]?.count ?? 0)).toBe(facts.repoContracts.filter((edge) => edge.role === "consumer").length);
      expect(await traceContract(db, "api", "/api/order/:id")).toEqual(expect.arrayContaining([
        expect.objectContaining({ repoName: "service-a", role: "producer" }),
        expect.objectContaining({ repoName: "service-b", role: "consumer" })
      ]));
      expect(await traceEntity(db, "Order")).toEqual(expect.arrayContaining([
        expect.objectContaining({ repoName: "service-a" }),
        expect.objectContaining({ repoName: "service-b" })
      ]));
    } finally {
      await db.close();
    }
  }, 20000);

  it("appends a new repository to an existing graph using copy for relations", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-bulk-append-writer-"));
    const db = await KuzuGraphDB.open(path.join(dir, "graph"));
    try {
      await db.initSchema("bulk-append-test");
      const repoA = { id: repoId("service-a"), name: "service-a", path: path.resolve("tests/fixtures/service-a"), remoteUrl: "", branch: "", commitSha: "", language: "typescript", indexedAt: "now" };
      const repoB = { id: repoId("service-b"), name: "service-b", path: path.resolve("tests/fixtures/service-b"), remoteUrl: "", branch: "", commitSha: "", language: "typescript", indexedAt: "now" };
      const parsedA = await Promise.all([
        parseSourceFile({ repoId: repoA.id, absolutePath: path.resolve("tests/fixtures/service-a/src/OrderController.ts"), relativePath: "src/OrderController.ts", language: "typescript" })
      ]);
      const parsedB = await Promise.all([
        parseSourceFile({ repoId: repoB.id, absolutePath: path.resolve("tests/fixtures/service-b/src/PaymentService.ts"), relativePath: "src/PaymentService.ts", language: "typescript" })
      ]);
      const factsA = await buildGraphFactsBatch({ batchId: "batch:bulk-append-a", indexedAt: "indexed", repos: [repoA], parsedFiles: parsedA, semantic: true });
      const factsB = await buildGraphFactsBatch({ batchId: "batch:bulk-append-b", indexedAt: "indexed", repos: [repoB], parsedFiles: parsedB, semantic: true });

      await writeGraphFactsWithKuzuBulk(db, factsA, { stagingRoot: path.join(dir, "staging") });
      const result = await writeGraphFactsWithKuzuAppendCopy(db, factsB, { stagingRoot: path.join(dir, "staging") });

      expect(result.upsertedNodeTables).toEqual(expect.arrayContaining(["Repo", "File", "Code", "Contract", "Evidence"]));
      expect(result.copiedRelationTables).toEqual(expect.arrayContaining(["CONSUMES", "HAS_EVIDENCE"]));
      const stats = await db.stats();
      expect(stats.repos).toBe(2);
      expect(stats.files).toBe(2);
      expect(await traceContract(db, "api", "/api/order/:id")).toEqual(expect.arrayContaining([
        expect.objectContaining({ repoName: "service-a", role: "producer" }),
        expect.objectContaining({ repoName: "service-b", role: "consumer" })
      ]));
      await rebuildRepoDependencies(db);
      expect(await listDependencies(db)).toEqual(expect.arrayContaining([
        expect.objectContaining({ fromRepo: "service-b", toRepo: "service-a", dependencyType: "api" })
      ]));
    } finally {
      await db.close();
    }
  }, 20000);
});
