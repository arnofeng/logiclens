import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { KuzuGraphDB } from "../src/core/graph-model/db.js";
import { SCHEMA_INDEX_VERSION } from "../src/core/schema/model.js";
import { initCommand } from "../src/interfaces/cli/init.js";

describe("removed search surfaces", () => {
  it("keeps CLI, MCP, SDK, and package exports graph-only", async () => {
    const [cli, mcp, sdk, publicEntry, packageJson] = await Promise.all([
      fs.readFile(path.resolve("src/cli.ts"), "utf8"),
      fs.readFile(path.resolve("src/interfaces/mcp/server.ts"), "utf8"),
      fs.readFile(path.resolve("src/interfaces/sdk/client.ts"), "utf8"),
      fs.readFile(path.resolve("src/index.ts"), "utf8"),
      fs.readFile(path.resolve("package.json"), "utf8").then((source) => JSON.parse(source) as { dependencies?: Record<string, string> })
    ]);

    expect(cli).not.toMatch(/\.command\(["']ask["']/u);
    expect(mcp).not.toMatch(/ask_question|refresh:\s*z\.|lexical:/u);
    expect(sdk).not.toMatch(/\b(?:ask|retrieve|getLexicalProviderStatus)\s*\(/u);
    expect(publicEntry).not.toMatch(/AskOptions|RetrieveOptions|RetrievalResult|LexicalDocument|EmbeddingProvider/u);
    expect(packageJson.dependencies).not.toHaveProperty("chromadb");
  });

  it("initializes a workspace without a vector index artifact", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "repohelix-init-graph-only-"));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await initCommand(cwd);
      await expect(fs.stat(path.join(cwd, ".repohelix", "semantic-index.json"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await fs.readFile(path.join(cwd, ".repohelix", ".gitignore"), "utf8")).not.toContain("semantic-index.json");
    } finally {
      log.mockRestore();
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it("creates a version 10 Kuzu schema without search tables, indexes, or metadata", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "repohelix-kuzu-graph-only-"));
    const db = await KuzuGraphDB.open(path.join(cwd, "graph"));
    try {
      await db.initSchema("removed-search-surface");
      const tables = await db.query<{ name: string }>("CALL SHOW_TABLES() RETURN name;");
      const indexes = await db.query<Record<string, unknown>>("CALL SHOW_INDEXES() RETURN *;");
      const stateColumns = await db.query<{ name: string }>("CALL table_info('IndexState') RETURN name;");
      const generationColumns = await db.query<{ name: string }>("CALL table_info('SchemaGenerationState') RETURN name;");

      expect(SCHEMA_INDEX_VERSION).toBe("10");
      expect(tables.map((row) => row.name)).not.toContain("LexicalDocument");
      expect(JSON.stringify(indexes)).not.toMatch(/lexical|full.?text/iu);
      expect(stateColumns.map((row) => row.name).join(" ")).not.toMatch(/lexical|embedding|semantic/iu);
      expect(generationColumns.map((row) => row.name).join(" ")).not.toMatch(/lexical/iu);
    } finally {
      await db.close();
    }
  }, 20_000);
});
