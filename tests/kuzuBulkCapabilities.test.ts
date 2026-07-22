import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { KuzuGraphDB } from "../src/core/graph-model/db.js";
import { encodeCsvValue, type CsvScalar } from "../src/core/graph-model/csvStaging.js";

async function writeCsv(filePath: string, rows: string[][]): Promise<void> {
  const escape = (value: string): string => `"${value.replace(/"/g, '""')}"`;
  await fs.writeFile(filePath, rows.map((row) => row.map(escape).join(",")).join("\n"), "utf8");
}

async function writeEncodedCsv(filePath: string, rows: CsvScalar[][]): Promise<void> {
  await fs.writeFile(filePath, rows.map((row) => row.map(encodeCsvValue).join(",")).join("\n"), "utf8");
}

describe("kuzu bulk import capabilities", () => {
  it("appends full lexical rows with LOAD FROM MERGE and keeps FTS, rollback, and reopen semantics", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "test-kuzu-lexical-load-"));
    const databasePath = path.join(dir, "graph");
    let db = await KuzuGraphDB.open(databasePath);
    const appendCsv = path.join(dir, "append.csv");
    const rollbackCsv = path.join(dir, "rollback.csv");
    const appendFtsText = "appendloadmarker 中文追加 ident_append_load";
    const appendBytes = Buffer.byteLength(appendFtsText, "utf8");
    const loadQuery = (filePath: string) =>
      `LOAD FROM "${filePath.replace(/\\/g, "/")}" (PARALLEL=false) WITH ` +
      "CAST(COLUMN0 AS STRING) AS id, CAST(COLUMN1 AS STRING) AS canonicalId, " +
      "CAST(COLUMN2 AS STRING) AS workspaceId, CAST(COLUMN3 AS STRING) AS repoId, " +
      "CAST(COLUMN4 AS STRING) AS kind, CAST(COLUMN5 AS STRING) AS title, " +
      "CAST(COLUMN6 AS STRING) AS qualifiedName, CAST(COLUMN7 AS STRING) AS path, " +
      "CAST(COLUMN8 AS STRING) AS searchableText, CAST(COLUMN9 AS STRING[]) AS tokens, " +
      "CAST(COLUMN10 AS BOOL) AS active, CAST(COLUMN11 AS STRING) AS sourceHash, " +
      "CAST(COLUMN12 AS STRING) AS batchId, CAST(COLUMN13 AS STRING) AS renderRef, " +
      "CAST(COLUMN14 AS STRING) AS fileId, CAST(COLUMN15 AS STRING) AS ftsText, " +
      "CAST(COLUMN16 AS INT64) AS ftsSizeBytes " +
      "MERGE (n:LexicalDocument {id: id}) SET n.canonicalId = canonicalId, " +
      "n.workspaceId = workspaceId, n.repoId = repoId, n.kind = kind, n.title = title, " +
      "n.qualifiedName = qualifiedName, n.path = path, n.searchableText = searchableText, " +
      "n.tokens = tokens, n.active = active, n.sourceHash = sourceHash, n.batchId = batchId, " +
      "n.renderRef = renderRef, n.fileId = fileId, n.ftsText = ftsText, n.ftsSizeBytes = ftsSizeBytes;";
    try {
      await db.query("LOAD EXTENSION FTS;");
      await db.query(
        "CREATE NODE TABLE LexicalDocument(" +
        "id STRING, canonicalId STRING, workspaceId STRING, repoId STRING, kind STRING, " +
        "title STRING, qualifiedName STRING, path STRING, searchableText STRING, tokens STRING[], " +
        "active BOOL, sourceHash STRING, batchId STRING, renderRef STRING, fileId STRING, ftsText STRING, " +
        "ftsSizeBytes INT64, PRIMARY KEY(id));"
      );
      await db.query("CALL CREATE_FTS_INDEX('LexicalDocument', 'workspace_lexical', ['ftsText']);");
      await db.query(
        "CREATE (:LexicalDocument {id: $id, canonicalId: $canonicalId, workspaceId: $workspaceId, " +
        "repoId: $repoId, kind: $kind, title: $title, searchableText: $searchableText, tokens: $tokens, " +
        "active: $active, sourceHash: $sourceHash, batchId: $batchId, renderRef: $renderRef, " +
        "ftsText: $ftsText, ftsSizeBytes: $ftsSizeBytes});",
        {
          id: "lexical:repo-a",
          canonicalId: "repo:a",
          workspaceId: "workspace:test",
          repoId: "repo:a",
          kind: "repo",
          title: "Repo A",
          searchableText: "repo a baseline",
          tokens: ["repo", "baseline"],
          active: true,
          sourceHash: "hash:a",
          batchId: "batch:a",
          renderRef: "render:a",
          ftsText: "repo a baseline",
          ftsSizeBytes: Buffer.byteLength("repo a baseline", "utf8")
        }
      );
      await writeEncodedCsv(appendCsv, [[
        "lexical:repo-b",
        "repo:b",
        "workspace:test",
        "repo:b",
        "repo",
        "Quoted \"Repo B\"\n第二行",
        null,
        "src/中文,append.ts",
        "Repo B searchable 中文追加",
        "[appendloadmarker,cjk_追加,src/append.ts]",
        true,
        "hash:b",
        "batch:b",
        "render:b",
        null,
        appendFtsText,
        appendBytes
      ]]);

      await db.transaction(async () => {
        await db.query(loadQuery(appendCsv));
      });

      const loaded = await db.query<{ title: string; tokens: string[]; active: boolean; ftsSizeBytes: number | bigint }>(
        "MATCH (n:LexicalDocument {id: $id}) RETURN n.title AS title, n.tokens AS tokens, " +
        "n.active AS active, n.ftsSizeBytes AS ftsSizeBytes;",
        { id: "lexical:repo-b" }
      );
      expect(loaded).toEqual([expect.objectContaining({
        title: "Quoted \"Repo B\"\n第二行",
        tokens: ["appendloadmarker", "cjk_追加", "src/append.ts"],
        active: true,
        ftsSizeBytes: expect.anything()
      })]);
      expect(Number(loaded[0]?.ftsSizeBytes)).toBe(appendBytes);
      const fts = await db.query<{ id: string }>(
        "CALL QUERY_FTS_INDEX('LexicalDocument', 'workspace_lexical', 'appendloadmarker') " +
        "RETURN node.id AS id;"
      );
      expect(fts).toEqual([{ id: "lexical:repo-b" }]);

      await writeEncodedCsv(rollbackCsv, [[
        "lexical:rollback",
        "repo:rollback",
        "workspace:test",
        "repo:rollback",
        "repo",
        "Rollback",
        null,
        null,
        "rollback marker",
        "[]",
        true,
        "hash:rollback",
        "batch:rollback",
        "render:rollback",
        null,
        "rollback marker",
        Buffer.byteLength("rollback marker", "utf8")
      ]]);
      await expect(db.transaction(async () => {
        await db.query(loadQuery(rollbackCsv));
        throw new Error("rollback capability test");
      })).rejects.toThrow("rollback capability test");
      expect(await db.query("MATCH (n:LexicalDocument {id: 'lexical:rollback'}) RETURN n.id AS id;"))
        .toEqual([]);

      await db.close();
      db = await KuzuGraphDB.open(databasePath);
      await db.query("LOAD EXTENSION FTS;");
      expect(await db.query("MATCH (n:LexicalDocument {id: 'lexical:repo-b'}) RETURN n.id AS id;"))
        .toEqual([{ id: "lexical:repo-b" }]);
      expect(await db.query(
        "CALL QUERY_FTS_INDEX('LexicalDocument', 'workspace_lexical', 'appendloadmarker') RETURN node.id AS id;"
      )).toEqual([{ id: "lexical:repo-b" }]);
    } finally {
      await db.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("copies nodes and relations from csv files using current Kuzu syntax", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "test-kuzu-copy-"));
    const db = await KuzuGraphDB.open(path.join(dir, "graph"));
    try {
      await db.query("CREATE NODE TABLE Person(id STRING, name STRING, active BOOL, note STRING, PRIMARY KEY(id));");
      await db.query("CREATE REL TABLE Knows(FROM Person TO Person, raw STRING, active BOOL);");
      const peopleCsv = path.join(dir, "people.csv").replace(/\\/g, "/");
      const knowsCsv = path.join(dir, "knows.csv").replace(/\\/g, "/");
      await writeCsv(path.join(dir, "people.csv"), [
        ["p1", "Alice", "true", "quote \" and newline\ninside"],
        ["p2", "Bob", "false", "Chinese raw"]
      ]);
      await writeCsv(path.join(dir, "knows.csv"), [
        ["p1", "p2", "from csv", "true"]
      ]);

      await db.query(`COPY Person FROM "${peopleCsv}" (PARALLEL=false);`);
      await db.query(`COPY Knows FROM "${knowsCsv}" (PARALLEL=false);`);

      const nodes = await db.query<{ count: number }>("MATCH (p:Person) RETURN count(p) AS count;");
      const edges = await db.query<{ raw: string; active: boolean }>("MATCH (:Person)-[k:Knows]->(:Person) RETURN k.raw AS raw, k.active AS active;");
      expect(Number(nodes[0]?.count ?? 0)).toBe(2);
      expect(edges).toEqual([expect.objectContaining({ raw: "from csv", active: true })]);
      await expect(db.query(`COPY Person FROM "${peopleCsv}" (PARALLEL=false);`)).rejects.toThrow();
    } finally {
      await db.close();
    }
  });

  it("supports LOAD FROM with MERGE for upsert-style imports", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "test-kuzu-load-"));
    const db = await KuzuGraphDB.open(path.join(dir, "graph"));
    try {
      await db.query("CREATE NODE TABLE Person(id STRING, name STRING, PRIMARY KEY(id));");
      const peopleCsv = path.join(dir, "people.csv").replace(/\\/g, "/");
      await writeCsv(path.join(dir, "people.csv"), [
        ["p1", "Alice"],
        ["p1", "Alice Updated"]
      ]);
      await db.query(`LOAD FROM "${peopleCsv}" WITH COLUMN0 AS id, COLUMN1 AS name MERGE (p:Person {id: id}) ON CREATE SET p.name = name ON MATCH SET p.name = name;`);
      const rows = await db.query<{ name: string }>("MATCH (p:Person {id: 'p1'}) RETURN p.name AS name;");
      expect(rows).toEqual([{ name: "Alice Updated" }]);
    } finally {
      await db.close();
    }
  });

  it("supports LOAD FROM with MERGE for relation upserts", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "test-kuzu-rel-load-"));
    const db = await KuzuGraphDB.open(path.join(dir, "graph"));
    try {
      await db.query("CREATE NODE TABLE Person(id STRING, name STRING, PRIMARY KEY(id));");
      await db.query("CREATE REL TABLE Knows(FROM Person TO Person, key STRING, note STRING, active BOOL);");
      const peopleCsv = path.join(dir, "people.csv").replace(/\\/g, "/");
      const knowsCsv = path.join(dir, "knows.csv").replace(/\\/g, "/");
      await writeCsv(path.join(dir, "people.csv"), [
        ["p1", "Alice"],
        ["p2", "Bob"]
      ]);
      await writeCsv(path.join(dir, "knows.csv"), [
        ["p1", "p2", "friend", "old", "true"],
        ["p1", "p2", "friend", "updated", "false"]
      ]);

      await db.query(`LOAD FROM "${peopleCsv}" (PARALLEL=false) WITH COLUMN0 AS id, COLUMN1 AS name MERGE (p:Person {id: id}) SET p.name = name;`);
      await db.query(
        `LOAD FROM "${knowsCsv}" (PARALLEL=false) WITH COLUMN0 AS fromId, COLUMN1 AS toId, COLUMN2 AS key, COLUMN3 AS note, COLUMN4 AS active ` +
        "MATCH (a:Person {id: fromId}), (b:Person {id: toId}) " +
        "MERGE (a)-[r:Knows {key: key}]->(b) SET r.note = note, r.active = active;"
      );

      const rows = await db.query<{ count: number; note: string; active: boolean }>("MATCH (:Person)-[r:Knows]->(:Person) RETURN count(r) AS count, r.note AS note, r.active AS active;");
      expect(Number(rows[0]?.count ?? 0)).toBe(1);
      expect(rows[0]).toEqual(expect.objectContaining({ note: "updated", active: false }));
    } finally {
      await db.close();
    }
  });
});
