import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writeGraphFactsWithKuzuAppendCopy, writeGraphFactsWithKuzuBulk, writeGraphFactsWithKuzuBulkUpsert } from "../src/core/graph-model/bulkWriter.js";
import { KuzuGraphDB } from "../src/core/graph-model/db.js";
import { buildGraphFactsBatch } from "../src/core/graph-model/facts.js";
import { writeGraphFactsWithMerge } from "../src/core/graph-model/upsert.js";
import { listCode, listContracts, listDependencies, traceContract, traceEntity } from "../src/core/graph-model/queries.js";
import { rebuildRepoDependencies } from "../src/core/graph-model/rebuildRelations.js";
import { parseSourceFile } from "../src/core/parsing/parserRegistry.js";
import type { ParsedGraphFile, RepoNode } from "../src/core/parsing/types.js";
import { repoId } from "../src/shared/path.js";
import type { PublicGraphReadSnapshot } from "../src/core/graph-model/readSnapshot.js";
import { stageAndActivatePublicGraphGeneration } from "./helpers/publicGraphGeneration.js";

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

  async function captureGraphView(db: KuzuGraphDB, snapshot: PublicGraphReadSnapshot) {
    const stats = await db.stats(snapshot);
    const scope = { workspaceId: snapshot.workspaceId, generation: snapshot.generation };
    const activeRelationCounts = {
      contains: Number((await db.query<{ count: number }>("MATCH ()-[r:CONTAINS]->() WHERE r.workspaceId = $workspaceId AND r.generation = $generation RETURN count(r) AS count;", scope))[0]?.count ?? 0),
      imports: Number((await db.query<{ count: number }>("MATCH ()-[r:IMPORTS]->() WHERE r.workspaceId = $workspaceId AND r.generation = $generation AND (r.active IS NULL OR r.active = true) RETURN count(r) AS count;", scope))[0]?.count ?? 0),
      calls: Number((await db.query<{ count: number }>("MATCH ()-[r:CALLS]->() WHERE r.workspaceId = $workspaceId AND r.generation = $generation AND (r.active IS NULL OR r.active = true) RETURN count(r) AS count;", scope))[0]?.count ?? 0)
    };
    const semanticLayer = {
      contractSpecs: Number((await db.query<{ count: number }>("MATCH (s:ContractSpec) WHERE s.workspaceId = $workspaceId AND s.generation = $generation AND (s.active IS NULL OR s.active = true) RETURN count(s) AS count;", scope))[0]?.count ?? 0),
      hasSpec: Number((await db.query<{ count: number }>("MATCH (c:Contract)-[r:HAS_SPEC]->(s:ContractSpec) WHERE c.workspaceId = $workspaceId AND c.generation = $generation AND r.workspaceId = $workspaceId AND r.generation = $generation AND s.workspaceId = $workspaceId AND s.generation = $generation AND (r.active IS NULL OR r.active = true) AND (s.active IS NULL OR s.active = true) RETURN count(r) AS count;", scope))[0]?.count ?? 0),
      semanticRel: Number((await db.query<{ count: number }>("MATCH (a:ContractSpec)-[r:SEMANTIC_REL]->(b:ContractSpec) WHERE a.workspaceId = $workspaceId AND a.generation = $generation AND r.workspaceId = $workspaceId AND r.generation = $generation AND b.workspaceId = $workspaceId AND b.generation = $generation AND (a.active IS NULL OR a.active = true) AND (r.active IS NULL OR r.active = true) AND (b.active IS NULL OR b.active = true) RETURN count(r) AS count;", scope))[0]?.count ?? 0)
    };
    return {
      stats,
      activeRelationCounts,
      semanticLayer,
      code: (await listCode(db, snapshot, 1000)).map((row) => `${row.repoName}:${row.filePath}:${row.kind}:${row.qualifiedName}:${row.signature}`).sort(),
      contracts: (await listContracts(db, snapshot, { limit: 1000 })).map((row) => `${row.kind}:${row.key}:${row.producers}:${row.consumers}:${row.shared}`).sort(),
      dependencies: (await listDependencies(db, snapshot, { limit: 1000 })).map((row) => `${row.fromRepo}->${row.toRepo}:${row.dependencyType}:${row.contractKind}:${row.contractKey}:${row.filePath}:${row.line}:${row.rule}`).sort(),
      traceContract: (await traceContract(db, snapshot, "api", "/api/order/:id")).map((row) => `${row.repoName}:${row.role}:${row.filePath}:${row.line}:${row.rule}`).sort(),
      traceEntity: (await traceEntity(db, snapshot, "Order")).map((row) => `${row.repoName}:${row.sourceKind}:${row.name}:${row.filePath}:${row.line}:${row.role}`).sort()
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
    const scope = { workspaceId: "workspace:bulk-equivalence", generation: "generation:bulk-equivalence" };
    const facts = await buildGraphFactsBatch({
      batchId: "batch:equivalence",
      workspaceId: scope.workspaceId,
      generation: scope.generation,
      systemName: "bulk-equivalence-test",
      indexedAt: "indexed",
      repos,
      parsedFiles: parsed,
      semantic: true
    });

    const merge = await withDb("test-writer-merge-", async (db) => {
      const { snapshot } = await stageAndActivatePublicGraphGeneration(db, scope, async (writeScope) => {
        for (const repo of repos) await db.upsertRepo(repo, writeScope);
        await writeGraphFactsWithMerge(db, facts);
        await rebuildRepoDependencies(db, { scope: writeScope, batchId: "batch:deps" });
      });
      return captureGraphView(db, snapshot);
    });
    const bulkCopy = await withDb("test-writer-bulk-", async (db, dir) => {
      const { snapshot } = await stageAndActivatePublicGraphGeneration(db, scope, async (writeScope) => {
        await writeGraphFactsWithKuzuBulk(db, facts, { stagingRoot: path.join(dir, "staging") });
        await rebuildRepoDependencies(db, { scope: writeScope, batchId: "batch:deps" });
      });
      return captureGraphView(db, snapshot);
    });
    const appendCopy = await withDb("test-writer-append-", async (db, dir) => {
      const { snapshot } = await stageAndActivatePublicGraphGeneration(db, scope, async (writeScope) => {
        await writeGraphFactsWithKuzuAppendCopy(db, facts, { stagingRoot: path.join(dir, "staging") });
        await rebuildRepoDependencies(db, { scope: writeScope, batchId: "batch:deps" });
      });
      return captureGraphView(db, snapshot);
    });
    const bulkUpsert = await withDb("test-writer-upsert-", async (db, dir) => {
      const { snapshot } = await stageAndActivatePublicGraphGeneration(db, scope, async (writeScope) => {
        await writeGraphFactsWithKuzuBulkUpsert(db, facts, { stagingRoot: path.join(dir, "staging") });
        await rebuildRepoDependencies(db, { scope: writeScope, batchId: "batch:deps" });
      });
      return captureGraphView(db, snapshot);
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
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "test-bulk-writer-"));
    const db = await KuzuGraphDB.open(path.join(dir, "graph"));
    try {
      await db.initSchema("bulk-test");
      const repoA = { id: repoId("service-a"), name: "service-a", path: path.resolve("tests/fixtures/service-a"), remoteUrl: "", branch: "", commitSha: "", language: "typescript", indexedAt: "now" };
      const repoB = { id: repoId("service-b"), name: "service-b", path: path.resolve("tests/fixtures/service-b"), remoteUrl: "", branch: "", commitSha: "", language: "typescript", indexedAt: "now" };
      const parsed = await Promise.all([
        parseSourceFile({ repoId: repoA.id, absolutePath: path.resolve("tests/fixtures/service-a/src/OrderController.ts"), relativePath: "src/OrderController.ts", language: "typescript" }),
        parseSourceFile({ repoId: repoB.id, absolutePath: path.resolve("tests/fixtures/service-b/src/PaymentService.ts"), relativePath: "src/PaymentService.ts", language: "typescript" })
      ]);
      const scope = { workspaceId: "workspace:bulk-copy", generation: "generation:bulk-copy" };
      const facts = await buildGraphFactsBatch({ batchId: "batch:bulk", workspaceId: scope.workspaceId, generation: scope.generation, systemName: "bulk-test", indexedAt: "indexed", repos: [repoA, repoB], parsedFiles: parsed, semantic: true });
      const { result, snapshot } = await stageAndActivatePublicGraphGeneration(db, scope, async () =>
        writeGraphFactsWithKuzuBulk(db, facts, { stagingRoot: path.join(dir, "staging") })
      );

      expect(result.copiedTables).toEqual(expect.arrayContaining(["Repo", "File", "Code", "Evidence", "DEPENDS_ON"]));
      const stats = await db.stats(snapshot);
      expect(stats.repos).toBe(2);
      expect(stats.files).toBe(2);
      expect(stats.codeNodes).toBeGreaterThan(0);
      expect(await traceContract(db, snapshot, "api", "/api/order/:id")).toEqual(expect.arrayContaining([
        expect.objectContaining({ repoName: "service-a", role: "producer" }),
        expect.objectContaining({ repoName: "service-b", role: "consumer" })
      ]));
      expect(await listDependencies(db, snapshot)).toEqual(expect.arrayContaining([
        expect.objectContaining({ fromRepo: "service-b", toRepo: "service-a", dependencyType: "api" })
      ]));
      expect(await traceEntity(db, snapshot, "Order")).toEqual(expect.arrayContaining([
        expect.objectContaining({ repoName: "service-a" }),
        expect.objectContaining({ repoName: "service-b" })
      ]));
    } finally {
      await db.close();
    }
  }, 20000);

  it("upserts a fixture graph without duplicating nodes or relations", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "test-bulk-upsert-writer-"));
    const db = await KuzuGraphDB.open(path.join(dir, "graph"));
    try {
      await db.initSchema("bulk-upsert-test");
      const repoA = { id: repoId("service-a"), name: "service-a", path: path.resolve("tests/fixtures/service-a"), remoteUrl: "", branch: "", commitSha: "", language: "typescript", indexedAt: "now" };
      const repoB = { id: repoId("service-b"), name: "service-b", path: path.resolve("tests/fixtures/service-b"), remoteUrl: "", branch: "", commitSha: "", language: "typescript", indexedAt: "now" };
      const parsed = await Promise.all([
        parseSourceFile({ repoId: repoA.id, absolutePath: path.resolve("tests/fixtures/service-a/src/OrderController.ts"), relativePath: "src/OrderController.ts", language: "typescript" }),
        parseSourceFile({ repoId: repoB.id, absolutePath: path.resolve("tests/fixtures/service-b/src/PaymentService.ts"), relativePath: "src/PaymentService.ts", language: "typescript" })
      ]);
      const scope = { workspaceId: "workspace:bulk-upsert", generation: "generation:bulk-upsert" };
      const facts = await buildGraphFactsBatch({ batchId: "batch:bulk-upsert", workspaceId: scope.workspaceId, generation: scope.generation, systemName: "bulk-upsert-test", indexedAt: "indexed", repos: [repoA, repoB], parsedFiles: parsed, semantic: true });

      const { snapshot } = await stageAndActivatePublicGraphGeneration(db, scope, async () => {
        await writeGraphFactsWithKuzuBulkUpsert(db, facts, { stagingRoot: path.join(dir, "staging") });
        await writeGraphFactsWithKuzuBulkUpsert(db, facts, { stagingRoot: path.join(dir, "staging") });
      });

      const stats = await db.stats(snapshot);
      expect(stats.repos).toBe(2);
      expect(stats.files).toBe(2);
      expect(stats.codeNodes).toBeGreaterThan(0);
      const duplicateCheck = await db.query<{ count: number }>("MATCH (a:Repo)-[r:CONSUMES]->(b:Contract) WHERE a.workspaceId = $workspaceId AND a.generation = $generation AND r.workspaceId = $workspaceId AND r.generation = $generation AND b.workspaceId = $workspaceId AND b.generation = $generation RETURN count(r) AS count;", { workspaceId: snapshot.workspaceId, generation: snapshot.generation });
      expect(Number(duplicateCheck[0]?.count ?? 0)).toBe(facts.repoContracts.filter((edge) => edge.role === "consumer").length);
      expect(await traceContract(db, snapshot, "api", "/api/order/:id")).toEqual(expect.arrayContaining([
        expect.objectContaining({ repoName: "service-a", role: "producer" }),
        expect.objectContaining({ repoName: "service-b", role: "consumer" })
      ]));
      expect(await traceEntity(db, snapshot, "Order")).toEqual(expect.arrayContaining([
        expect.objectContaining({ repoName: "service-a" }),
        expect.objectContaining({ repoName: "service-b" })
      ]));
    } finally {
      await db.close();
    }
  }, 20000);

  it("preserves ContractSpecs outside a partial bulk-upsert batch in the same generation", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "test-bulk-upsert-partial-specs-"));
    const db = await KuzuGraphDB.open(path.join(dir, "graph"));
    try {
      await db.initSchema("bulk-upsert-partial-specs-test");
      const scope = {
        workspaceId: "workspace:bulk-upsert-partial-specs",
        generation: "generation:bulk-upsert-partial-specs"
      };
      const initial = await buildGraphFactsBatch({
        batchId: "batch:initial",
        workspaceId: scope.workspaceId,
        generation: scope.generation,
        systemName: "bulk-upsert-partial-specs-test",
        indexedAt: "indexed:initial",
        repos: [],
        parsedFiles: [],
        semantic: true
      });
      initial.contracts = ["a", "b", "c"].map((suffix) => ({
        id: `contract:${suffix}`,
        kind: "schema",
        key: suffix,
        name: suffix.toUpperCase(),
        description: `Schema ${suffix.toUpperCase()}`
      }));
      initial.contractSpecs = ["a", "b", "c"].map((suffix) => ({
        id: `spec:${suffix}`,
        contractId: `contract:${suffix}`,
        specKind: "schema",
        repoId: "repo:partial-specs",
        fileId: `file:${suffix}`,
        evidenceId: `evidence:${suffix}`,
        canonicalKey: suffix,
        specJson: JSON.stringify({ kind: "schema", name: suffix.toUpperCase(), revision: 1 }),
        confidence: 1,
        batchId: initial.batchId,
        indexedAt: initial.indexedAt,
        active: true
      }));
      initial.contractSpecEdges = ["a", "b", "c"].map((suffix) => ({
        contractId: `contract:${suffix}`,
        specId: `spec:${suffix}`,
        evidenceId: `evidence:${suffix}`,
        confidence: 1,
        batchId: initial.batchId,
        active: true
      }));
      initial.semanticRelations = [{
        fromSpecId: "spec:b",
        toSpecId: "spec:c",
        kind: "USES_SCHEMA",
        evidenceId: "evidence:b-c",
        reason: "B uses C",
        confidence: 1,
        batchId: initial.batchId,
        active: true
      }];

      const partial = {
        ...initial,
        batchId: "batch:partial",
        indexedAt: "indexed:partial",
        contracts: initial.contracts.filter((contract) => contract.id === "contract:a"),
        contractSpecs: initial.contractSpecs
          .filter((spec) => spec.id === "spec:a")
          .map((spec) => ({
            ...spec,
            specJson: JSON.stringify({ kind: "schema", name: "A", revision: 2 }),
            batchId: "batch:partial",
            indexedAt: "indexed:partial"
          })),
        contractSpecEdges: initial.contractSpecEdges
          .filter((edge) => edge.specId === "spec:a")
          .map((edge) => ({ ...edge, batchId: "batch:partial" })),
        semanticRelations: []
      };

      const { snapshot } = await stageAndActivatePublicGraphGeneration(db, scope, async () => {
        await writeGraphFactsWithKuzuBulkUpsert(db, initial, { stagingRoot: path.join(dir, "staging") });
        await writeGraphFactsWithKuzuBulkUpsert(db, partial, { stagingRoot: path.join(dir, "staging") });
      });

      const specs = await db.query<{ id: string; specJson: string; batchId: string; active: boolean }>(
        "MATCH (s:ContractSpec) WHERE s.workspaceId = $workspaceId AND s.generation = $generation RETURN s.id AS id, s.specJson AS specJson, s.batchId AS batchId, s.active AS active ORDER BY s.id;",
        { workspaceId: snapshot.workspaceId, generation: snapshot.generation }
      );
      expect(specs).toEqual([
        expect.objectContaining({ id: "spec:a", specJson: JSON.stringify({ kind: "schema", name: "A", revision: 2 }), batchId: "batch:partial", active: true }),
        expect.objectContaining({ id: "spec:b", specJson: JSON.stringify({ kind: "schema", name: "B", revision: 1 }), batchId: "batch:initial", active: true }),
        expect.objectContaining({ id: "spec:c", specJson: JSON.stringify({ kind: "schema", name: "C", revision: 1 }), batchId: "batch:initial", active: true })
      ]);
      expect(await db.query(
        "MATCH (c:Contract)-[r:HAS_SPEC]->(s:ContractSpec) WHERE c.workspaceId = $workspaceId AND c.generation = $generation AND r.workspaceId = $workspaceId AND r.generation = $generation AND s.workspaceId = $workspaceId AND s.generation = $generation AND s.id IN ['spec:b', 'spec:c'] RETURN s.id AS specId, r.batchId AS batchId, r.active AS active ORDER BY specId;",
        { workspaceId: snapshot.workspaceId, generation: snapshot.generation }
      )).toEqual([
        expect.objectContaining({ specId: "spec:b", batchId: "batch:initial", active: true }),
        expect.objectContaining({ specId: "spec:c", batchId: "batch:initial", active: true })
      ]);
      expect(await db.query(
        "MATCH (a:ContractSpec)-[r:SEMANTIC_REL]->(b:ContractSpec) WHERE a.workspaceId = $workspaceId AND a.generation = $generation AND r.workspaceId = $workspaceId AND r.generation = $generation AND b.workspaceId = $workspaceId AND b.generation = $generation RETURN a.id AS fromSpecId, b.id AS toSpecId, r.kind AS kind, r.batchId AS batchId, r.active AS active;",
        { workspaceId: snapshot.workspaceId, generation: snapshot.generation }
      )).toEqual([
        expect.objectContaining({ fromSpecId: "spec:b", toSpecId: "spec:c", kind: "USES_SCHEMA", batchId: "batch:initial", active: true })
      ]);
    } finally {
      await db.close();
    }
  }, 20000);

  it("appends a new repository to an existing graph using copy for relations", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "test-bulk-append-writer-"));
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
      const scope = { workspaceId: "workspace:bulk-append", generation: "generation:bulk-append" };
      const factsA = await buildGraphFactsBatch({ batchId: "batch:bulk-append-a", workspaceId: scope.workspaceId, generation: scope.generation, systemName: "bulk-append-test", indexedAt: "indexed", repos: [repoA], parsedFiles: parsedA, semantic: true });
      const factsB = await buildGraphFactsBatch({ batchId: "batch:bulk-append-b", workspaceId: scope.workspaceId, generation: scope.generation, systemName: "bulk-append-test", indexedAt: "indexed", repos: [repoB], parsedFiles: parsedB, semantic: true });

      const { result, snapshot } = await stageAndActivatePublicGraphGeneration(db, scope, async (writeScope) => {
        await writeGraphFactsWithKuzuBulk(db, factsA, { stagingRoot: path.join(dir, "staging") });
        const appendResult = await writeGraphFactsWithKuzuAppendCopy(db, factsB, { stagingRoot: path.join(dir, "staging") });
        await rebuildRepoDependencies(db, { scope: writeScope });
        return appendResult;
      });

      expect(result.upsertedNodeTables).toEqual(expect.arrayContaining(["Repo", "File", "Code", "Contract", "Evidence"]));
      expect(result.copiedRelationTables).toEqual(expect.arrayContaining(["CONSUMES", "HAS_EVIDENCE"]));
      const stats = await db.stats(snapshot);
      expect(stats.repos).toBe(2);
      expect(stats.files).toBe(2);
      expect(await traceContract(db, snapshot, "api", "/api/order/:id")).toEqual(expect.arrayContaining([
        expect.objectContaining({ repoName: "service-a", role: "producer" }),
        expect.objectContaining({ repoName: "service-b", role: "consumer" })
      ]));
      expect(await listDependencies(db, snapshot)).toEqual(expect.arrayContaining([
        expect.objectContaining({ fromRepo: "service-b", toRepo: "service-a", dependencyType: "api" })
      ]));
    } finally {
      await db.close();
    }
  }, 20000);
});
