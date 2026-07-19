import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { classifyKuzuQueryError, KuzuGraphDB } from "../src/adapters/graph-db/kuzu/KuzuGraphDB.js";
import { classifyNeo4jQueryError } from "../src/adapters/graph-db/neo4j/Neo4jGraphDB.js";
import { GraphDatabaseClosedError, GraphDatabaseOperationalError } from "../src/core/graph-model/db.js";

describe("graph database operational error contract", () => {
  it("keeps Kuzu syntax and schema errors non-operational", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-kuzu-error-classification-"));
    const db = await KuzuGraphDB.open(path.join(directory, "graph"));
    try {
      await db.initSchema("error-classification");
      for (const cypher of [
        "THIS IS NOT VALID CYPHER",
        "MATCH (n:DefinitelyMissingLabel) RETURN n.missingProperty"
      ]) {
        let thrown: unknown;
        try {
          await db.query(cypher);
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(Error);
        expect(thrown).not.toBeInstanceOf(GraphDatabaseOperationalError);
      }
    } finally {
      await db.close();
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("classifies only explicit Kuzu connectivity and timeout failures", () => {
    expect(classifyKuzuQueryError(new Error("Connection exception: connection reset"))).toBe("connection");
    expect(classifyKuzuQueryError(new Error("Query timed out"))).toBe("timeout");
    expect(classifyKuzuQueryError(new Error("Parser exception: invalid input"))).toBeUndefined();
    expect(classifyKuzuQueryError(new Error("Binder exception: table Missing does not exist"))).toBeUndefined();
  });

  it("classifies Neo4j driver codes without degrading client query errors", () => {
    const coded = (code: string) => Object.assign(new Error(code), { code });
    expect(classifyNeo4jQueryError(coded("ServiceUnavailable"))).toBe("service-unavailable");
    expect(classifyNeo4jQueryError(coded("SessionExpired"))).toBe("connection");
    expect(classifyNeo4jQueryError(coded("Neo.TransientError.Transaction.TransactionTimedOut"))).toBe("timeout");
    expect(classifyNeo4jQueryError(coded("Neo.ClientError.Statement.SyntaxError"))).toBeUndefined();
    expect(classifyNeo4jQueryError(coded("Neo.ClientError.Schema.ConstraintValidationFailed"))).toBeUndefined();
    expect(classifyNeo4jQueryError(new TypeError("result conversion invariant"))).toBeUndefined();
  });

  it("keeps closed database state distinct from operational failures", () => {
    const error = new GraphDatabaseClosedError();
    expect(error).not.toBeInstanceOf(GraphDatabaseOperationalError);
  });
});
