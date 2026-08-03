import { beforeEach, describe, expect, it, vi } from "vitest";

type RecordValue = string | undefined;

function record(values: Record<string, RecordValue>) {
  return {
    keys: Object.keys(values),
    get: (key: string) => values[key]
  };
}

const mocks = vi.hoisted(() => {
  const transactionQueries: string[] = [];
  const transaction = {
    run: vi.fn(async (cypher: string) => {
      transactionQueries.push(cypher);
      if (cypher.includes("MATCH (b:GraphWriteBatch")) {
        return {
          records: [record({
            workspaceId: "workspace:one",
            generation: "generation:pending",
            status: "started"
          })]
        };
      }
      if (cypher.includes("SchemaGenerationState")) {
        return {
          records: [record({
            activeGeneration: "generation:parent",
            pendingGeneration: "generation:pending"
          })]
        };
      }
      return { records: [] };
    }),
    commit: vi.fn(async () => undefined),
    rollback: vi.fn(async () => undefined)
  };
  const session = {
    beginTransaction: vi.fn(() => transaction),
    run: vi.fn(async () => ({ records: [] })),
    close: vi.fn(async () => undefined)
  };
  const driver = {
    verifyConnectivity: vi.fn(async () => undefined),
    session: vi.fn(() => session),
    close: vi.fn(async () => undefined)
  };
  return { driver, session, transaction, transactionQueries };
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

describe("Neo4j generation cleanup guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.transactionQueries.splice(0);
  });

  it("locks generation state and refuses to delete a live reserved pending public graph", async () => {
    const db = await Neo4jGraphDB.open("bolt://example", { username: "test", password: "secret" });
    try {
      await expect(db.cleanupGraphWriteBatch("batch:pending"))
        .rejects.toThrow(/reserved pending public graph generation/u);
      expect(mocks.transactionQueries.some((cypher) => cypher.includes("SET s.protocolNonce=$nonce")))
        .toBe(true);
      expect(mocks.transactionQueries.some((cypher) => /DELETE\s+[rn]/u.test(cypher)))
        .toBe(false);
      expect(mocks.transaction.commit).not.toHaveBeenCalled();
      expect(mocks.transaction.rollback).toHaveBeenCalledTimes(1);
    } finally {
      await db.close();
    }
  });

  it("refuses to delete the active public graph", async () => {
    const db = await Neo4jGraphDB.open("bolt://example", { username: "test", password: "secret" });
    try {
      await expect(db.deletePublicGraphGeneration({
        workspaceId: "workspace:one",
        generation: "generation:parent"
      })).rejects.toThrow(/active public graph generation/u);
      expect(mocks.transactionQueries.some((cypher) => /DELETE\s+[rn]/u.test(cypher)))
        .toBe(false);
    } finally {
      await db.close();
    }
  });
});
