import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runIndexing } from "../src/core/indexing/run.js";
import { defaultConfig } from "../src/config/loadConfig.js";
import type { LogicLensConfig } from "../src/config/schema.js";
import { KuzuGraphDB } from "../src/core/graph-model/db.js";
import { listContracts, listDependencies } from "../src/core/graph-model/queries.js";
import { embeddingProviderRegistry } from "../src/core/registries/registry.js";

function fixturePath(name: string): string {
  return path.resolve("tests/fixtures", name).replace(/\\/g, "/");
}

function configFor(repos: string[], batchSize = 0): LogicLensConfig {
  const base = defaultConfig();
  return {
    ...base,
    repos: repos.map((name) => ({ name, path: fixturePath(name) })),
    indexing: { ...base.indexing, batchSize }
  };
}

async function withDb<T>(fn: (db: KuzuGraphDB, cwd: string) => Promise<T>): Promise<T> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-batched-index-"));
  const db = await KuzuGraphDB.open(path.join(cwd, "graph"));
  try {
    await db.initSchema("batched-index-test");
    return await fn(db, cwd);
  } finally {
    await db.close();
  }
}

async function dependencyKeys(db: KuzuGraphDB): Promise<string[]> {
  const rows = await listDependencies(db, { limit: 1000 });
  return rows.map((row) => `${row.fromRepo}->${row.toRepo}:${row.dependencyType}:${row.contractKind}:${row.contractKey}:${row.filePath}:${row.line}:${row.rule}`).sort();
}

async function contractKeys(db: KuzuGraphDB): Promise<string[]> {
  const rows = await listContracts(db, { limit: 1000 });
  return rows.map((row) => `${row.kind}:${row.key}:${row.producers}:${row.consumers}:${row.shared}`).sort();
}

describe("batched indexing", () => {
  it("matches full bulk indexing for fixture repos when batchSize is set", async () => {
    const repos = ["service-a", "service-b", "service-c", "service-d"];
    const bulk = await withDb(async (db, cwd) => {
      await runIndexing(db, configFor(repos), { cwd, writeMode: "auto" });
      return {
        stats: await db.stats(),
        dependencies: await dependencyKeys(db),
        contracts: await contractKeys(db)
      };
    });

    const batched = await withDb(async (db, cwd) => {
      const logs: string[] = [];
      await runIndexing(db, configFor(repos, 2), { cwd, writeMode: "auto", batchSize: 2, logger: { log: (message) => logs.push(message) } });
      expect(logs.some((message) => message.includes("Batched indexing: batches=2 batchSize=2"))).toBe(true);
      return {
        stats: await db.stats(),
        dependencies: await dependencyKeys(db),
        contracts: await contractKeys(db)
      };
    });

    expect({
      repos: batched.stats.repos,
      files: batched.stats.files,
      codeNodes: batched.stats.codeNodes,
      sectionNodes: batched.stats.sectionNodes,
      entities: batched.stats.entities
    }).toEqual({
      repos: bulk.stats.repos,
      files: bulk.stats.files,
      codeNodes: bulk.stats.codeNodes,
      sectionNodes: bulk.stats.sectionNodes,
      entities: bulk.stats.entities
    });
    expect(batched.dependencies).toEqual(bulk.dependencies);
    expect(batched.contracts).toEqual(bulk.contracts);
  }, 30000);

  it("can rerun after a partial batched import without duplicating repo containment", async () => {
    await withDb(async (db, cwd) => {
      await runIndexing(db, configFor(["service-a"], 1), { cwd, writeMode: "auto", batchSize: 1 });
      await runIndexing(db, configFor(["service-a", "service-b"], 1), { cwd, writeMode: "auto", batchSize: 1 });

      const stats = await db.stats();
      expect(stats.repos).toBe(2);
      expect(stats.files).toBeGreaterThan(0);

      const systemContains = await db.query<{ count: number }>("MATCH (:System)-[r:CONTAINS]->(:Repo) RETURN count(r) AS count;");
      expect(Number(systemContains[0]?.count ?? 0)).toBe(2);
      expect(await dependencyKeys(db)).toEqual(expect.arrayContaining([
        expect.stringContaining("service-b->service-a:api:")
      ]));
    });
  }, 30000);

  it("records semantic index fallback warnings in index state", async () => {
    await withDb(async (db, cwd) => {
      embeddingProviderRegistry.register({
        name: "test-fallback",
        async embedTexts(texts) { return texts.map(() => undefined); },
        async embedText() { return undefined; }
      });

      const config = configFor(["service-a"]);
      config.embedding = { ...config.embedding, provider: "test-fallback", level: "file" };
      config.semantic = {
        ...config.semantic,
        provider: "chroma",
        chroma: { ...config.semantic.chroma, url: "http://127.0.0.1:1" }
      };

      await runIndexing(db, config, { cwd, writeMode: "merge" });

      const rows = await db.query<{ status: string; error: string }>(
        "MATCH (s:IndexState) WHERE s.repoName = $repoName RETURN s.status AS status, s.error AS error;",
        { repoName: "service-a" }
      );
      expect(rows[0]?.status).toBe("succeeded");
      expect(rows[0]?.error).toContain("Semantic index used fallback storage");
      expect(rows[0]?.error).toContain("records:");
    });
  }, 30000);
});
