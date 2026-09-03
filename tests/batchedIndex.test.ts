import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config/loadConfig.js";
import type { AppConfig } from "../src/config/schema.js";
import { KuzuGraphDB } from "../src/core/graph-model/db.js";
import { listContracts, listDependencies } from "../src/core/graph-model/queries.js";
import { pinPublicGraphReadSnapshot } from "../src/core/graph-model/readSnapshot.js";
import { runIndexing } from "../src/core/indexing/run.js";
import { deriveWorkspaceId } from "../src/core/workspace/identity.js";

const WORKSPACE_ID = deriveWorkspaceId(defaultConfig().systemName);

function fixturePath(name: string): string {
  return path.resolve("tests/fixtures", name).replace(/\\/g, "/");
}

function configFor(repos: string[], batchSize = 0): AppConfig {
  const base = defaultConfig();
  return {
    ...base,
    repos: repos.map((name) => ({ name, path: fixturePath(name) })),
    indexing: { ...base.indexing, batchSize }
  };
}

async function withDb<T>(fn: (db: KuzuGraphDB, cwd: string) => Promise<T>): Promise<T> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "test-batched-index-"));
  const db = await KuzuGraphDB.open(path.join(cwd, "graph"));
  try {
    await db.initSchema("batched-index-test");
    return await fn(db, cwd);
  } finally {
    await db.close();
  }
}

async function graphSnapshot(db: KuzuGraphDB) {
  const snapshot = await pinPublicGraphReadSnapshot(db, WORKSPACE_ID);
  const [stats, dependencies, contracts] = await Promise.all([
    db.stats(snapshot),
    listDependencies(db, snapshot, { limit: 1000 }),
    listContracts(db, snapshot, { limit: 1000 })
  ]);
  return {
    stats: {
      repos: stats.repos,
      files: stats.files,
      codeNodes: stats.codeNodes,
      sectionNodes: stats.sectionNodes,
      entities: stats.entities
    },
    dependencies: dependencies.map((row) => `${row.fromRepo}->${row.toRepo}:${row.dependencyType}:${row.contractKind}:${row.contractKey}:${row.filePath}:${row.line}:${row.rule}`).sort(),
    contracts: contracts.map((row) => `${row.kind}:${row.key}:${row.producers}:${row.consumers}:${row.shared}`).sort()
  };
}

describe("batched graph indexing", () => {
  it("converges to the same graph as bulk indexing", async () => {
    const repos = ["service-a", "service-b", "service-c", "service-d"];
    const bulk = await withDb(async (db, cwd) => {
      await runIndexing(db, configFor(repos), { cwd, writeMode: "auto" });
      return graphSnapshot(db);
    });
    const batched = await withDb(async (db, cwd) => {
      const logs: string[] = [];
      await runIndexing(db, configFor(repos, 2), {
        cwd,
        writeMode: "auto",
        batchSize: 2,
        logger: { log: (message) => logs.push(message) }
      });
      expect(logs.some((message) => message.includes("Batched indexing: batches=2 batchSize=2"))).toBe(true);
      expect(logs.some((message) => message.toLowerCase().includes("graph write start:"))).toBe(true);
      expect(logs.some((message) => message.toLowerCase().includes("graph write complete:"))).toBe(true);
      return graphSnapshot(db);
    });

    expect(batched).toEqual(bulk);
  }, 30000);

  it("reruns after a partial batched import without duplicating containment", async () => {
    await withDb(async (db, cwd) => {
      await runIndexing(db, configFor(["service-a"], 1), { cwd, writeMode: "auto", batchSize: 1 });
      await runIndexing(db, configFor(["service-a", "service-b"], 1), { cwd, writeMode: "auto", batchSize: 1 });

      const snapshot = await pinPublicGraphReadSnapshot(db, WORKSPACE_ID);
      const contains = await db.query<{ count: number }>(
        "MATCH (s:System)-[r:CONTAINS]->(repo:Repo) WHERE s.workspaceId = $workspaceId AND s.generation = $generation AND r.workspaceId = $workspaceId AND r.generation = $generation AND repo.workspaceId = $workspaceId AND repo.generation = $generation RETURN count(r) AS count;",
        snapshot
      );
      expect(Number(contains[0]?.count ?? 0)).toBe(2);
      expect((await graphSnapshot(db)).dependencies).toEqual(expect.arrayContaining([
        expect.stringContaining("service-b->service-a:api:")
      ]));
    });
  }, 30000);
});
