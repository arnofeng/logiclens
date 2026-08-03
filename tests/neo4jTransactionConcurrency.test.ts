import { beforeEach, describe, expect, it, vi } from "vitest";

type MockResult = { records: [] };

type MockTransaction = {
  id: number;
  run: ReturnType<typeof vi.fn<(cypher: string) => Promise<MockResult>>>;
  commit: ReturnType<typeof vi.fn<() => Promise<void>>>;
  rollback: ReturnType<typeof vi.fn<() => Promise<void>>>;
};

type MockSession = {
  id: number;
  transaction: MockTransaction;
  run: ReturnType<typeof vi.fn<(cypher: string) => Promise<MockResult>>>;
  beginTransaction: ReturnType<typeof vi.fn<() => MockTransaction>>;
  close: ReturnType<typeof vi.fn<() => Promise<void>>>;
};

const mocks = vi.hoisted(() => {
  const transactions: MockTransaction[] = [];
  const sessions: MockSession[] = [];
  const driver = {
    verifyConnectivity: vi.fn().mockResolvedValue(undefined),
    session: vi.fn(() => {
      const transaction: MockTransaction = {
        id: transactions.length + 1,
        run: vi.fn(async () => ({ records: [] })),
        commit: vi.fn(async () => undefined),
        rollback: vi.fn(async () => undefined)
      };
      const session: MockSession = {
        id: sessions.length + 1,
        transaction,
        run: vi.fn(async () => ({ records: [] })),
        beginTransaction: vi.fn(() => transaction),
        close: vi.fn(async () => undefined)
      };
      transactions.push(transaction);
      sessions.push(session);
      return session;
    }),
    close: vi.fn().mockResolvedValue(undefined)
  };
  return { driver, sessions, transactions };
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
import { withTransaction } from "../src/core/graph-model/db.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("Neo4j transaction concurrency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sessions.splice(0);
    mocks.transactions.splice(0);
  });

  it("isolates overlapping withTransaction calls by async execution context", async () => {
    const db = await Neo4jGraphDB.open("bolt://example", { username: "test", password: "secret" });
    const firstStarted = deferred();
    const releaseFirst = deferred();

    const first = withTransaction(db, async () => {
      await db.query("RETURN 'first-before'");
      firstStarted.resolve();
      await releaseFirst.promise;
      await db.query("RETURN 'first-after'");
    });
    await firstStarted.promise;

    const second = withTransaction(db, async () => {
      await db.query("RETURN 'second'");
    });
    await second;
    releaseFirst.resolve();
    await first;

    expect(mocks.sessions).toHaveLength(2);
    expect(mocks.transactions).toHaveLength(2);
    expect(mocks.transactions[0]!.run.mock.calls.map(([cypher]) => cypher)).toEqual([
      "RETURN 'first-before'",
      "RETURN 'first-after'"
    ]);
    expect(mocks.transactions[1]!.run.mock.calls.map(([cypher]) => cypher)).toEqual(["RETURN 'second'"]);
    expect(mocks.transactions.every((transaction) => transaction.commit.mock.calls.length === 1)).toBe(true);
    expect(mocks.transactions.every((transaction) => transaction.rollback.mock.calls.length === 0)).toBe(true);
    expect(mocks.sessions.every((session) => session.close.mock.calls.length === 1)).toBe(true);
    await db.close();
  });

  it("reuses one transaction for nested withTransaction calls", async () => {
    const db = await Neo4jGraphDB.open("bolt://example", { username: "test", password: "secret" });

    await withTransaction(db, async () => {
      await db.query("RETURN 'outer-before'");
      await withTransaction(db, async () => {
        await db.query("RETURN 'nested'");
      });
      await db.query("RETURN 'outer-after'");
    });

    expect(mocks.sessions).toHaveLength(1);
    expect(mocks.transactions).toHaveLength(1);
    expect(mocks.transactions[0]!.run.mock.calls.map(([cypher]) => cypher)).toEqual([
      "RETURN 'outer-before'",
      "RETURN 'nested'",
      "RETURN 'outer-after'"
    ]);
    expect(mocks.transactions[0]!.commit).toHaveBeenCalledTimes(1);
    expect(mocks.transactions[0]!.rollback).not.toHaveBeenCalled();
    expect(mocks.sessions[0]!.close).toHaveBeenCalledTimes(1);
    await db.close();
  });

  it("keeps the manual begin and commit transaction API nested and reusable", async () => {
    const db = await Neo4jGraphDB.open("bolt://example", { username: "test", password: "secret" });

    await db.beginTransaction();
    await db.query("RETURN 'manual-before'");
    await db.beginTransaction();
    await db.query("RETURN 'manual-nested'");
    await db.commitTransaction();
    expect(mocks.transactions[0]!.commit).not.toHaveBeenCalled();
    await db.commitTransaction();

    expect(mocks.sessions).toHaveLength(1);
    expect(mocks.transactions[0]!.run.mock.calls.map(([cypher]) => cypher)).toEqual([
      "RETURN 'manual-before'",
      "RETURN 'manual-nested'"
    ]);
    expect(mocks.transactions[0]!.commit).toHaveBeenCalledTimes(1);
    expect(mocks.sessions[0]!.close).toHaveBeenCalledTimes(1);
    await db.close();
  });
});
