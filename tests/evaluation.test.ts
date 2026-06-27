import { describe, expect, it } from "vitest";
import { materializeDependenciesFromSemanticRelations } from "../src/extractors/crossRepoContracts.js";
import {
  compareDependencySets,
  evaluatePrecisionRecallInMemory,
  formatPrecisionRecallReport,
  type PrecisionRecallReport
} from "../src/contracts/evaluation/precisionRecall.js";
import { mergeAndDedupeDeps, structuralKey } from "../src/contracts/depsMerge.js";
import { serializeSpec } from "../src/contracts/spec.js";
import type {
  ContractSpecNode,
  RepoDependencyEdge,
  SemanticRelationEdge
} from "../src/parsers/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeHttpSpec(opts: {
  id: string; contractId: string; repoId: string;
  method?: string; path: string; pathTemplate?: string;
}): ContractSpecNode {
  return {
    id: opts.id,
    contractId: opts.contractId,
    specKind: "http-endpoint",
    repoId: opts.repoId,
    fileId: `file:${opts.repoId}:test`,
    evidenceId: `ev:${opts.id}`,
    canonicalKey: opts.method ? `${opts.method}:${opts.pathTemplate ?? opts.path}` : (opts.pathTemplate ?? opts.path),
    httpMethod: opts.method,
    pathTemplate: opts.pathTemplate ?? opts.path,
    specJson: serializeSpec({
      kind: "http-endpoint",
      method: opts.method as any,
      path: opts.path,
      pathTemplate: opts.pathTemplate ?? opts.path,
      pathParams: [],
      auth: "unknown"
    }),
    confidence: 0.9
  };
}

function makeEventSpec(opts: {
  id: string; contractId: string; repoId: string;
  topic: string;
}): ContractSpecNode {
  const topic = opts.topic.toLowerCase();
  return {
    id: opts.id,
    contractId: opts.contractId,
    specKind: "event",
    repoId: opts.repoId,
    fileId: `file:${opts.repoId}:test`,
    evidenceId: `ev:${opts.id}`,
    canonicalKey: topic,
    eventTopic: topic,
    specJson: serializeSpec({
      kind: "event",
      topic,
      broker: "kafka"
    }),
    confidence: 0.85
  };
}

function makeSchemaSpec(opts: {
  id: string; contractId: string; repoId: string;
  name: string;
}): ContractSpecNode {
  return {
    id: opts.id,
    contractId: opts.contractId,
    specKind: "schema",
    repoId: opts.repoId,
    fileId: `file:${opts.repoId}:test`,
    evidenceId: `ev:${opts.id}`,
    canonicalKey: opts.name.toLowerCase(),
    specJson: serializeSpec({
      kind: "schema",
      name: opts.name,
      language: "typescript",
      fields: []
    }),
    confidence: 0.75
  };
}

function makeDepEdge(opts: {
  fromRepoId: string;
  toRepoId: string;
  dependencyType: RepoDependencyEdge["dependencyType"];
  sourceContractId: string;
  targetContractId: string;
  evidenceId?: string;
  raw?: string;
  confidence?: number;
}): RepoDependencyEdge {
  return {
    fromRepoId: opts.fromRepoId,
    toRepoId: opts.toRepoId,
    dependencyType: opts.dependencyType,
    sourceContractId: opts.sourceContractId,
    targetContractId: opts.targetContractId,
    evidenceId: opts.evidenceId ?? `ev:${opts.sourceContractId}`,
    raw: opts.raw ?? "test",
    confidence: opts.confidence ?? 0.9
  };
}

// ---------------------------------------------------------------------------
// materializeDependenciesFromSemanticRelations
// ---------------------------------------------------------------------------

describe("materializeDependenciesFromSemanticRelations", () => {
  it("returns empty for empty inputs", () => {
    const result = materializeDependenciesFromSemanticRelations([], []);
    expect(result).toEqual([]);
  });

  it("materializes CALLS_ENDPOINT → api dependency (consumer→producer)", () => {
    const consumer = makeHttpSpec({
      id: "spec:c1", contractId: "c:web:get-orders", repoId: "repo-web",
      method: "GET", path: "/api/orders"
    });
    const producer = makeHttpSpec({
      id: "spec:p1", contractId: "c:order:get-orders", repoId: "repo-orders",
      method: "GET", path: "/api/orders"
    });

    const rel: SemanticRelationEdge = {
      fromSpecId: consumer.id,
      toSpecId: producer.id,
      kind: "CALLS_ENDPOINT",
      evidenceId: "ev:resolver",
      reason: "GET /api/orders exact match",
      confidence: 0.95
    };

    const result = materializeDependenciesFromSemanticRelations([rel], [consumer, producer]);

    expect(result).toHaveLength(1);
    const dep = result[0]!;
    expect(dep.fromRepoId).toBe("repo-web");       // consumer
    expect(dep.toRepoId).toBe("repo-orders");       // producer
    expect(dep.dependencyType).toBe("api");
    expect(dep.sourceContractId).toBe(consumer.contractId);
    expect(dep.targetContractId).toBe(producer.contractId);
    expect(dep.evidenceId).toBe("ev:resolver");
    expect(dep.raw).toBe("GET /api/orders exact match");
    expect(dep.confidence).toBe(0.95);
  });

  it("materializes PUBLISHES_EVENT → event dependency (reversed: producer→consumer to consumer→producer)", () => {
    const producer = makeEventSpec({
      id: "spec:p1", contractId: "c:order:order-created", repoId: "repo-orders",
      topic: "order.created"
    });
    const consumer = makeEventSpec({
      id: "spec:c1", contractId: "c:notify:order-created", repoId: "repo-notify",
      topic: "order.created"
    });

    const rel: SemanticRelationEdge = {
      fromSpecId: producer.id,   // SEMANTIC_REL: producer → consumer
      toSpecId: consumer.id,
      kind: "PUBLISHES_EVENT",
      evidenceId: "ev:event-resolver",
      reason: "order.created matched",
      confidence: 0.95
    };

    const result = materializeDependenciesFromSemanticRelations([rel], [producer, consumer]);

    expect(result).toHaveLength(1);
    const dep = result[0]!;
    // PUBLISHES_EVENT is reversed: dependency is consumer→producer
    expect(dep.fromRepoId).toBe("repo-notify");     // consumer
    expect(dep.toRepoId).toBe("repo-orders");        // producer
    expect(dep.dependencyType).toBe("event");
    expect(dep.sourceContractId).toBe(consumer.contractId);
    expect(dep.targetContractId).toBe(producer.contractId);
    expect(dep.confidence).toBe(0.95);
  });

  it("materializes SUBSCRIBES_EVENT → event dependency (consumer→producer)", () => {
    const consumer = makeEventSpec({
      id: "spec:c1", contractId: "c:notify:order-created", repoId: "repo-notify",
      topic: "order.created"
    });
    const producer = makeEventSpec({
      id: "spec:p1", contractId: "c:order:order-created", repoId: "repo-orders",
      topic: "order.created"
    });

    const rel: SemanticRelationEdge = {
      fromSpecId: consumer.id,   // SEMANTIC_REL: consumer → producer
      toSpecId: producer.id,
      kind: "SUBSCRIBES_EVENT",
      evidenceId: "ev:event-resolver",
      reason: "order.created subscribed",
      confidence: 0.95
    };

    const result = materializeDependenciesFromSemanticRelations([rel], [consumer, producer]);

    expect(result).toHaveLength(1);
    const dep = result[0]!;
    expect(dep.fromRepoId).toBe("repo-notify");     // consumer
    expect(dep.toRepoId).toBe("repo-orders");        // producer
    expect(dep.dependencyType).toBe("event");
    expect(dep.sourceContractId).toBe(consumer.contractId);
    expect(dep.targetContractId).toBe(producer.contractId);
  });

  it("materializes USES_SCHEMA → shared-contract dependency", () => {
    const user = makeSchemaSpec({
      id: "spec:u1", contractId: "c:derived", repoId: "repo-web",
      name: "UserDTO"
    });
    const provider = makeSchemaSpec({
      id: "spec:p1", contractId: "c:base", repoId: "repo-shared",
      name: "BaseDTO"
    });

    const rel: SemanticRelationEdge = {
      fromSpecId: user.id,
      toSpecId: provider.id,
      kind: "USES_SCHEMA",
      evidenceId: "ev:schema-resolver",
      reason: "UserDTO extends BaseDTO",
      confidence: 0.7
    };

    const result = materializeDependenciesFromSemanticRelations([rel], [user, provider]);

    expect(result).toHaveLength(1);
    const dep = result[0]!;
    expect(dep.fromRepoId).toBe("repo-web");
    expect(dep.toRepoId).toBe("repo-shared");
    expect(dep.dependencyType).toBe("shared-contract");
  });

  it("excludes same-repo edges", () => {
    const consumer = makeHttpSpec({
      id: "spec:c1", contractId: "c:web:get-orders", repoId: "repo-same",
      method: "GET", path: "/api/orders"
    });
    const producer = makeHttpSpec({
      id: "spec:p1", contractId: "c:order:get-orders", repoId: "repo-same",
      method: "GET", path: "/api/orders"
    });

    const rel: SemanticRelationEdge = {
      fromSpecId: consumer.id,
      toSpecId: producer.id,
      kind: "CALLS_ENDPOINT",
      evidenceId: "ev:resolver",
      reason: "same-repo GET /api/orders",
      confidence: 0.95
    };

    const result = materializeDependenciesFromSemanticRelations([rel], [consumer, producer]);
    expect(result).toHaveLength(0);
  });

  it("skips REQUEST_SCHEMA, RESPONSE_SCHEMA, EVENT_PAYLOAD", () => {
    const httpSpec = makeHttpSpec({
      id: "spec:h1", contractId: "c:http", repoId: "repo-a",
      method: "POST", path: "/api/orders"
    });
    const schemaSpec = makeSchemaSpec({
      id: "spec:s1", contractId: "c:schema", repoId: "repo-b",
      name: "CreateOrderDTO"
    });

    const relations: SemanticRelationEdge[] = [
      {
        fromSpecId: httpSpec.id,
        toSpecId: schemaSpec.id,
        kind: "REQUEST_SCHEMA",
        evidenceId: "ev:1",
        reason: "body type",
        confidence: 0.7
      },
      {
        fromSpecId: schemaSpec.id,
        toSpecId: httpSpec.id,
        kind: "RESPONSE_SCHEMA",
        evidenceId: "ev:2",
        reason: "response type",
        confidence: 0.7
      },
      {
        fromSpecId: schemaSpec.id,
        toSpecId: httpSpec.id,
        kind: "EVENT_PAYLOAD",
        evidenceId: "ev:3",
        reason: "payload match",
        confidence: 0.7
      }
    ];

    const result = materializeDependenciesFromSemanticRelations(relations, [httpSpec, schemaSpec]);
    expect(result).toHaveLength(0);
  });

  it("skips edges with missing spec lookups", () => {
    const spec = makeHttpSpec({
      id: "spec:exists", contractId: "c:exists", repoId: "repo-a",
      method: "GET", path: "/api/test"
    });

    const rel: SemanticRelationEdge = {
      fromSpecId: "spec:missing-from",
      toSpecId: "spec:exists",
      kind: "CALLS_ENDPOINT",
      evidenceId: "ev:missing",
      reason: "one spec missing",
      confidence: 0.9
    };

    const result = materializeDependenciesFromSemanticRelations([rel], [spec]);
    expect(result).toHaveLength(0);
  });

  it("deduplicates edges with same composite key", () => {
    const consumer = makeHttpSpec({
      id: "spec:c1", contractId: "c:web:get-orders", repoId: "repo-web",
      method: "GET", path: "/api/orders"
    });
    const producer = makeHttpSpec({
      id: "spec:p1", contractId: "c:order:get-orders", repoId: "repo-orders",
      method: "GET", path: "/api/orders"
    });

    // Two identical relations (can happen via postExtract merge)
    const rel1: SemanticRelationEdge = {
      fromSpecId: consumer.id,
      toSpecId: producer.id,
      kind: "CALLS_ENDPOINT",
      evidenceId: "ev:same",
      reason: "GET /api/orders match",
      confidence: 0.95
    };
    const rel2: SemanticRelationEdge = { ...rel1 };

    const result = materializeDependenciesFromSemanticRelations([rel1, rel2], [consumer, producer]);
    expect(result).toHaveLength(1);
  });

  it("produces multiple deps for mixed SEMANTIC_REL kinds", () => {
    const apiConsumer = makeHttpSpec({
      id: "spec:ac", contractId: "c:ac", repoId: "repo-web",
      method: "GET", path: "/api/data"
    });
    const apiProducer = makeHttpSpec({
      id: "spec:ap", contractId: "c:ap", repoId: "repo-data",
      method: "GET", path: "/api/data"
    });
    const eventProducer = makeEventSpec({
      id: "spec:ep", contractId: "c:ep", repoId: "repo-data",
      topic: "data.created"
    });
    const eventConsumer = makeEventSpec({
      id: "spec:ec", contractId: "c:ec", repoId: "repo-web",
      topic: "data.created"
    });

    const relations: SemanticRelationEdge[] = [
      {
        fromSpecId: apiConsumer.id, toSpecId: apiProducer.id,
        kind: "CALLS_ENDPOINT", evidenceId: "ev:api", reason: "api", confidence: 0.95
      },
      {
        fromSpecId: eventProducer.id, toSpecId: eventConsumer.id,
        kind: "PUBLISHES_EVENT", evidenceId: "ev:event", reason: "event", confidence: 0.95
      }
    ];

    const result = materializeDependenciesFromSemanticRelations(
      relations,
      [apiConsumer, apiProducer, eventProducer, eventConsumer]
    );

    expect(result).toHaveLength(2);
    const types = result.map((d) => d.dependencyType).sort();
    expect(types).toEqual(["api", "event"]);
  });
});

// ---------------------------------------------------------------------------
// compareDependencySets
// ---------------------------------------------------------------------------

describe("compareDependencySets", () => {
  it("perfect match → P=1, R=1", () => {
    const candidate = [
      makeDepEdge({ fromRepoId: "r1", toRepoId: "r2", dependencyType: "api", sourceContractId: "c1", targetContractId: "c1" })
    ];
    const baseline = [
      makeDepEdge({ fromRepoId: "r1", toRepoId: "r2", dependencyType: "api", sourceContractId: "c1", targetContractId: "c1" })
    ];

    const { aggregate } = compareDependencySets(candidate, baseline);
    expect(aggregate.precision).toBe(1);
    expect(aggregate.recall).toBe(1);
    expect(aggregate.truePositive).toBe(1);
    expect(aggregate.falsePositive).toHaveLength(0);
    expect(aggregate.falseNegative).toHaveLength(0);
  });

  it("empty both → P=1, R=1", () => {
    const { aggregate } = compareDependencySets([], []);
    expect(aggregate.precision).toBe(1);
    expect(aggregate.recall).toBe(1);
    expect(aggregate.expected).toBe(0);
    expect(aggregate.actual).toBe(0);
  });

  it("candidate has extra → FP > 0, P < 1, R = 1", () => {
    const candidate = [
      makeDepEdge({ fromRepoId: "r1", toRepoId: "r2", dependencyType: "api", sourceContractId: "c1", targetContractId: "c2" }),
      makeDepEdge({ fromRepoId: "r3", toRepoId: "r4", dependencyType: "api", sourceContractId: "c3", targetContractId: "c4" })
    ];
    const baseline = [
      makeDepEdge({ fromRepoId: "r1", toRepoId: "r2", dependencyType: "api", sourceContractId: "c1", targetContractId: "c2" })
    ];

    const { aggregate } = compareDependencySets(candidate, baseline);
    expect(aggregate.precision).toBe(0.5);
    expect(aggregate.recall).toBe(1);
    expect(aggregate.truePositive).toBe(1);
    expect(aggregate.falsePositive).toHaveLength(1);
    expect(aggregate.falseNegative).toHaveLength(0);
  });

  it("baseline has extra → FN > 0, P = 1, R < 1", () => {
    const candidate = [
      makeDepEdge({ fromRepoId: "r1", toRepoId: "r2", dependencyType: "api", sourceContractId: "c1", targetContractId: "c2" })
    ];
    const baseline = [
      makeDepEdge({ fromRepoId: "r1", toRepoId: "r2", dependencyType: "api", sourceContractId: "c1", targetContractId: "c2" }),
      makeDepEdge({ fromRepoId: "r3", toRepoId: "r4", dependencyType: "api", sourceContractId: "c3", targetContractId: "c4" })
    ];

    const { aggregate } = compareDependencySets(candidate, baseline);
    expect(aggregate.precision).toBe(1);
    expect(aggregate.recall).toBe(0.5);
    expect(aggregate.truePositive).toBe(1);
    expect(aggregate.falsePositive).toHaveLength(0);
    expect(aggregate.falseNegative).toHaveLength(1);
  });

  it("per-type aggregation", () => {
    const candidate = [
      makeDepEdge({ fromRepoId: "r1", toRepoId: "r2", dependencyType: "api", sourceContractId: "c1", targetContractId: "c1" }),
      makeDepEdge({ fromRepoId: "r1", toRepoId: "r3", dependencyType: "event", sourceContractId: "c2", targetContractId: "c2" })
    ];
    const baseline = [
      makeDepEdge({ fromRepoId: "r1", toRepoId: "r2", dependencyType: "api", sourceContractId: "c1", targetContractId: "c1" })
      // event missing in baseline
    ];

    const { byType } = compareDependencySets(candidate, baseline);

    const apiMetric = byType.find((m) => m.dependencyType === "api");
    expect(apiMetric).toBeDefined();
    expect(apiMetric!.precision).toBe(1);
    expect(apiMetric!.recall).toBe(1);

    const eventMetric = byType.find((m) => m.dependencyType === "event");
    expect(eventMetric).toBeDefined();
    expect(eventMetric!.precision).toBe(0); // candidate has it, baseline doesn't
    expect(eventMetric!.recall).toBe(1);    // baseline is empty → recall = 1 by convention
  });

  it("different source/target contract IDs produce different keys", () => {
    const candidate = [
      makeDepEdge({ fromRepoId: "r1", toRepoId: "r2", dependencyType: "api", sourceContractId: "c1", targetContractId: "c2" })
    ];
    const baseline = [
      makeDepEdge({ fromRepoId: "r1", toRepoId: "r2", dependencyType: "api", sourceContractId: "c1", targetContractId: "c1" })
    ];

    const { aggregate } = compareDependencySets(candidate, baseline);
    expect(aggregate.truePositive).toBe(0); // different targetContractId → not a match
    expect(aggregate.precision).toBe(0);
    expect(aggregate.recall).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// evaluatePrecisionRecallInMemory
// ---------------------------------------------------------------------------

describe("evaluatePrecisionRecallInMemory", () => {
  it("produces a full report with correct counts", () => {
    const consumer = makeHttpSpec({
      id: "spec:c1", contractId: "c:web:get-orders", repoId: "repo-web",
      method: "GET", path: "/api/orders"
    });
    const producer = makeHttpSpec({
      id: "spec:p1", contractId: "c:order:get-orders", repoId: "repo-orders",
      method: "GET", path: "/api/orders"
    });

    const semanticRels: SemanticRelationEdge[] = [{
      fromSpecId: consumer.id,
      toSpecId: producer.id,
      kind: "CALLS_ENDPOINT",
      evidenceId: "ev:resolver",
      reason: "exact match",
      confidence: 0.95
    }];

    const legacyDeps = [
      makeDepEdge({ fromRepoId: "repo-web", toRepoId: "repo-orders", dependencyType: "api", sourceContractId: consumer.contractId, targetContractId: producer.contractId, evidenceId: "ev:old", raw: "old match" })
    ];

    const report = evaluatePrecisionRecallInMemory(semanticRels, [consumer, producer], legacyDeps);

    expect(report.semanticRelCount).toBe(1);
    expect(report.legacyDepCount).toBe(1);
    expect(report.materializedCount).toBe(1);
    // The comparison key is (fromRepo, toRepo, dependencyType, sourceContractId, targetContractId),
    // NOT evidenceId. Different evidence IDs but same structural match → TP = 1.
    expect(report.aggregate.truePositive).toBe(1);
    expect(report.aggregate.falsePositive).toHaveLength(0);
    expect(report.aggregate.falseNegative).toHaveLength(0);
    expect(report.aggregate.precision).toBe(1);
    expect(report.aggregate.recall).toBe(1);
  });

  it("handles empty inputs", () => {
    const report = evaluatePrecisionRecallInMemory([], [], []);
    expect(report.semanticRelCount).toBe(0);
    expect(report.legacyDepCount).toBe(0);
    expect(report.materializedCount).toBe(0);
    expect(report.aggregate.precision).toBe(1);
    expect(report.aggregate.recall).toBe(1);
  });

  it("report includes per-type breakdowns", () => {
    const consumer = makeHttpSpec({
      id: "spec:c1", contractId: "c:web:get-orders", repoId: "repo-web",
      method: "GET", path: "/api/orders"
    });
    const producer = makeHttpSpec({
      id: "spec:p1", contractId: "c:order:get-orders", repoId: "repo-orders",
      method: "GET", path: "/api/orders"
    });

    const semanticRels: SemanticRelationEdge[] = [{
      fromSpecId: consumer.id, toSpecId: producer.id,
      kind: "CALLS_ENDPOINT", evidenceId: "ev:resolver",
      reason: "exact match", confidence: 0.95
    }];

    // No legacy deps — materialized deps are "extra"
    const report = evaluatePrecisionRecallInMemory(semanticRels, [consumer, producer], []);

    expect(report.byType.length).toBeGreaterThan(0);
    const apiMetric = report.byType.find((m) => m.dependencyType === "api");
    expect(apiMetric).toBeDefined();
    expect(apiMetric!.actual).toBe(1);
    expect(apiMetric!.expected).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// mergeAndDedupeDeps
// ---------------------------------------------------------------------------

describe("mergeAndDedupeDeps", () => {
  const apiDep = (overrides: Partial<RepoDependencyEdge> = {}): RepoDependencyEdge =>
    makeDepEdge({
      fromRepoId: "repo-web", toRepoId: "repo-orders",
      dependencyType: "api", sourceContractId: "c:web:orders", targetContractId: "c:order:orders",
      evidenceId: "ev:1", raw: "test", confidence: 0.9,
      ...overrides
    });

  it("empty inputs produce empty output", () => {
    expect(mergeAndDedupeDeps([], [])).toEqual([]);
  });

  it("semantic-only returns semantic deps", () => {
    const sem = [apiDep({ evidenceId: "ev:sem" })];
    expect(mergeAndDedupeDeps(sem, [])).toEqual(sem);
  });

  it("legacy-only returns legacy deps", () => {
    const leg = [apiDep({ evidenceId: "ev:leg" })];
    expect(mergeAndDedupeDeps([], leg)).toEqual(leg);
  });

  it("semantic takes structural precedence — drops legacy with same structural key", () => {
    const sem = [apiDep({ evidenceId: "ev:sem", confidence: 0.95 })];
    const leg = [apiDep({ evidenceId: "ev:leg", confidence: 0.8 })];

    const result = mergeAndDedupeDeps(sem, leg);

    expect(result).toHaveLength(1);
    expect(result[0]!.evidenceId).toBe("ev:sem");       // semantic wins
    expect(result[0]!.confidence).toBe(0.95);            // semantic's confidence retained
  });

  it("legacy fills gap not covered by semantic", () => {
    const sem = [apiDep({ evidenceId: "ev:sem", sourceContractId: "c:web:orders" })];
    const leg = [
      apiDep({ evidenceId: "ev:leg-other", sourceContractId: "c:web:other", targetContractId: "c:order:other" })
    ];

    const result = mergeAndDedupeDeps(sem, leg);

    // Different structural keys → both survive
    expect(result).toHaveLength(2);
    const evidenceIds = result.map((d) => d.evidenceId);
    expect(evidenceIds).toContain("ev:sem");
    expect(evidenceIds).toContain("ev:leg-other");
  });

  it("mixed coverage — semantic covers api, legacy provides event", () => {
    const sem = [apiDep({ evidenceId: "ev:sem-api" })];
    const leg = [
      apiDep({ evidenceId: "ev:leg-api", confidence: 0.7 }),                        // covered → dropped
      makeDepEdge({ fromRepoId: "repo-web", toRepoId: "repo-orders",                // not covered → kept
        dependencyType: "event", sourceContractId: "c:web:evt", targetContractId: "c:order:evt",
        evidenceId: "ev:leg-event" })
    ];

    const result = mergeAndDedupeDeps(sem, leg);

    expect(result).toHaveLength(2);
    expect(result.map((d) => d.evidenceId).sort()).toEqual(["ev:leg-event", "ev:sem-api"]);
  });

  it("legacy deps with same structure but different evidenceId are both retained (evidence-level dedup only collapses exact evidence duplicates)", () => {
    const sem: RepoDependencyEdge[] = [];
    const leg = [
      apiDep({ evidenceId: "ev:1" }),
      apiDep({ evidenceId: "ev:2" })  // same structural key, different evidenceId
    ];

    const result = mergeAndDedupeDeps(sem, leg);

    // Different evidenceIds → both retained (matching old buildRepoDependenciesFromParticipants behavior).
    expect(result).toHaveLength(2);
  });

  it("exact evidence duplicate within legacy is collapsed", () => {
    const sem: RepoDependencyEdge[] = [];
    const leg = [
      apiDep({ evidenceId: "ev:dup" }),
      apiDep({ evidenceId: "ev:dup" })  // same structural key AND same evidenceId
    ];

    const result = mergeAndDedupeDeps(sem, leg);
    expect(result).toHaveLength(1);
  });

  it("semantic evidence dedup within same structural key", () => {
    const sem = [
      apiDep({ evidenceId: "ev:dup" }),
      apiDep({ evidenceId: "ev:dup" })  // exact duplicate
    ];
    const result = mergeAndDedupeDeps(sem, []);
    expect(result).toHaveLength(1);
  });

  it("different structural keys do not collide even with same evidenceId", () => {
    const sem = [apiDep({ evidenceId: "ev:shared", sourceContractId: "c:web:a", targetContractId: "c:order:a" })];
    const leg = [apiDep({ evidenceId: "ev:shared", sourceContractId: "c:web:b", targetContractId: "c:order:b" })];
    // Different structural keys (different contract pairs), same evidenceId is
    // pathological but should not cause false dedup.
    const result = mergeAndDedupeDeps(sem, leg);
    // Structural keys differ, so legacy dep should NOT be covered by semantic.
    expect(result).toHaveLength(2);
  });

  it("all structural keys covered → only semantic survives", () => {
    const sem = [
      apiDep({ evidenceId: "ev:sem-a" }),
      makeDepEdge({ fromRepoId: "repo-web", toRepoId: "repo-orders",
        dependencyType: "event", sourceContractId: "c:web:evt", targetContractId: "c:order:evt",
        evidenceId: "ev:sem-b" })
    ];
    const leg = [
      apiDep({ evidenceId: "ev:leg-a" }),
      makeDepEdge({ fromRepoId: "repo-web", toRepoId: "repo-orders",
        dependencyType: "event", sourceContractId: "c:web:evt", targetContractId: "c:order:evt",
        evidenceId: "ev:leg-b" })
    ];

    const result = mergeAndDedupeDeps(sem, leg);
    expect(result).toHaveLength(2);
    // All legacy deps dropped — only semantic evidence IDs survive
    expect(result.every((d) => d.evidenceId.startsWith("ev:sem"))).toBe(true);
  });

  it("different sourceContractId produces different structural keys", () => {
    const sem = [apiDep({ evidenceId: "ev:sem", sourceContractId: "c:web:orders", targetContractId: "c:order:orders" })];
    const leg = [apiDep({ evidenceId: "ev:leg", sourceContractId: "c:web:orders-v2", targetContractId: "c:order:orders-v2" })];

    const result = mergeAndDedupeDeps(sem, leg);
    // Different structural keys → legacy NOT covered
    expect(result).toHaveLength(2);
  });
});

describe("structuralKey", () => {
  it("two deps with same repos, type, and contracts produce identical keys", () => {
    const a = makeDepEdge({ fromRepoId: "r1", toRepoId: "r2", dependencyType: "api", sourceContractId: "c1", targetContractId: "c2", evidenceId: "ev:A" });
    const b = makeDepEdge({ fromRepoId: "r1", toRepoId: "r2", dependencyType: "api", sourceContractId: "c1", targetContractId: "c2", evidenceId: "ev:B" });
    expect(structuralKey(a)).toBe(structuralKey(b));
  });

  it("different evidenceId does not affect key", () => {
    const a = makeDepEdge({ fromRepoId: "r1", toRepoId: "r2", dependencyType: "api", sourceContractId: "c1", targetContractId: "c1", evidenceId: "ev:A" });
    const b = makeDepEdge({ fromRepoId: "r1", toRepoId: "r2", dependencyType: "api", sourceContractId: "c1", targetContractId: "c1", evidenceId: "ev:B" });
    expect(structuralKey(a)).toBe("r1:r2:api:c1:c1");
    expect(structuralKey(b)).toBe("r1:r2:api:c1:c1");
  });
});

// ---------------------------------------------------------------------------
// formatPrecisionRecallReport
// ---------------------------------------------------------------------------

describe("formatPrecisionRecallReport", () => {
  it("produces a readable report string", () => {
    const report: PrecisionRecallReport = {
      byType: [{
        dependencyType: "api",
        expected: 5,
        actual: 6,
        truePositive: 5,
        falsePositive: [{ fromRepo: "r3", toRepo: "r4", dependencyType: "api", sourceContractId: "c:extra", targetContractId: "c:extra" }],
        falseNegative: [],
        precision: 0.8333,
        recall: 1,
        f1: 0.9091
      }],
      aggregate: {
        dependencyType: "ALL",
        expected: 5,
        actual: 6,
        truePositive: 5,
        falsePositive: [{ fromRepo: "r3", toRepo: "r4", dependencyType: "api", sourceContractId: "c:extra", targetContractId: "c:extra" }],
        falseNegative: [],
        precision: 0.8333,
        recall: 1,
        f1: 0.9091
      },
      semanticRelCount: 6,
      legacyDepCount: 5,
      materializedCount: 6
    };

    const formatted = formatPrecisionRecallReport(report);

    expect(formatted).toContain("Precision/Recall Calibration Report");
    expect(formatted).toContain("SEMANTIC_REL edges: 6");
    expect(formatted).toContain("Legacy DEPENDS_ON:  5");
    expect(formatted).toContain("Materialized:       6");
    expect(formatted).toContain("P=0.833 R=1.000 F1=0.909");
    expect(formatted).toContain("api");
  });

  it("handles empty report", () => {
    const report: PrecisionRecallReport = {
      byType: [],
      aggregate: {
        dependencyType: "ALL",
        expected: 0, actual: 0, truePositive: 0,
        falsePositive: [], falseNegative: [],
        precision: 1, recall: 1, f1: 0
      },
      semanticRelCount: 0,
      legacyDepCount: 0,
      materializedCount: 0
    };

    const formatted = formatPrecisionRecallReport(report);
    expect(formatted).toContain("Precision/Recall Calibration Report");
    expect(formatted).toContain("SEMANTIC_REL edges: 0");
    expect(formatted).toContain("P=1.000 R=1.000");
  });
});
