import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const result = { records: [] };
  const tx = {
    run: vi.fn().mockResolvedValue(result),
    commit: vi.fn().mockResolvedValue(undefined),
    rollback: vi.fn().mockResolvedValue(undefined)
  };
  const session = {
    run: vi.fn().mockResolvedValue(result),
    beginTransaction: vi.fn(() => tx),
    close: vi.fn().mockResolvedValue(undefined)
  };
  const driver = {
    verifyConnectivity: vi.fn().mockResolvedValue(undefined),
    session: vi.fn((_options?: { database?: string; defaultAccessMode?: string }) => session),
    close: vi.fn().mockResolvedValue(undefined)
  };
  return { driver, session, tx };
});

vi.mock("neo4j-driver", () => ({
  default: {
    auth: { basic: vi.fn(() => ({ scheme: "basic" })) },
    driver: vi.fn(() => mocks.driver),
    session: { READ: "READ", WRITE: "WRITE" },
    isInt: vi.fn(() => false),
    int: vi.fn((value) => value)
  }
}));

import { Neo4jGraphDB } from "../src/adapters/graph-db/neo4j/Neo4jGraphDB.js";
import { GraphDatabaseClosedError, GraphDatabaseOperationalError, withTransaction } from "../src/core/graph-model/db.js";

describe("Neo4j database isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.session.run.mockResolvedValue({ records: [] });
    mocks.tx.run.mockResolvedValue({ records: [] });
  });

  it("binds standalone queries and transactions to the configured database", async () => {
    const db = await Neo4jGraphDB.open("bolt://example", {
      username: "test",
      password: "secret",
      database: "  logiclens_conformance  "
    });

    await db.query("RETURN 1;");
    await withTransaction(db, async () => {
      await db.query("RETURN 2;");
    });
    await db.close();

    expect(mocks.driver.session).toHaveBeenCalledTimes(2);
    expect(mocks.driver.session.mock.calls.every(([options]) =>
      options?.database === "logiclens_conformance"
    )).toBe(true);
    expect(mocks.session.beginTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.tx.commit).toHaveBeenCalledTimes(1);
  });

  it.each(["", "   ", "\t\r\n"])("rejects an explicitly configured blank database name %j", async (database) => {
    await expect(Neo4jGraphDB.open("bolt://example", {
      username: "test",
      password: "secret",
      database
    })).rejects.toThrow("database name must not be empty or whitespace-only");

    expect(mocks.driver.session).not.toHaveBeenCalled();
    expect(mocks.driver.verifyConnectivity).not.toHaveBeenCalled();
  });

  it("propagates Neo4j syntax errors and wraps only transient query failures", async () => {
    const db = await Neo4jGraphDB.open("bolt://example", { username: "test", password: "secret" });
    const syntax = Object.assign(new Error("invalid query"), { code: "Neo.ClientError.Statement.SyntaxError" });
    mocks.session.run.mockRejectedValueOnce(syntax);
    await expect(db.query("INVALID")).rejects.toBe(syntax);

    const timeout = Object.assign(new Error("secret timeout detail"), { code: "Neo.TransientError.Transaction.TransactionTimedOut" });
    mocks.session.run.mockRejectedValueOnce(timeout);
    const failure = await db.query("RETURN 1").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(GraphDatabaseOperationalError);
    expect(failure).toMatchObject({ kind: "timeout", message: "Graph database query failed" });
    expect((failure as Error).cause).toBe(timeout);
    await db.close();
  });

  it("rejects queries after close with the closed-state error", async () => {
    const db = await Neo4jGraphDB.open("bolt://example", { username: "test", password: "secret" });
    await db.close();
    await expect(db.query("RETURN 1")).rejects.toBeInstanceOf(GraphDatabaseClosedError);
  });
});
