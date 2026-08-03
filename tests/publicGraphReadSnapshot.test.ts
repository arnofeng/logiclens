import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { KuzuGraphDB } from "../src/adapters/graph-db/kuzu/KuzuGraphDB.js";
import type { GraphDB, GraphValue } from "../src/core/graph-model/db.js";
import {
  assertNoLivePublicGraphReadLeases,
  pinPublicGraphReadSnapshot,
  releasePublicGraphReadSnapshot,
  tryPinPublicGraphReadSnapshot,
  withPublicGraphReadSnapshot,
  withPublicGraphSnapshotParams
} from "../src/core/graph-model/readSnapshot.js";
import { loadActiveSemanticGraph } from "../src/core/graph-model/queries.js";
import { traceSemanticGraphFromDB } from "../src/core/contracts/semanticTrace.js";

type QueryCall = { cypher: string; params?: Record<string, GraphValue> };

function queryDb(handler: (call: QueryCall) => unknown[]): GraphDB {
  return {
    query: vi.fn(async (cypher: string, params?: Record<string, GraphValue>) => handler({ cypher, params }))
  } as unknown as GraphDB;
}

describe("public graph read snapshots", () => {
  it("runs concurrent Kuzu snapshots in read-only transactions without mutating publication state", async () => {
    const previousCloseMode = process.env.REPOHELIX_KUZU_CLOSE_MODE;
    process.env.REPOHELIX_KUZU_CLOSE_MODE = "explicit";
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "repohelix-kuzu-read-snapshot-"));
    let db: KuzuGraphDB | undefined;
    try {
      db = await KuzuGraphDB.open(path.join(directory, "graph.kuzu"));
      await db.initSchema("kuzu-read-snapshot");
      const workspaceId = "workspace:kuzu-read-snapshot";
      const generation = "generation:kuzu-read-snapshot";
      const revision = "revision:kuzu-read-snapshot";
      await db.query(
        "MERGE (s:SchemaGenerationState {id: $stateId}) " +
        "SET s.workspaceId=$workspaceId, s.activeGeneration=$generation, s.activeRevision=$revision;",
        { stateId: `schema-generation-state:${workspaceId}`, workspaceId, generation, revision }
      );
      await db.upsertRepo({
        id: "repo:kuzu-read-snapshot",
        name: "KuzuReadSnapshot",
        path: "/kuzu-read-snapshot",
        remoteUrl: "",
        branch: "main",
        commitSha: "",
        language: "typescript",
        indexedAt: "2026-08-03T00:00:00.000Z"
      }, { workspaceId, generation });

      let readersReady = 0;
      let releaseReaders!: () => void;
      const bothReadersReady = new Promise<void>((resolve) => {
        releaseReaders = resolve;
      });
      const read = () => withPublicGraphReadSnapshot(db!, workspaceId, async (snapshot) => {
        readersReady++;
        if (readersReady === 2) releaseReaders();
        await bothReadersReady;
        const rows = await db!.query<{ count: GraphValue }>(
          "MATCH (r:Repo) WHERE r.workspaceId=$workspaceId AND r.generation=$generation RETURN count(r) AS count;",
          withPublicGraphSnapshotParams(snapshot)
        );
        return { snapshot, count: rows[0]?.count };
      });

      const results = await Promise.all([read(), read()]);
      expect(results.map(({ count }) => Number(count))).toEqual([1, 1]);
      expect(results.map(({ snapshot }) => snapshot.revision)).toEqual([revision, revision]);
      expect(results.every(({ snapshot }) => snapshot.leaseId === undefined)).toBe(true);

      const state = await db.query<{ activeRevision: GraphValue }>(
        "MATCH (s:SchemaGenerationState {id: $stateId}) RETURN s.activeRevision AS activeRevision;",
        { stateId: `schema-generation-state:${workspaceId}` }
      );
      const leases = await db.query<{ count: GraphValue }>(
        "MATCH (l:SchemaGenerationReadLease) WHERE l.workspaceId=$workspaceId RETURN count(l) AS count;",
        { workspaceId }
      );
      const repos = await db.query<{ count: GraphValue }>(
        "MATCH (r:Repo) WHERE r.workspaceId=$workspaceId AND r.generation=$generation RETURN count(r) AS count;",
        { workspaceId, generation }
      );
      expect(state[0]?.activeRevision).toBe(revision);
      expect(Number(leases[0]?.count)).toBe(0);
      expect(Number(repos[0]?.count)).toBe(1);
    } finally {
      await db?.close();
      await fs.rm(directory, { recursive: true, force: true });
      if (previousCloseMode === undefined) delete process.env.REPOHELIX_KUZU_CLOSE_MODE;
      else process.env.REPOHELIX_KUZU_CLOSE_MODE = previousCloseMode;
    }
  }, 30_000);

  it("pins the active generation by the workspace-specific state identity", async () => {
    const db = queryDb(({ params }) => {
      expect(params).toMatchObject({
        stateId: "schema-generation-state:workspace:test",
        workspaceId: "workspace:test"
      });
      expect(params?.leaseId).toMatch(/^schema-read-lease:/u);
      return [{ activeGeneration: "generation:one", activeRevision: "revision:one" }];
    });

    const snapshot = await pinPublicGraphReadSnapshot(db, "workspace:test");
    expect(snapshot).toMatchObject({
      workspaceId: "workspace:test",
      generation: "generation:one",
      revision: "revision:one"
    });
    expect(snapshot.leaseId).toMatch(/^schema-read-lease:/u);
    expect(Object.keys(snapshot)).toEqual(["workspaceId", "generation"]);
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it("holds and releases one lease around a complete multi-query operation", async () => {
    const calls: QueryCall[] = [];
    const db = queryDb((call) => {
      calls.push(call);
      if (call.cypher.includes("SchemaGenerationState")) {
        return [{ activeGeneration: "generation:one", activeRevision: "revision:one" }];
      }
      return [];
    });

    await withPublicGraphReadSnapshot(db, "workspace:test", async (snapshot) => {
      expect(snapshot.leaseId).toMatch(/^schema-read-lease:/u);
      await db.query("MATCH (n:Repo) WHERE n.generation=$generation RETURN n", withPublicGraphSnapshotParams(snapshot));
      await db.query("MATCH (n:File) WHERE n.generation=$generation RETURN n", withPublicGraphSnapshotParams(snapshot));
    });

    const pin = calls.find((call) => call.cypher.includes("SchemaGenerationState"));
    const release = calls.find((call) => call.cypher.includes("SchemaGenerationReadLease") && call.cypher.includes("DELETE l"));
    expect(release?.params?.leaseId).toBe(pin?.params?.leaseId);
  });

  it("keeps every query in one provider read transaction and pins its revision", async () => {
    const calls: Array<QueryCall & { insideReadTransaction: boolean }> = [];
    let insideReadTransaction = false;
    let committedRevision = "revision:two";
    let transactionRevision: string | undefined;
    const db = queryDb((call) => {
      calls.push({ ...call, insideReadTransaction });
      if (call.cypher.includes("SchemaGenerationState")) {
        return [{ activeGeneration: "generation:one", activeRevision: transactionRevision }];
      }
      return [{ revision: transactionRevision }];
    });
    db.readTransaction = vi.fn(async (operation) => {
      insideReadTransaction = true;
      transactionRevision = committedRevision;
      try {
        return await operation();
      } finally {
        insideReadTransaction = false;
        transactionRevision = undefined;
      }
    });

    await withPublicGraphReadSnapshot(db, "workspace:test", async (snapshot) => {
      expect(snapshot).toMatchObject({
        workspaceId: "workspace:test",
        generation: "generation:one",
        revision: "revision:two"
      });
      expect(snapshot.leaseId).toBeUndefined();
      const first = await db.query<{ revision: GraphValue }>("RETURN 'first'");
      committedRevision = "revision:three";
      const second = await db.query<{ revision: GraphValue }>("RETURN 'second'");
      expect([first[0]?.revision, second[0]?.revision]).toEqual(["revision:two", "revision:two"]);
    });

    expect(db.readTransaction).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(3);
    expect(calls.every((call) => call.insideReadTransaction)).toBe(true);
    expect(calls.some((call) => call.cypher.includes("SchemaGenerationReadLease"))).toBe(false);
  });

  it("blocks generation cleanup while a live read lease exists", async () => {
    const calls: QueryCall[] = [];
    const db = queryDb((call) => {
      calls.push(call);
      if (call.cypher.includes("RETURN count(l) AS count")) return [{ count: 1 }];
      return [];
    });
    await expect(assertNoLivePublicGraphReadLeases(db, {
      workspaceId: "workspace:test",
      generation: "generation:one"
    }, new Date("2026-08-02T00:00:00.000Z"))).rejects.toThrow(/live read lease/u);
    expect(calls[0]?.cypher).toContain("leaseUntil <= $now");
    expect(calls[1]?.cypher).toContain("leaseUntil > $now");
  });

  it("can explicitly release a manually pinned snapshot", async () => {
    const calls: QueryCall[] = [];
    const db = queryDb((call) => {
      calls.push(call);
      return [];
    });
    await releasePublicGraphReadSnapshot(db, {
      workspaceId: "workspace:test",
      generation: "generation:one",
      revision: "revision:one",
      leaseId: "schema-read-lease:test"
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.params).toEqual({
      workspaceId: "workspace:test",
      generation: "generation:one",
      leaseId: "schema-read-lease:test"
    });
  });

  it("distinguishes a not-yet-indexed workspace from a required read snapshot", async () => {
    const db = queryDb(() => []);
    await expect(tryPinPublicGraphReadSnapshot(db, "workspace:empty")).resolves.toBeUndefined();
    await expect(pinPublicGraphReadSnapshot(db, "workspace:empty")).rejects.toThrow("clean full reindex");
  });

  it("rejects parameters that attempt to replace the pinned scope", () => {
    const snapshot = {
      workspaceId: "workspace:test",
      generation: "generation:one",
      revision: "revision:one"
    } as const;
    expect(() => withPublicGraphSnapshotParams(snapshot, { generation: "generation:two" })).toThrow("generation");
    expect(() => withPublicGraphSnapshotParams(snapshot, { workspaceId: "workspace:other" })).toThrow("workspace");
  });

  it("loads nodes and relations from one caller-pinned generation", async () => {
    const calls: QueryCall[] = [];
    const db = queryDb((call) => {
      calls.push(call);
      return [];
    });
    const snapshot = {
      workspaceId: "workspace:test",
      generation: "generation:one",
      revision: "revision:one"
    } as const;

    await expect(loadActiveSemanticGraph(db, snapshot)).resolves.toEqual({ specs: [], relations: [] });
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.cypher).toContain("workspaceId = $workspaceId");
      expect(call.cypher).toContain("generation = $generation");
      expect(call.params).toMatchObject({
        workspaceId: snapshot.workspaceId,
        generation: snapshot.generation
      });
    }
  });

  it("pins once for a multi-query semantic trace operation", async () => {
    const calls: QueryCall[] = [];
    const db = queryDb((call) => {
      calls.push(call);
      if (call.cypher.includes("SchemaGenerationState")) {
        return [{ activeGeneration: "generation:one", activeRevision: "revision:one" }];
      }
      return [];
    });

    await traceSemanticGraphFromDB("schema:Payload", db, "workspace:test");

    const pins = calls.filter((call) => call.cypher.includes("SchemaGenerationState"));
    expect(pins).toHaveLength(1);
    const publicReads = calls.filter((call) =>
      !call.cypher.includes("SchemaGenerationState") &&
      !call.cypher.includes("SchemaGenerationReadLease"));
    expect(publicReads).toHaveLength(2);
    for (const call of publicReads) {
      expect(call.params).toMatchObject({ workspaceId: "workspace:test", generation: "generation:one" });
    }
    const releases = calls.filter((call) =>
      call.cypher.includes("SchemaGenerationReadLease") && call.cypher.includes("DELETE l"));
    expect(releases).toHaveLength(1);
    expect(releases[0]?.params?.leaseId).toBe(pins[0]?.params?.leaseId);
  });
});
