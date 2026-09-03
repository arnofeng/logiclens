import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type MockRecord = {
  keys: string[];
  get: (key: string) => unknown;
};

type MockResult = { records: MockRecord[] };
type MockRunHandler = (
  cypher: string,
  params?: Record<string, unknown>
) => Promise<MockResult>;

const neoMocks = vi.hoisted(() => {
  let runHandler: MockRunHandler = async () => ({ records: [] });
  const transactions: Array<{
    run: ReturnType<typeof vi.fn<MockRunHandler>>;
    commit: ReturnType<typeof vi.fn<() => Promise<void>>>;
    rollback: ReturnType<typeof vi.fn<() => Promise<void>>>;
  }> = [];
  const sessions: Array<{ close: ReturnType<typeof vi.fn<() => Promise<void>>> }> = [];
  const driver = {
    verifyConnectivity: vi.fn(async () => undefined),
    session: vi.fn(() => {
      const transaction = {
        run: vi.fn<MockRunHandler>((cypher, params) => runHandler(cypher, params)),
        commit: vi.fn(async () => undefined),
        rollback: vi.fn(async () => undefined)
      };
      const session = {
        run: vi.fn<MockRunHandler>((cypher, params) => runHandler(cypher, params)),
        beginTransaction: vi.fn(() => transaction),
        close: vi.fn(async () => undefined)
      };
      transactions.push(transaction);
      sessions.push(session);
      return session;
    }),
    close: vi.fn(async () => undefined)
  };
  return {
    driver,
    sessions,
    transactions,
    setRunHandler(handler: MockRunHandler): void {
      runHandler = handler;
    }
  };
});

vi.mock("neo4j-driver", () => ({
  default: {
    auth: { basic: vi.fn(() => ({ scheme: "basic" })) },
    driver: vi.fn(() => neoMocks.driver),
    session: { READ: "READ", WRITE: "WRITE" },
    isInt: vi.fn(() => false),
    int: vi.fn((value) => value)
  }
}));

import { KuzuGraphDB } from "../src/adapters/graph-db/kuzu/KuzuGraphDB.js";
import { Neo4jGraphDB } from "../src/adapters/graph-db/neo4j/Neo4jGraphDB.js";
import type { GraphValue, IncrementalIndexCommitRequest } from "../src/core/graph-model/db.js";
import { withPublicGraphReadSnapshot } from "../src/core/graph-model/readSnapshot.js";

const workspaceId = "workspace:incremental-commit";
const generation = "generation:active";
const request: IncrementalIndexCommitRequest = {
  workspaceId,
  expectedActiveGeneration: generation,
  expectedActiveRevision: "revision:one",
  nextRevision: "revision:two",
  schemaIndexVersion: "schema:v-next"
};
const futureLease = "2999-01-01T00:00:00.000Z";
const tempDirs: string[] = [];
let previousCloseMode: string | undefined;

function record(values: Record<string, unknown>): MockRecord {
  return {
    keys: Object.keys(values),
    get: (key) => values[key]
  };
}

beforeAll(() => {
  previousCloseMode = process.env.REPOHELIX_KUZU_CLOSE_MODE;
  process.env.REPOHELIX_KUZU_CLOSE_MODE = "explicit";
});

afterAll(() => {
  if (previousCloseMode === undefined) delete process.env.REPOHELIX_KUZU_CLOSE_MODE;
  else process.env.REPOHELIX_KUZU_CLOSE_MODE = previousCloseMode;
});

beforeEach(() => {
  vi.clearAllMocks();
  neoMocks.sessions.splice(0);
  neoMocks.transactions.splice(0);
  neoMocks.setRunHandler(async () => ({ records: [] }));
});

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function openKuzu(): Promise<KuzuGraphDB> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "repohelix-incremental-commit-"));
  tempDirs.push(dir);
  const db = await KuzuGraphDB.open(path.join(dir, "graph"));
  await db.initSchema("incremental-commit-test");
  return db;
}

async function seedKuzuReservation(db: KuzuGraphDB, input = request): Promise<void> {
  await db.initializePublicGraphStats({
    workspaceId: input.workspaceId,
    generation: input.expectedActiveGeneration
  }, input.expectedActiveRevision, {
    repos: 0,
    files: 0,
    codeNodes: 0,
    sectionNodes: 0,
    callEdges: 0,
    importEdges: 0,
    entities: 0
  });
  await db.query(
    "MERGE (g:SchemaGeneration {id: $generation}) " +
    "SET g.workspaceId=$workspaceId, g.parentGeneration='', g.status='active', " +
    "g.activeRevision=$activeRevision, g.schemaIndexVersion='schema:old', " +
    "g.createdAt=$createdAt, g.updatedAt=$createdAt;",
    {
      generation: input.expectedActiveGeneration,
      workspaceId: input.workspaceId,
      activeRevision: input.expectedActiveRevision,
      createdAt: "2026-08-02T00:00:00.000Z"
    }
  );
  await db.query(
    "MERGE (s:SchemaGenerationState {id: $id}) " +
    "SET s.workspaceId=$workspaceId, s.activeGeneration=$activeGeneration, " +
    "s.activeRevision=$activeRevision, s.pendingGeneration='', " +
    "s.pendingRevision=$pendingRevision, s.pendingParentGeneration=$activeGeneration, " +
    "s.pendingParentRevision=$activeRevision, s.pendingLeaseUntil=$pendingLeaseUntil, " +
    "s.protocolNonce='reserved', s.schemaIndexVersion='schema:old';",
    {
      id: `schema-generation-state:${input.workspaceId}`,
      workspaceId: input.workspaceId,
      activeGeneration: input.expectedActiveGeneration,
      activeRevision: input.expectedActiveRevision,
      pendingRevision: input.nextRevision,
      pendingLeaseUntil: futureLease
    }
  );
}

function defineKuzuTests(): void {
  describe("Kuzu incremental index commit", () => {
  it("advances the revision and clears its reservation in the mutation transaction", async () => {
    const db = await openKuzu();
    try {
      await seedKuzuReservation(db);
      const expectedColumns: Readonly<Record<string, readonly string[]>> = {
        PublicGraphStats: [
          "workspaceId",
          "generation",
          "revision",
          "repos",
          "files",
          "codeNodes",
          "sectionNodes",
          "callEdges",
          "importEdges",
          "entities"
        ],
        SchemaSourceReplacement: ["revision"],
        SchemaContributionReplacement: ["revision"],
        TypeDeclarationFact: ["factId", "languageId", "resolutionScopeId", "canonicalName"],
        ResolutionContextFact: ["factId", "languageId", "resolutionScopeId"],
        ResolutionScopeDependencyFact: [
          "factId",
          "sourceContextId",
          "fromLanguageId",
          "fromRepoId",
          "fromResolutionScopeId",
          "toLanguageId",
          "toRepoId",
          "toResolutionScopeId"
        ],
        SchemaRootFact: ["factId", "rootReferenceId", "ownerFileId", "ownerSpecId", "resolutionContextId", "languageId"],
        SchemaDependencyFact: ["factId", "rootReferenceId", "declarationId"],
        SchemaProvenanceFact: ["factId", "rootReferenceId", "relationId"],
        SchemaDiagnosticFact: ["factId", "rootReferenceId", "ownerSpecId", "languageId", "resolutionScopeId"],
        SchemaBehaviorFingerprintFact: ["factId", "languageId"]
      };
      for (const [tableName, expected] of Object.entries(expectedColumns)) {
        const columns = await db.query<{ name: GraphValue }>(
          `CALL table_info('${tableName}') RETURN name;`
        );
        const names = new Set(columns.map((column) => column.name));
        expect(expected.every((column) => names.has(column))).toBe(true);
      }
      const readRevisions = await withPublicGraphReadSnapshot(db, workspaceId, async (snapshot) => {
        const state = await db.query<{ activeRevision: GraphValue }>(
          "MATCH (s:SchemaGenerationState {id: $id}) RETURN s.activeRevision AS activeRevision;",
          { id: `schema-generation-state:${workspaceId}` }
        );
        const active = await db.query<{ activeRevision: GraphValue }>(
          "MATCH (g:SchemaGeneration {id: $id}) RETURN g.activeRevision AS activeRevision;",
          { id: generation }
        );
        return [snapshot.revision, state[0]?.activeRevision, active[0]?.activeRevision];
      });
      expect(readRevisions).toEqual([
        request.expectedActiveRevision,
        request.expectedActiveRevision,
        request.expectedActiveRevision
      ]);

      const result = await db.applyIncrementalIndexMutation(request, async () => {
        await db.query(
          "MERGE (n:IndexState {id: $id}) SET n.status=$status;",
          { id: "incremental-marker", status: "committed" }
        );
        await db.applyPublicGraphStatsDelta({ workspaceId, generation }, {
          expectedRevision: request.expectedActiveRevision,
          nextRevision: request.nextRevision,
          delta: {
            repos: 0,
            files: 0,
            codeNodes: 0,
            sectionNodes: 0,
            callEdges: 0,
            importEdges: 0,
            entities: 0
          }
        });
        return "applied";
      });

      expect(result).toBe("applied");
      expect(await db.query(
        "MATCH (n:IndexState {id: $id}) RETURN n.status AS status;",
        { id: "incremental-marker" }
      )).toEqual([{ status: "committed" }]);
      expect(await db.query(
        "MATCH (s:SchemaGenerationState {id: $id}) " +
        "RETURN s.activeGeneration AS activeGeneration, s.activeRevision AS activeRevision, " +
        "s.pendingRevision AS pendingRevision, s.pendingParentGeneration AS pendingParentGeneration, " +
        "s.pendingParentRevision AS pendingParentRevision, s.pendingLeaseUntil AS pendingLeaseUntil;",
        { id: `schema-generation-state:${workspaceId}` }
      )).toEqual([{
        activeGeneration: generation,
        activeRevision: request.nextRevision,
        pendingRevision: "",
        pendingParentGeneration: "",
        pendingParentRevision: "",
        pendingLeaseUntil: ""
      }]);
      expect(await db.query(
        "MATCH (g:SchemaGeneration {id: $generation}) " +
        "RETURN g.activeRevision AS activeRevision, g.schemaIndexVersion AS schemaIndexVersion;",
        { generation }
      )).toEqual([{
        activeRevision: request.nextRevision,
        schemaIndexVersion: request.schemaIndexVersion
      }]);
      const failedRequest: IncrementalIndexCommitRequest = {
        ...request,
        expectedActiveRevision: request.nextRevision,
        nextRevision: "revision:three"
      };
      await db.query(
        "MATCH (s:SchemaGenerationState {id: $id}) " +
        "SET s.pendingRevision=$pendingRevision, s.pendingParentGeneration=$generation, " +
        "s.pendingParentRevision=$parentRevision, s.pendingLeaseUntil=$pendingLeaseUntil;",
        {
          id: `schema-generation-state:${workspaceId}`,
          generation,
          pendingRevision: failedRequest.nextRevision,
          parentRevision: failedRequest.expectedActiveRevision,
          pendingLeaseUntil: futureLease
        }
      );
      await expect(db.applyIncrementalIndexMutation(failedRequest, async () => {
        await db.query(
          "MERGE (n:IndexState {id: $id}) SET n.status=$status;",
          { id: "rolled-back-marker", status: "pending" }
        );
        throw new Error("injected participant failure");
      })).rejects.toThrow("injected participant failure");

      expect(await db.query<{ count: GraphValue }>(
        "MATCH (n:IndexState {id: $id}) RETURN count(n) AS count;",
        { id: "rolled-back-marker" }
      )).toEqual([{ count: 0 }]);
      expect(await db.query(
        "MATCH (s:SchemaGenerationState {id: $id}) " +
        "RETURN s.activeRevision AS activeRevision, s.pendingRevision AS pendingRevision;",
        { id: `schema-generation-state:${workspaceId}` }
      )).toEqual([{
        activeRevision: failedRequest.expectedActiveRevision,
        pendingRevision: failedRequest.nextRevision
      }]);
    } finally {
      await db.close();
    }
  });
  });
}

describe("Neo4j incremental index commit", () => {
  it("creates the targeted incremental fact and contribution indexes", async () => {
    const statements: string[] = [];
    neoMocks.setRunHandler(async (cypher) => {
      statements.push(cypher);
      return { records: [] };
    });
    const db = await Neo4jGraphDB.open("bolt://example", { username: "test", password: "secret" });
    try {
      await db.initSchema("incremental-indexes");
      expect(statements).toContain(
        "CREATE INDEX IF NOT EXISTS FOR (n:TypeDeclarationFact) ON (n.generation, n.repoId, n.fileId)"
      );
      expect(statements).toContain(
        "CREATE INDEX IF NOT EXISTS FOR (n:SchemaDependencyFact) ON (n.generation, n.declarationId)"
      );
      expect(statements).toContain(
        "CREATE INDEX IF NOT EXISTS FOR (n:SchemaRootFact) ON (n.generation, n.rootReferenceId)"
      );
      expect(statements).toContain(
        "CREATE INDEX IF NOT EXISTS FOR (n:SchemaContribution) ON (n.generation, n.rootReferenceId)"
      );
      expect(statements).toContain(
        "CREATE INDEX IF NOT EXISTS FOR (n:SchemaContribution) ON (n.generation, n.entityKind, n.entityId)"
      );
      expect(statements).toContain(
        "CREATE CONSTRAINT IF NOT EXISTS FOR (n:PublicGraphStats) REQUIRE n.id IS UNIQUE"
      );
      expect(statements).toContain(
        "CREATE INDEX IF NOT EXISTS FOR (s:PublicGraphStats) ON (s.workspaceId, s.generation)"
      );
    } finally {
      await db.close();
    }
  });

  it("uses a READ session for one revision-pinned multi-query operation", async () => {
    neoMocks.setRunHandler(async (cypher) => {
      if (cypher.includes("SchemaGenerationState")) {
        return { records: [record({
          activeGeneration: generation,
          activeRevision: request.expectedActiveRevision
        })] };
      }
      return { records: [] };
    });
    const db = await Neo4jGraphDB.open("bolt://example", { username: "test", password: "secret" });
    try {
      await withPublicGraphReadSnapshot(db, workspaceId, async (snapshot) => {
        expect(snapshot.revision).toBe(request.expectedActiveRevision);
        await db.query("RETURN 'first-read'");
        await db.query("RETURN 'second-read'");
      });

      expect(neoMocks.transactions).toHaveLength(1);
      expect(neoMocks.transactions[0]!.run).toHaveBeenCalledTimes(3);
      expect(neoMocks.transactions[0]!.commit).toHaveBeenCalledTimes(1);
      expect(neoMocks.transactions[0]!.rollback).not.toHaveBeenCalled();
      expect(neoMocks.driver.session).toHaveBeenCalledWith({ defaultAccessMode: "READ" });
    } finally {
      await db.close();
    }
  });

  it("uses one provider transaction for the CAS, mutation, and revision advance", async () => {
    neoMocks.setRunHandler(async (cypher) => {
      if (cypher.includes("RETURN s.activeGeneration AS activeGeneration")) {
        return { records: [record({
          activeGeneration: request.expectedActiveGeneration,
          activeRevision: request.expectedActiveRevision,
          pendingGeneration: "",
          pendingRevision: request.nextRevision,
          pendingParentGeneration: request.expectedActiveGeneration,
          pendingParentRevision: request.expectedActiveRevision,
          pendingLeaseUntil: futureLease
        })] };
      }
      if (cypher.includes("RETURN g.id AS id")) {
        return { records: [record({ id: generation })] };
      }
      if (cypher.includes("MATCH (s:PublicGraphStats")) {
        return { records: [record({ revision: request.nextRevision })] };
      }
      if (cypher.includes("RETURN s.activeRevision AS activeRevision")) {
        return { records: [record({ activeRevision: request.nextRevision })] };
      }
      return { records: [] };
    });
    const db = await Neo4jGraphDB.open("bolt://example", { username: "test", password: "secret" });
    try {
      await db.applyIncrementalIndexMutation(request, async () => {
        await db.query("MERGE (n:IndexState {id: 'neo-marker'}) SET n.status='committed'");
        await db.query(
          "MERGE (s:PublicGraphStats {id: 'neo-stats'}) SET s.revision=$revision",
          { revision: request.nextRevision }
        );
      });

      expect(neoMocks.transactions).toHaveLength(1);
      expect(neoMocks.transactions[0]!.commit).toHaveBeenCalledTimes(1);
      expect(neoMocks.transactions[0]!.rollback).not.toHaveBeenCalled();
      const statements = neoMocks.transactions[0]!.run.mock.calls.map(([cypher]) => cypher);
      expect(statements).toHaveLength(6);
      expect(statements[0]).toContain("SET s.protocolNonce=$lockNonce");
      expect(statements[1]).toContain("neo-marker");
      expect(statements[2]).toContain("PublicGraphStats");
      expect(statements[3]).toContain("MATCH (s:PublicGraphStats");
      expect(statements[4]).toContain("MATCH (g:SchemaGeneration");
      expect(statements[5]).toContain("s.activeRevision=$expectedActiveRevision");
    } finally {
      await db.close();
    }
  });

  it("rolls back and never advances the revision when the callback fails", async () => {
    neoMocks.setRunHandler(async (cypher) => {
      if (cypher.includes("RETURN s.activeGeneration AS activeGeneration")) {
        return { records: [record({
          activeGeneration: request.expectedActiveGeneration,
          activeRevision: request.expectedActiveRevision,
          pendingGeneration: "",
          pendingRevision: request.nextRevision,
          pendingParentGeneration: request.expectedActiveGeneration,
          pendingParentRevision: request.expectedActiveRevision,
          pendingLeaseUntil: futureLease
        })] };
      }
      return { records: [] };
    });
    const db = await Neo4jGraphDB.open("bolt://example", { username: "test", password: "secret" });
    const callback = vi.fn(async () => {
      await db.query("MERGE (n:IndexState {id: 'neo-rollback-marker'})");
      throw new Error("injected graph failure");
    });
    try {
      await expect(db.applyIncrementalIndexMutation(request, callback)).rejects.toThrow("injected graph failure");
      expect(callback).toHaveBeenCalledTimes(1);
      expect(neoMocks.transactions).toHaveLength(1);
      expect(neoMocks.transactions[0]!.commit).not.toHaveBeenCalled();
      expect(neoMocks.transactions[0]!.rollback).toHaveBeenCalledTimes(1);
      expect(neoMocks.transactions[0]!.run).toHaveBeenCalledTimes(2);
    } finally {
      await db.close();
    }
  });

  it("rejects a publication callback that does not advance public graph stats metadata", async () => {
    neoMocks.setRunHandler(async (cypher) => {
      if (cypher.includes("RETURN s.activeGeneration AS activeGeneration")) {
        return { records: [record({
          activeGeneration: request.expectedActiveGeneration,
          activeRevision: request.expectedActiveRevision,
          pendingGeneration: "",
          pendingRevision: request.nextRevision,
          pendingParentGeneration: request.expectedActiveGeneration,
          pendingParentRevision: request.expectedActiveRevision,
          pendingLeaseUntil: futureLease
        })] };
      }
      return { records: [] };
    });
    const db = await Neo4jGraphDB.open("bolt://example", { username: "test", password: "secret" });
    try {
      await expect(db.applyIncrementalIndexMutation(request, async () => {
        await db.query("MERGE (n:IndexState {id: 'missing-stats-marker'})");
      })).rejects.toThrow("did not publish matching public graph stats metadata");
      expect(neoMocks.transactions[0]!.commit).not.toHaveBeenCalled();
      expect(neoMocks.transactions[0]!.rollback).toHaveBeenCalledTimes(1);
      expect(neoMocks.transactions[0]!.run).toHaveBeenCalledTimes(3);
    } finally {
      await db.close();
    }
  });

  it("rejects a stale active revision before invoking the mutation callback", async () => {
    neoMocks.setRunHandler(async (cypher) => {
      if (cypher.includes("RETURN s.activeGeneration AS activeGeneration")) {
        return { records: [record({
          activeGeneration: request.expectedActiveGeneration,
          activeRevision: "revision:concurrent",
          pendingGeneration: "",
          pendingRevision: request.nextRevision,
          pendingParentGeneration: request.expectedActiveGeneration,
          pendingParentRevision: request.expectedActiveRevision,
          pendingLeaseUntil: futureLease
        })] };
      }
      return { records: [] };
    });
    const db = await Neo4jGraphDB.open("bolt://example", { username: "test", password: "secret" });
    const callback = vi.fn(async () => undefined);
    try {
      await expect(db.applyIncrementalIndexMutation(request, callback)).rejects.toThrow("lost its workspace reservation");
      expect(callback).not.toHaveBeenCalled();
      expect(neoMocks.transactions[0]!.commit).not.toHaveBeenCalled();
      expect(neoMocks.transactions[0]!.rollback).toHaveBeenCalledTimes(1);
    } finally {
      await db.close();
    }
  });

  it("rolls the mutation back when the final revision compare-and-swap fails", async () => {
    neoMocks.setRunHandler(async (cypher) => {
      if (cypher.includes("RETURN s.activeGeneration AS activeGeneration")) {
        return { records: [record({
          activeGeneration: request.expectedActiveGeneration,
          activeRevision: request.expectedActiveRevision,
          pendingGeneration: "",
          pendingRevision: request.nextRevision,
          pendingParentGeneration: request.expectedActiveGeneration,
          pendingParentRevision: request.expectedActiveRevision,
          pendingLeaseUntil: futureLease
        })] };
      }
      if (cypher.includes("RETURN g.id AS id")) {
        return { records: [record({ id: generation })] };
      }
      if (cypher.includes("MATCH (s:PublicGraphStats")) {
        return { records: [record({ revision: request.nextRevision })] };
      }
      // An empty final RETURN models a failed guarded update. The active
      // generation metadata and callback write must roll back with it.
      return { records: [] };
    });
    const db = await Neo4jGraphDB.open("bolt://example", { username: "test", password: "secret" });
    const callback = vi.fn(async () => {
      await db.query("MERGE (n:IndexState {id: 'neo-cas-marker'})");
      await db.query(
        "MERGE (s:PublicGraphStats {id: 'neo-cas-stats'}) SET s.revision=$revision",
        { revision: request.nextRevision }
      );
    });
    try {
      await expect(db.applyIncrementalIndexMutation(request, callback)).rejects.toThrow("final compare-and-swap");
      expect(callback).toHaveBeenCalledTimes(1);
      expect(neoMocks.transactions[0]!.commit).not.toHaveBeenCalled();
      expect(neoMocks.transactions[0]!.rollback).toHaveBeenCalledTimes(1);
      expect(neoMocks.transactions[0]!.run).toHaveBeenCalledTimes(6);
    } finally {
      await db.close();
    }
  });
});

// Kuzu's native handle is closed at the end of the worker after the mock-only
// Neo4j contract cases have completed. This avoids opening more JS work while
// the native close is draining on Windows.
defineKuzuTests();
