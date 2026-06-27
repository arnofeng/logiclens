import { describe, expect, it } from "vitest";
import { resolveEventRelations } from "../../../src/contracts/matching/eventResolver.js";
import type { ContractSpecNode } from "../../../src/parsers/types.js";
import type { SpecRoleMap } from "../../../src/contracts/matching/types.js";
import { serializeSpec } from "../../../src/contracts/spec.js";
import { canonicalEventContractKey } from "../../../src/contracts/event.js";

function makeEventSpec(opts: {
  id: string;
  contractId: string;
  repoId: string;
  topic: string;
  payloadType?: string;
  broker?: string;
  evidenceId?: string;
  role?: string;
}): ContractSpecNode {
  const topic = canonicalEventContractKey(opts.topic);
  return {
    id: opts.id,
    contractId: opts.contractId,
    specKind: "event",
    repoId: opts.repoId,
    fileId: `file:${opts.repoId}:some/path`,
    evidenceId: opts.evidenceId ?? `ev:${opts.id}`,
    canonicalKey: topic,
    eventTopic: topic,
    specJson: serializeSpec({
      kind: "event",
      topic,
      payloadType: opts.payloadType,
      broker: (opts.broker as any) ?? "unknown"
    }),
    confidence: 0.85
  };
}

function makeRoleMap(
  specs: ContractSpecNode[],
  roles: Record<string, string>
): SpecRoleMap {
  const map: SpecRoleMap = new Map();
  for (const spec of specs) {
    const role = roles[spec.id] ?? "producer";
    map.set(`${spec.contractId}:${spec.repoId}`, role as any);
    map.set(spec.contractId, role as any);
  }
  return map;
}

describe("Event Resolver", () => {
  it("matches producer→consumer on same topic (PUBLISHES_EVENT + SUBSCRIBES_EVENT)", () => {
    const producer = makeEventSpec({
      id: "spec:p1", contractId: "c:p1", repoId: "repo-orders",
      topic: "order.created", payloadType: "OrderEvent"
    });
    const consumer = makeEventSpec({
      id: "spec:c1", contractId: "c:c1", repoId: "repo-notify",
      topic: "order.created", payloadType: "OrderEvent"
    });
    const roleMap = makeRoleMap([producer, consumer], { "spec:p1": "producer", "spec:c1": "consumer" });

    const edges = resolveEventRelations([producer, consumer], roleMap);
    expect(edges).toHaveLength(2);

    const pubEdge = edges.find((e) => e.kind === "PUBLISHES_EVENT");
    const subEdge = edges.find((e) => e.kind === "SUBSCRIBES_EVENT");
    expect(pubEdge).toBeDefined();
    expect(subEdge).toBeDefined();
    expect(pubEdge!.fromSpecId).toBe(producer.id);
    expect(pubEdge!.toSpecId).toBe(consumer.id);
    expect(subEdge!.fromSpecId).toBe(consumer.id);
    expect(subEdge!.toSpecId).toBe(producer.id);
  });

  it("matches topic case-insensitively", () => {
    const producer = makeEventSpec({
      id: "spec:p1", contractId: "c:p1", repoId: "repo-a",
      topic: "Order.Created"
    });
    const consumer = makeEventSpec({
      id: "spec:c1", contractId: "c:c1", repoId: "repo-b",
      topic: "order.created"
    });
    const roleMap = makeRoleMap([producer, consumer], { "spec:p1": "producer", "spec:c1": "consumer" });

    const edges = resolveEventRelations([producer, consumer], roleMap);
    expect(edges.length).toBeGreaterThanOrEqual(2);
  });

  it("does NOT match different topics", () => {
    const producer = makeEventSpec({
      id: "spec:p1", contractId: "c:p1", repoId: "repo-a",
      topic: "order.created"
    });
    const consumer = makeEventSpec({
      id: "spec:c1", contractId: "c:c1", repoId: "repo-b",
      topic: "user.registered"
    });
    const roleMap = makeRoleMap([producer, consumer], { "spec:p1": "producer", "spec:c1": "consumer" });

    const edges = resolveEventRelations([producer, consumer], roleMap);
    expect(edges).toHaveLength(0);
  });

  it("downgrades confidence when payload types differ", () => {
    const producer = makeEventSpec({
      id: "spec:p1", contractId: "c:p1", repoId: "repo-a",
      topic: "order.created", payloadType: "OrderCreatedV1"
    });
    const consumer = makeEventSpec({
      id: "spec:c1", contractId: "c:c1", repoId: "repo-b",
      topic: "order.created", payloadType: "OrderCreatedV2"
    });
    const roleMap = makeRoleMap([producer, consumer], { "spec:p1": "producer", "spec:c1": "consumer" });

    const edges = resolveEventRelations([producer, consumer], roleMap);
    expect(edges.length).toBeGreaterThan(0);
    for (const edge of edges) {
      expect(edge.confidence).toBe(0.85); // topic match but payload differs
    }
  });

  it("skips same-repo pairs", () => {
    const producer = makeEventSpec({
      id: "spec:p1", contractId: "c:p1", repoId: "repo-same",
      topic: "order.created"
    });
    const consumer = makeEventSpec({
      id: "spec:c1", contractId: "c:c1", repoId: "repo-same",
      topic: "order.created"
    });
    const roleMap = makeRoleMap([producer, consumer], { "spec:p1": "producer", "spec:c1": "consumer" });

    const edges = resolveEventRelations([producer, consumer], roleMap);
    expect(edges).toHaveLength(0);
  });

  it("handles empty input gracefully", () => {
    const edges = resolveEventRelations([], new Map());
    expect(edges).toHaveLength(0);
  });

  it("handles non-event specs (filtered out)", () => {
    const spec: ContractSpecNode = {
      id: "spec:1", contractId: "c:1", specKind: "http-endpoint",
      repoId: "repo-a", fileId: "f:1", evidenceId: "ev:1",
      canonicalKey: "GET:/api/test", httpMethod: "GET", pathTemplate: "/api/test",
      specJson: serializeSpec({
        kind: "http-endpoint", method: "GET", path: "/api/test",
        pathTemplate: "/api/test", pathParams: [], auth: "unknown"
      }),
      confidence: 0.9
    };
    const edges = resolveEventRelations([spec], new Map());
    expect(edges).toHaveLength(0);
  });
});
