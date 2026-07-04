import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { KuzuGraphDB } from "../src/core/graph-model/db.js";

async function writeCsv(filePath: string, rows: string[][]): Promise<void> {
  const escape = (value: string): string => `"${value.replace(/"/g, '""')}"`;
  await fs.writeFile(filePath, rows.map((row) => row.map(escape).join(",")).join("\n"), "utf8");
}

describe("kuzu bulk import capabilities", () => {
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
