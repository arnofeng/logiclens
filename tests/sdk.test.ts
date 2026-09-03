import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../src/config/loadConfig.js";
import type { GraphDB } from "../src/core/graph-model/db.js";
import { registerGraphProvider } from "../src/core/graph-model/factory.js";
import { SCHEMA_INDEX_VERSION } from "../src/core/schema/model.js";
import { AppClient, createClient } from "../src/interfaces/sdk/client.js";

function fakeDb(schemaVersion = SCHEMA_INDEX_VERSION) {
  const query = vi.fn(async (statement: string) => {
    if (statement.includes("SchemaGenerationState")) {
      return [{
        activeGeneration: "generation:sdk",
        activeRevision: "revision:sdk",
        schemaIndexVersion: schemaVersion
      }];
    }
    if (statement.includes("MATCH (r:Repo)")) return [];
    return [];
  });
  return {
    initSchema: vi.fn(),
    query,
    close: vi.fn(),
    listRepos: vi.fn(async () => []),
    stats: vi.fn(async () => ({ repos: 0, files: 0, codeNodes: 0, sectionNodes: 0, callEdges: 0, importEdges: 0, entities: 0 }))
  } as unknown as GraphDB & { initSchema: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
}

describe("SDK graph client", () => {
  it("does not expose ask, retrieve, lexical, or embedding APIs", async () => {
    const methods = Object.getOwnPropertyNames(AppClient.prototype);
    expect(methods).not.toEqual(expect.arrayContaining(["ask", "retrieve", "getLexicalProviderStatus", "ensureProviders"]));

    const publicEntry = await fs.readFile(path.resolve("src/index.ts"), "utf8");
    expect(publicEntry).not.toMatch(/AskOptions|RetrieveOptions|RetrievalResult|LexicalDocument|EmbeddingProvider/u);
  });

  it("retains graph configuration and returns a pure watch status", () => {
    const config = { ...defaultConfig(), systemName: "sdk-graph-only" };
    const client = new AppClient({ cwd: "C:/workspace" }, config);
    expect(client.getConfig()).toBe(config);
    expect(client.getCwd()).toBe("C:/workspace");
    expect(client.getWatchStatus()).toMatchObject({ active: false, pendingFiles: [], degraded: false });
    expect(client.getWatchStatus()).not.toHaveProperty("lexical");
  });

  it("opens a graph-only provider once for repeated graph queries", async () => {
    const db = fakeDb();
    const open = vi.fn(async () => db);
    registerGraphProvider("sdk-graph-only-provider", { factory: { open } });
    const config = {
      ...defaultConfig(),
      graph: { ...defaultConfig().graph, provider: "sdk-graph-only-provider" }
    };
    const client = await createClient({ cwd: "C:/workspace", config });

    await expect(client.listRepos()).resolves.toEqual([]);
    await expect(client.listRepos()).resolves.toEqual([]);
    expect(open).toHaveBeenCalledOnce();
    expect(db.initSchema).toHaveBeenCalledWith(config.systemName);
    await client.close();
    expect(db.close).toHaveBeenCalledOnce();
  });

  it("rejects a v9 Kuzu database with rebuild instructions", async () => {
    const db = fakeDb("9");
    registerGraphProvider("sdk-v9-kuzu", { factory: { open: async () => db } });
    const client = await createClient({
      cwd: "C:/workspace",
      config: {
        ...defaultConfig(),
        graph: { ...defaultConfig().graph, provider: "sdk-v9-kuzu", path: ".repohelix/graph" }
      }
    });

    await expect(client.listRepos()).rejects.toThrow(/Schema index version 9.*remove the configured Kuzu graph directory.*fresh RepoHelix Neo4j database/iu);
    expect(db.close).toHaveBeenCalledOnce();
  });
});
