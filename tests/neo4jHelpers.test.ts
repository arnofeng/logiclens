import { describe, expect, it, vi } from "vitest";

// Use vi.hoisted to declare mock functions before vi.mock is hoisted
const { mockIsInt } = vi.hoisted(() => {
  const mockIsInt = vi.fn((value: unknown) => false);
  return { mockIsInt };
});

// Mock neo4j-driver before importing the helpers
vi.mock("neo4j-driver", () => ({
  default: {
    int: (value: bigint | number) => ({ toNumber: () => Number(value), toString: () => String(value) }),
    isInt: mockIsInt,
    auth: { basic: vi.fn() },
    driver: vi.fn(),
    session: { WRITE: "WRITE" }
  },
  isInt: mockIsInt
}));

import { toNeo4jValue, toNeo4jParams, toNumber, decodeList, decodeJournalRow } from "../src/adapters/graph-db/neo4j/Neo4jGraphDB.js";

describe("Neo4j toNeo4jValue", () => {
  it("converts bigint to neo4j integer", () => {
    const result = toNeo4jValue(42n);
    expect(result).toBeDefined();
    expect((result as any).toNumber()).toBe(42);
  });

  it("passes through string values", () => {
    expect(toNeo4jValue("hello")).toBe("hello");
  });

  it("passes through number values", () => {
    expect(toNeo4jValue(123)).toBe(123);
  });

  it("passes through boolean values", () => {
    expect(toNeo4jValue(true)).toBe(true);
    expect(toNeo4jValue(false)).toBe(false);
  });

  it("passes through null values", () => {
    expect(toNeo4jValue(null)).toBeNull();
  });

  it("converts arrays recursively", () => {
    const result = toNeo4jValue(["a", "b"]) as unknown[];
    expect(result).toEqual(["a", "b"]);
  });

  it("converts nested objects recursively", () => {
    const result = toNeo4jValue({ key: "value", nested: { num: 1 } }) as Record<string, unknown>;
    expect(result.key).toBe("value");
    expect(result.nested).toEqual({ num: 1 });
  });

  it("converts bigint inside nested structures", () => {
    const result = toNeo4jValue({ count: 100n }) as Record<string, unknown>;
    expect((result.count as any).toNumber()).toBe(100);
  });
});

describe("Neo4j toNeo4jParams", () => {
  it("returns empty object for undefined params", () => {
    expect(toNeo4jParams(undefined)).toEqual({});
  });

  it("converts all parameter values", () => {
    const result = toNeo4jParams({ name: "test", count: 42n, active: true });
    expect(result.name).toBe("test");
    expect((result.count as any).toNumber()).toBe(42);
    expect(result.active).toBe(true);
  });
});

describe("Neo4j toNumber", () => {
  it("returns number as-is", () => {
    expect(toNumber(42)).toBe(42);
  });

  it("converts bigint to number", () => {
    expect(toNumber(100n)).toBe(100);
  });

  it("converts neo4j Integer to number", () => {
    mockIsInt.mockReturnValueOnce(true);
    const mockInt = { toNumber: () => 99 };
    expect(toNumber(mockInt)).toBe(99);
  });

  it("converts other types via Number()", () => {
    expect(toNumber("42")).toBe(42);
    expect(toNumber(null)).toBe(0);
  });
});

describe("Neo4j decodeList", () => {
  it("returns empty array for undefined", () => {
    expect(decodeList(undefined)).toEqual([]);
  });

  it("returns empty array for empty string", () => {
    expect(decodeList("")).toEqual([]);
  });

  it("parses JSON array string", () => {
    expect(decodeList('["a","b","c"]')).toEqual(["a", "b", "c"]);
  });

  it("returns empty array for non-array JSON", () => {
    expect(decodeList('"not-array"')).toEqual([]);
  });

  it("returns empty array for invalid JSON", () => {
    expect(decodeList("not-json")).toEqual([]);
  });

  it("converts non-string elements to strings", () => {
    expect(decodeList('[1,2,3]')).toEqual(["1", "2", "3"]);
  });
});

describe("Neo4j decodeJournalRow", () => {
  it("decodes a complete journal row", () => {
    const row = {
      batchId: "batch:1",
      repoIds: '["repo:a","repo:b"]',
      repoNames: '["service-a","service-b"]',
      writerMode: "merge",
      atomicityMode: "transactional" as const,
      status: "started" as const,
      startedAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
      completedStage: "begin",
      error: ""
    };
    const result = decodeJournalRow(row);
    expect(result.batchId).toBe("batch:1");
    expect(result.repoIds).toEqual(["repo:a", "repo:b"]);
    expect(result.repoNames).toEqual(["service-a", "service-b"]);
    expect(result.writerMode).toBe("merge");
    expect(result.atomicityMode).toBe("transactional");
    expect(result.status).toBe("started");
    expect(result.completedStage).toBe("begin");
    expect(result.error).toBeUndefined();
  });

  it("sets completedStage to undefined when empty", () => {
    const row = {
      batchId: "batch:2",
      repoIds: '["repo:a"]',
      repoNames: '["service-a"]',
      writerMode: "bulk-copy",
      atomicityMode: "journaled-recoverable" as const,
      status: "committed" as const,
      startedAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T01:00:00Z",
      completedStage: "",
      error: ""
    };
    const result = decodeJournalRow(row);
    expect(result.completedStage).toBeUndefined();
  });

  it("sets error to undefined when empty", () => {
    const row = {
      batchId: "batch:3",
      repoIds: '["repo:a"]',
      repoNames: '["service-a"]',
      writerMode: "merge",
      atomicityMode: "best-effort" as const,
      status: "failed" as const,
      startedAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:05:00Z",
      completedStage: "graph-write",
      error: ""
    };
    const result = decodeJournalRow(row);
    expect(result.error).toBeUndefined();
  });

  it("preserves error when non-empty", () => {
    const row = {
      batchId: "batch:4",
      repoIds: '["repo:a"]',
      repoNames: '["service-a"]',
      writerMode: "merge",
      atomicityMode: "transactional" as const,
      status: "failed" as const,
      startedAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:05:00Z",
      completedStage: "graph-write",
      error: "something went wrong"
    };
    const result = decodeJournalRow(row);
    expect(result.error).toBe("something went wrong");
  });
});
