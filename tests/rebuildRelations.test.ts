import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { KuzuGraphDB } from "../src/core/graph-model/db.js";
import {
  bucketKey,
  buildExclusionClauses,
  rebuildRepoDependencies
} from "../src/core/graph-model/rebuildRelations.js";
import type {
  ContractKind,
  ContractRole,
  RepoNode,
  SemanticRelationEdge
} from "../src/core/parsing/types.js";
import { repoId } from "../src/shared/path.js";

// ---------------------------------------------------------------------------
// Pure-function unit tests
// ---------------------------------------------------------------------------

describe("bucketKey", () => {
  it("extracts the first non-template path segment as /{segment}", () => {
    expect(bucketKey("/api/orders")).toBe("/api");
    expect(bucketKey("/api/order/{id}")).toBe("/api");
  });

  it("returns / for root path", () => {
    expect(bucketKey("/")).toBe("/");
  });

  it("returns / for empty or effectively-empty input", () => {
    // After trim of trailing slashes, empty string becomes "/" internally
    expect(bucketKey("")).toBe("/");
  });

  it("returns bucket for single-segment path", () => {
    expect(bucketKey("/api")).toBe("/api");
  });

  it("returns * when the first segment is a template placeholder", () => {
    expect(bucketKey("/{id}/orders")).toBe("*");
  });

  it("handles trailing slash by stripping it before extraction", () => {
    expect(bucketKey("/api/orders/")).toBe("/api");
    expect(bucketKey("/api/")).toBe("/api");
  });

  it("returns / for a root path with trailing slash", () => {
    // "/" trailing slash stripped → "" → segments.length === 0 → "/"
    expect(bucketKey("//")).toBe("/");
  });

  it("handles multi-segment template first", () => {
    expect(bucketKey("/{org}/{repo}/settings")).toBe("*");
  });
});

describe("buildExclusionClauses", () => {
  it("returns empty clauses and params for an empty repo list", () => {
    const { clauses, params } = buildExclusionClauses([], "exclude");
    expect(clauses).toBe("");
    expect(params).toEqual({});
  });

  it("builds a single exclusion clause with the given prefix", () => {
    const { clauses, params } = buildExclusionClauses(["repo:a"], "exclude");
    expect(clauses).toBe("s.repoId <> $exclude0");
    expect(params).toEqual({ exclude0: "repo:a" });
  });

  it("joins multiple exclusions with AND", () => {
    const { clauses, params } = buildExclusionClauses(["repo:a", "repo:b", "repo:c"], "exclude");
    expect(clauses).toBe(
      "s.repoId <> $exclude0 AND s.repoId <> $exclude1 AND s.repoId <> $exclude2"
    );
    expect(params).toEqual({
      exclude0: "repo:a",
      exclude1: "repo:b",
      exclude2: "repo:c"
    });
  });

  it("uses the provided paramPrefix to generate unique parameter names", () => {
    const { clauses, params } = buildExclusionClauses(["r1"], "extra");
    expect(clauses).toBe("s.repoId <> $extra0");
    expect(params).toEqual({ extra0: "r1" });
  });
});

// ---------------------------------------------------------------------------
// addSemanticRelationsBatch DB-layer tests (KuzuGraphDB)
// ---------------------------------------------------------------------------

function makeSpec(contractId: string, repoId: string, key: string): {
  id: string; contractId: string; repoId: string; specKind: "http-endpoint";
  canonicalKey: string; specJson: string; confidence: number; active: boolean;
  fileId: string; evidenceId: string;
} {
  return {
    id: `spec:${contractId}:${key}`,
    contractId,
    repoId,
    specKind: "http-endpoint",
    canonicalKey: key,
    specJson: JSON.stringify({ kind: "http-endpoint", method: "GET", path: key, pathTemplate: key, pathParams: [], auth: "unknown" }),
    confidence: 0.9,
    active: true,
    fileId: `file:${repoId}:dummy.ts`,
    evidenceId: `ev:${contractId}:${key}`
  };
}

describe("addSemanticRelationsBatch", () => {
  it("no-ops on empty array", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "test-batch-empty-"));
    const db = await KuzuGraphDB.open(path.join(dir, "graph"));
    try {
      await db.initSchema("batch-empty-test");
      await db.addSemanticRelationsBatch([]);
      const rows = await db.query<{ count: number }>(
        "MATCH ()-[r:SEMANTIC_REL]->() RETURN count(r) AS count;"
      );
      expect(Number(rows[0]?.count ?? 0)).toBe(0);
    } finally {
      await db.close();
    }
  }, 15000);

  it("writes a single SEMANTIC_REL edge with all properties preserved", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "test-batch-single-"));
    const db = await KuzuGraphDB.open(path.join(dir, "graph"));
    try {
      await db.initSchema("batch-single-test");
      const from = makeSpec("contract:api:orders", "repo:producer", "/api/orders");
      const to = makeSpec("contract:api:orders", "repo:consumer", "/api/orders");
      await db.upsertContractSpec(from);
      await db.upsertContractSpec(to);

      const edge: SemanticRelationEdge = {
        fromSpecId: from.id,
        toSpecId: to.id,
        kind: "CALLS_ENDPOINT",
        evidenceId: "ev:test",
        reason: "HTTP method + path template match",
        confidence: 0.95,
        batchId: "batch:test",
        active: true
      };
      await db.addSemanticRelationsBatch([edge]);

      const rows = await db.query<{
        fromSpecId: string; toSpecId: string; kind: string;
        evidenceId: string; reason: string; confidence: number;
        batchId: string; active: boolean;
      }>(
        "MATCH (a:ContractSpec)-[r:SEMANTIC_REL]->(b:ContractSpec) " +
        "RETURN a.id AS fromSpecId, b.id AS toSpecId, r.kind AS kind, " +
        "r.evidenceId AS evidenceId, r.reason AS reason, r.confidence AS confidence, " +
        "r.batchId AS batchId, r.active AS active;"
      );
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row.fromSpecId).toBe(from.id);
      expect(row.toSpecId).toBe(to.id);
      expect(row.kind).toBe("CALLS_ENDPOINT");
      expect(row.evidenceId).toBe("ev:test");
      expect(row.reason).toBe("HTTP method + path template match");
      expect(Number(row.confidence)).toBe(0.95);
      expect(row.batchId).toBe("batch:test");
      expect(row.active).toBe(true);
    } finally {
      await db.close();
    }
  }, 15000);

  it("writes a batch of edges in a single call", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "test-batch-many-"));
    const db = await KuzuGraphDB.open(path.join(dir, "graph"));
    try {
      await db.initSchema("batch-many-test");

      const producers = Array.from({ length: 5 }, (_, i) =>
        makeSpec(`contract:api:ep${i}`, "repo:producer", `/api/endpoint${i}`)
      );
      const consumers = Array.from({ length: 5 }, (_, i) =>
        makeSpec(`contract:api:ep${i}`, "repo:consumer", `/api/endpoint${i}`)
      );
      for (const s of [...producers, ...consumers]) {
        await db.upsertContractSpec(s);
      }

      const edges: SemanticRelationEdge[] = producers.map((p, i) => ({
        fromSpecId: consumers[i]!.id,
        toSpecId: p.id,
        kind: "CALLS_ENDPOINT" as const,
        evidenceId: `ev:batch:${i}`,
        reason: `match ${i}`,
        confidence: 0.8 + i * 0.02,
        batchId: "batch:many",
        active: true
      }));
      await db.addSemanticRelationsBatch(edges);

      const rows = await db.query<{ count: number }>(
        "MATCH ()-[r:SEMANTIC_REL]->() RETURN count(r) AS count;"
      );
      expect(Number(rows[0]?.count ?? 0)).toBe(5);
    } finally {
      await db.close();
    }
  }, 15000);

  it("defaults batchId to empty string and active to true when not provided", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "test-batch-defaults-"));
    const db = await KuzuGraphDB.open(path.join(dir, "graph"));
    try {
      await db.initSchema("batch-defaults-test");
      const from = makeSpec("contract:api:def", "repo:a", "/api/def");
      const to = makeSpec("contract:api:def", "repo:b", "/api/def");
      await db.upsertContractSpec(from);
      await db.upsertContractSpec(to);

      const edge: SemanticRelationEdge = {
        fromSpecId: from.id,
        toSpecId: to.id,
        kind: "CALLS_ENDPOINT",
        evidenceId: "ev:defaults",
        reason: "no batchId or active provided",
        confidence: 0.7
        // batchId and active intentionally omitted
      };
      await db.addSemanticRelationsBatch([edge]);

      const rows = await db.query<{ batchId: string; active: boolean }>(
        "MATCH ()-[r:SEMANTIC_REL]->() RETURN r.batchId AS batchId, r.active AS active;"
      );
      expect(rows[0]?.batchId).toBe("");
      expect(rows[0]?.active).toBe(true);
    } finally {
      await db.close();
    }
  }, 15000);

  it("idempotently merges on (kind, evidenceId) key when re-written", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "test-batch-merge-"));
    const db = await KuzuGraphDB.open(path.join(dir, "graph"));
    try {
      await db.initSchema("batch-merge-test");
      const from = makeSpec("contract:api:merge", "repo:a", "/api/merge");
      const to = makeSpec("contract:api:merge", "repo:b", "/api/merge");
      await db.upsertContractSpec(from);
      await db.upsertContractSpec(to);

      const edge: SemanticRelationEdge = {
        fromSpecId: from.id,
        toSpecId: to.id,
        kind: "CALLS_ENDPOINT",
        evidenceId: "ev:merge",
        reason: "first reason",
        confidence: 0.5,
        batchId: "batch:first",
        active: true
      };
      await db.addSemanticRelationsBatch([edge]);

      // Write again with a different reason/confidence — should merge (no duplicate edge)
      const edge2: SemanticRelationEdge = {
        ...edge,
        reason: "updated reason",
        confidence: 0.99,
        batchId: "batch:second"
      };
      await db.addSemanticRelationsBatch([edge2]);

      const rows = await db.query<{ count: number; reason: string; confidence: number; batchId: string }>(
        "MATCH ()-[r:SEMANTIC_REL]->() RETURN count(r) AS count, r.reason AS reason, r.confidence AS confidence, r.batchId AS batchId;"
      );
      expect(Number(rows[0]?.count ?? 0)).toBe(1);
      // MERGE ... SET overwrites with last write
      expect(rows[0]?.reason).toBe("updated reason");
      expect(Number(rows[0]?.confidence)).toBe(0.99);
      expect(rows[0]?.batchId).toBe("batch:second");
    } finally {
      await db.close();
    }
  }, 15000);
});

// ---------------------------------------------------------------------------
// Scoped SEMANTIC_REL resolution integration tests
// ---------------------------------------------------------------------------

function repo(name: string): RepoNode {
  return {
    id: repoId(name),
    name,
    path: path.resolve("tests/fixtures", name),
    remoteUrl: "",
    branch: "",
    commitSha: "",
    language: "typescript",
    indexedAt: new Date().toISOString()
  };
}

async function addParticipant(
  db: KuzuGraphDB,
  input: {
    repo: RepoNode;
    contractId: string;
    kind: ContractKind;
    key: string;
    role: ContractRole;
    evidenceId: string;
    rule?: string;
  }
): Promise<void> {
  await db.upsertRepo(input.repo);
  await db.upsertContract({
    id: input.contractId,
    kind: input.kind,
    key: input.key,
    name: input.key,
    description: `${input.kind} ${input.key}`
  });
  await db.upsertEvidence({
    id: input.evidenceId,
    repoId: input.repo.id,
    fileId: `file:${input.evidenceId}`,
    filePath: `${input.repo.name}/file.ts`,
    line: 1,
    raw: input.key,
    rule: input.rule ?? `${input.role}-evidence`,
    confidence: 0.9,
    batchId: "batch:test",
    indexedAt: new Date().toISOString(),
    active: true
  });
  await db.addRepoContract({
    repoId: input.repo.id,
    contractId: input.contractId,
    role: input.role,
    evidenceId: input.evidenceId,
    confidence: 0.9,
    batchId: "batch:test",
    active: true
  });
  await db.addContractEvidence(input.contractId, input.evidenceId);
  await db.addRepoEvidence(input.repo.id, input.evidenceId);
}

async function semanticRelRows(
  db: KuzuGraphDB
): Promise<{ fromSpecId: string; toSpecId: string; kind: string }[]> {
  return db.query<{ fromSpecId: string; toSpecId: string; kind: string }>(
    `MATCH (a:ContractSpec)-[r:SEMANTIC_REL]->(b:ContractSpec)
     RETURN a.id AS fromSpecId, b.id AS toSpecId, r.kind AS kind
     ORDER BY fromSpecId, toSpecId, kind;`
  );
}

describe("scoped SEMANTIC_REL resolution via rebuildRepoDependencies", () => {
  it("resolves cross-repo CALLS_ENDPOINT between HTTP consumer and producer in different repos", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "test-scoped-http-"));
    const db = await KuzuGraphDB.open(path.join(dir, "graph"));
    try {
      await db.initSchema("scoped-http-test");

      // Producer repo: has an HTTP endpoint at /api/orders
      const producerRepo = repo("producer-repo");
      // Consumer repo: makes HTTP calls to /api/orders
      const consumerRepo = repo("consumer-repo");

      // Upsert ContractSpec for producer (http-endpoint with GET /api/orders)
      const producerSpec = {
        id: "spec:contract:api:orders:producer",
        contractId: "contract:api:orders",
        repoId: producerRepo.id,
        specKind: "http-endpoint" as const,
        canonicalKey: "GET:/api/orders",
        httpMethod: "GET",
        pathTemplate: "/api/orders",
        specJson: JSON.stringify({
          kind: "http-endpoint",
          method: "GET",
          path: "/api/orders",
          pathTemplate: "/api/orders",
          pathParams: [],
          auth: "unknown"
        }),
        confidence: 0.9,
        active: true,
        fileId: `file:${producerRepo.id}:orders.ts`,
        evidenceId: "ev:producer-orders-spec"
      };
      // Upsert ContractSpec for consumer (http-endpoint with GET /api/orders)
      const consumerSpec = {
        id: "spec:contract:api:orders:consumer",
        contractId: "contract:api:orders",
        repoId: consumerRepo.id,
        specKind: "http-endpoint" as const,
        canonicalKey: "GET:/api/orders",
        httpMethod: "GET",
        pathTemplate: "/api/orders",
        specJson: JSON.stringify({
          kind: "http-endpoint",
          method: "GET",
          path: "/api/orders",
          pathTemplate: "/api/orders",
          pathParams: [],
          auth: "unknown"
        }),
        confidence: 0.85,
        active: true,
        fileId: `file:${consumerRepo.id}:orders.ts`,
        evidenceId: "ev:consumer-orders-spec"
      };

      await db.upsertContractSpec(producerSpec);
      await db.upsertContractSpec(consumerSpec);

      await addParticipant(db, {
        repo: producerRepo,
        contractId: "contract:api:orders",
        kind: "api",
        key: "/api/orders",
        role: "producer",
        evidenceId: "ev:producer-orders",
        rule: "api-path-producer"
      });
      await addParticipant(db, {
        repo: consumerRepo,
        contractId: "contract:api:orders",
        kind: "api",
        key: "/api/orders",
        role: "consumer",
        evidenceId: "ev:consumer-orders",
        rule: "http-client-api-consumer"
      });

      // Before rebuild: no SEMANTIC_REL edges
      const before = await semanticRelRows(db);
      expect(before.filter((r) => r.kind === "CALLS_ENDPOINT")).toHaveLength(0);

      // Rebuild targeting only the consumer repo
      await rebuildRepoDependencies(db, {
        repoIds: [consumerRepo.id],
        batchId: "batch:scoped"
      });

      // After rebuild: CALLS_ENDPOINT edge should exist
      const after = await semanticRelRows(db);
      const callEdges = after.filter((r) => r.kind === "CALLS_ENDPOINT");
      expect(callEdges).toHaveLength(1);
      expect(callEdges[0]!.fromSpecId).toBe(consumerSpec.id);
      expect(callEdges[0]!.toSpecId).toBe(producerSpec.id);
    } finally {
      await db.close();
    }
  }, 20000);

  it("resolves cross-repo PUBLISHES_EVENT + SUBSCRIBES_EVENT between event publisher and subscriber", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "test-scoped-event-"));
    const db = await KuzuGraphDB.open(path.join(dir, "graph"));
    try {
      await db.initSchema("scoped-event-test");

      const publisherRepo = repo("publisher-repo");
      const subscriberRepo = repo("subscriber-repo");

      const publisherSpec = {
        id: "spec:contract:event:order-created:pub",
        contractId: "contract:event:order.created",
        repoId: publisherRepo.id,
        specKind: "event" as const,
        canonicalKey: "order.created",
        eventTopic: "order.created",
        specJson: JSON.stringify({
          kind: "event",
          topic: "order.created",
          payloadType: "OrderDTO",
          broker: "kafka"
        }),
        confidence: 0.9,
        active: true,
        fileId: `file:${publisherRepo.id}:events.ts`,
        evidenceId: "ev:pub-order-created-spec"
      };
      const subscriberSpec = {
        id: "spec:contract:event:order-created:sub",
        contractId: "contract:event:order.created",
        repoId: subscriberRepo.id,
        specKind: "event" as const,
        canonicalKey: "order.created",
        eventTopic: "order.created",
        specJson: JSON.stringify({
          kind: "event",
          topic: "order.created",
          payloadType: "OrderDTO",
          broker: "kafka"
        }),
        confidence: 0.85,
        active: true,
        fileId: `file:${subscriberRepo.id}:events.ts`,
        evidenceId: "ev:sub-order-created-spec"
      };

      await db.upsertContractSpec(publisherSpec);
      await db.upsertContractSpec(subscriberSpec);

      await addParticipant(db, {
        repo: publisherRepo,
        contractId: "contract:event:order.created",
        kind: "event",
        key: "order.created",
        role: "producer",
        evidenceId: "ev:pub-order-created",
        rule: "event-publisher"
      });
      await addParticipant(db, {
        repo: subscriberRepo,
        contractId: "contract:event:order.created",
        kind: "event",
        key: "order.created",
        role: "consumer",
        evidenceId: "ev:sub-order-created",
        rule: "event-consumer"
      });

      // Before rebuild
      const before = await semanticRelRows(db);
      expect(before.filter((r) => r.kind === "PUBLISHES_EVENT")).toHaveLength(0);
      expect(before.filter((r) => r.kind === "SUBSCRIBES_EVENT")).toHaveLength(0);

      // Rebuild targeting subscriber repo
      await rebuildRepoDependencies(db, {
        repoIds: [subscriberRepo.id],
        batchId: "batch:scoped-event"
      });

      const after = await semanticRelRows(db);
      expect(after.filter((r) => r.kind === "PUBLISHES_EVENT")).toHaveLength(1);
      expect(after.filter((r) => r.kind === "SUBSCRIBES_EVENT")).toHaveLength(1);
    } finally {
      await db.close();
    }
  }, 20000);

  it("only persists edges that involve at least one target repo in scoped mode", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "test-scoped-filter-"));
    const db = await KuzuGraphDB.open(path.join(dir, "graph"));
    try {
      await db.initSchema("scoped-filter-test");

      const targetRepo = repo("target-repo");
      const otherA = repo("other-a");
      const otherB = repo("other-b");

      // Target repo's spec
      const targetSpec = {
        id: "spec:target",
        contractId: "contract:api:shared",
        repoId: targetRepo.id,
        specKind: "http-endpoint" as const,
        canonicalKey: "GET:/api/shared",
        httpMethod: "GET",
        pathTemplate: "/api/shared",
        specJson: JSON.stringify({
          kind: "http-endpoint", method: "GET", path: "/api/shared",
          pathTemplate: "/api/shared", pathParams: [], auth: "unknown"
        }),
        confidence: 0.9,
        active: true,
        fileId: `file:${targetRepo.id}:shared.ts`,
        evidenceId: "ev:target-spec"
      };
      // Other A spec (same endpoint, different repo)
      const specA = {
        ...targetSpec,
        id: "spec:other-a",
        repoId: otherA.id
      };
      // Other B spec (same endpoint, different repo)
      const specB = {
        ...targetSpec,
        id: "spec:other-b",
        repoId: otherB.id
      };

      await db.upsertContractSpec(targetSpec);
      await db.upsertContractSpec(specA);
      await db.upsertContractSpec(specB);

      await addParticipant(db, {
        repo: targetRepo, contractId: "contract:api:shared",
        kind: "api", key: "/api/shared", role: "consumer",
        evidenceId: "ev:target", rule: "http-client-api-consumer"
      });
      await addParticipant(db, {
        repo: otherA, contractId: "contract:api:shared",
        kind: "api", key: "/api/shared", role: "producer",
        evidenceId: "ev:other-a", rule: "api-path-producer"
      });
      await addParticipant(db, {
        repo: otherB, contractId: "contract:api:shared",
        kind: "api", key: "/api/shared", role: "producer",
        evidenceId: "ev:other-b", rule: "api-path-producer"
      });

      // Rebuild only targeting targetRepo
      await rebuildRepoDependencies(db, {
        repoIds: [targetRepo.id],
        batchId: "batch:scoped-filter"
      });

      const after = await semanticRelRows(db);
      const callEdges = after.filter((r) => r.kind === "CALLS_ENDPOINT");

      // All CALLS_ENDPOINT edges involve targetRepo
      for (const e of callEdges) {
        const involves = [e.fromSpecId, e.toSpecId].some(
          (sid) => sid === targetSpec.id
        );
        expect(involves).toBe(true);
      }

      // Edge between otherA and otherB should NOT exist (neither is the target)
      const otherToOther = callEdges.filter(
        (e) =>
          (e.fromSpecId === specA.id && e.toSpecId === specB.id) ||
          (e.fromSpecId === specB.id && e.toSpecId === specA.id)
      );
      expect(otherToOther).toHaveLength(0);
    } finally {
      await db.close();
    }
  }, 20000);

  it("full rebuild (no targetRepoIds) resolves edges across all repos", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "test-full-rebuild-"));
    const db = await KuzuGraphDB.open(path.join(dir, "graph"));
    try {
      await db.initSchema("full-rebuild-test");

      const repoA = repo("full-a");
      const repoB = repo("full-b");

      const specA = {
        id: "spec:full-a",
        contractId: "contract:api:full-shared",
        repoId: repoA.id,
        specKind: "http-endpoint" as const,
        canonicalKey: "GET:/api/full-shared",
        httpMethod: "GET",
        pathTemplate: "/api/full-shared",
        specJson: JSON.stringify({
          kind: "http-endpoint", method: "GET", path: "/api/full-shared",
          pathTemplate: "/api/full-shared", pathParams: [], auth: "unknown"
        }),
        confidence: 0.9,
        active: true,
        fileId: `file:${repoA.id}:full-shared.ts`,
        evidenceId: "ev:full-a-spec"
      };
      const specB = {
        ...specA,
        id: "spec:full-b",
        repoId: repoB.id
      };

      await db.upsertContractSpec(specA);
      await db.upsertContractSpec(specB);

      await addParticipant(db, {
        repo: repoA, contractId: "contract:api:full-shared",
        kind: "api", key: "/api/full-shared", role: "producer",
        evidenceId: "ev:full-a", rule: "api-path-producer"
      });
      await addParticipant(db, {
        repo: repoB, contractId: "contract:api:full-shared",
        kind: "api", key: "/api/full-shared", role: "consumer",
        evidenceId: "ev:full-b", rule: "http-client-api-consumer"
      });

      // Full rebuild (no target repoIds)
      await rebuildRepoDependencies(db, { batchId: "batch:full" });

      const after = await semanticRelRows(db);
      const callEdges = after.filter((r) => r.kind === "CALLS_ENDPOINT");
      expect(callEdges).toHaveLength(1);
    } finally {
      await db.close();
    }
  }, 20000);

  it("does not produce intra-repo (same repo) edges", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "test-intrarepo-"));
    const db = await KuzuGraphDB.open(path.join(dir, "graph"));
    try {
      await db.initSchema("intrarepo-test");

      const singleRepo = repo("single-repo");

      const producerSpec = {
        id: "spec:intra-producer",
        contractId: "contract:api:intra",
        repoId: singleRepo.id,
        specKind: "http-endpoint" as const,
        canonicalKey: "GET:/api/intra",
        httpMethod: "GET",
        pathTemplate: "/api/intra",
        specJson: JSON.stringify({
          kind: "http-endpoint", method: "GET", path: "/api/intra",
          pathTemplate: "/api/intra", pathParams: [], auth: "unknown"
        }),
        confidence: 0.9,
        active: true,
        fileId: `file:${singleRepo.id}:intra.ts`,
        evidenceId: "ev:intra-producer-spec"
      };
      const consumerSpec = {
        ...producerSpec,
        id: "spec:intra-consumer"
      };

      await db.upsertContractSpec(producerSpec);
      await db.upsertContractSpec(consumerSpec);

      // Both producer and consumer in the same repo
      await addParticipant(db, {
        repo: singleRepo, contractId: "contract:api:intra",
        kind: "api", key: "/api/intra", role: "producer",
        evidenceId: "ev:intra-producer", rule: "api-path-producer"
      });
      await addParticipant(db, {
        repo: singleRepo, contractId: "contract:api:intra",
        kind: "api", key: "/api/intra", role: "consumer",
        evidenceId: "ev:intra-consumer", rule: "http-client-api-consumer"
      });

      await rebuildRepoDependencies(db, {
        repoIds: [singleRepo.id],
        batchId: "batch:intra"
      });

      const after = await semanticRelRows(db);
      // No CALLS_ENDPOINT (intra-repo), no PUBLISHES/SUBSCRIBES
      const crossEdges = after.filter((r) =>
        r.kind === "CALLS_ENDPOINT" ||
        r.kind === "PUBLISHES_EVENT" ||
        r.kind === "SUBSCRIBES_EVENT"
      );
      expect(crossEdges).toHaveLength(0);
    } finally {
      await db.close();
    }
  }, 20000);
});
