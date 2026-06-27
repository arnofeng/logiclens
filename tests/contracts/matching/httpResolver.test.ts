import { describe, expect, it } from "vitest";
import { resolveHttpRelations } from "../../../src/contracts/matching/httpResolver.js";
import type { ContractSpecNode } from "../../../src/parsers/types.js";
import type { SpecRoleMap } from "../../../src/contracts/matching/types.js";
import { serializeSpec } from "../../../src/contracts/spec.js";

function makeHttpSpec(opts: {
  id: string;
  contractId: string;
  repoId: string;
  method?: string;
  path: string;
  pathTemplate?: string;
  evidenceId?: string;
  role?: string;
}): ContractSpecNode {
  const spec: ContractSpecNode = {
    id: opts.id,
    contractId: opts.contractId,
    specKind: "http-endpoint",
    repoId: opts.repoId,
    fileId: `file:${opts.repoId}:some/path`,
    evidenceId: opts.evidenceId ?? `ev:${opts.id}`,
    canonicalKey: opts.method
      ? `${opts.method}:${opts.pathTemplate ?? opts.path}`
      : (opts.pathTemplate ?? opts.path),
    httpMethod: opts.method,
    pathTemplate: opts.pathTemplate ?? opts.path,
    specJson: serializeSpec({
      kind: "http-endpoint",
      method: opts.method as any,
      path: opts.path,
      pathTemplate: opts.pathTemplate ?? opts.path,
      pathParams: [],
      auth: "unknown" as const
    }),
    confidence: 0.9
  };
  return spec;
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

describe("HTTP Resolver", () => {
  it("matches exact method+path (CALLS_ENDPOINT)", () => {
    const producer = makeHttpSpec({
      id: "spec:p1", contractId: "c:p1", repoId: "repo-orders",
      method: "GET", path: "/api/orders"
    });
    const consumer = makeHttpSpec({
      id: "spec:c1", contractId: "c:c1", repoId: "repo-web",
      method: "GET", path: "/api/orders"
    });
    const roleMap = makeRoleMap([producer, consumer], { "spec:p1": "producer", "spec:c1": "consumer" });

    const edges = resolveHttpRelations([producer, consumer], roleMap);
    expect(edges).toHaveLength(1);
    expect(edges[0]!.fromSpecId).toBe(consumer.id);
    expect(edges[0]!.toSpecId).toBe(producer.id);
    expect(edges[0]!.kind).toBe("CALLS_ENDPOINT");
    expect(edges[0]!.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("matches path-only when one side lacks method", () => {
    const producer = makeHttpSpec({
      id: "spec:p1", contractId: "c:p1", repoId: "repo-orders",
      method: "GET", path: "/api/orders"
    });
    const consumer = makeHttpSpec({
      id: "spec:c1", contractId: "c:c1", repoId: "repo-web",
      method: undefined, path: "/api/orders"
    });
    const roleMap = makeRoleMap([producer, consumer], { "spec:p1": "producer", "spec:c1": "consumer" });

    const edges = resolveHttpRelations([producer, consumer], roleMap);
    expect(edges).toHaveLength(1);
    expect(edges[0]!.kind).toBe("CALLS_ENDPOINT");
    expect(edges[0]!.confidence).toBe(0.75); // path-only-match
  });

  it("matches template-compatible (both have templates)", () => {
    const producer = makeHttpSpec({
      id: "spec:p1", contractId: "c:p1", repoId: "repo-orders",
      method: "GET", path: "/api/orders/{id}", pathTemplate: "/api/orders/{id}"
    });
    const consumer = makeHttpSpec({
      id: "spec:c1", contractId: "c:c1", repoId: "repo-web",
      method: "GET", path: "/api/orders/{orderId}", pathTemplate: "/api/orders/{orderId}"
    });
    const roleMap = makeRoleMap([producer, consumer], { "spec:p1": "producer", "spec:c1": "consumer" });

    const edges = resolveHttpRelations([producer, consumer], roleMap);
    expect(edges).toHaveLength(1);
    expect(edges[0]!.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("matches static-to-template (static path fits template)", () => {
    const producer = makeHttpSpec({
      id: "spec:p1", contractId: "c:p1", repoId: "repo-orders",
      method: "GET", path: "/api/users/42", pathTemplate: "/api/users/42"
    });
    const consumer = makeHttpSpec({
      id: "spec:c1", contractId: "c:c1", repoId: "repo-web",
      method: "GET", path: "/api/users/{id}", pathTemplate: "/api/users/{id}"
    });
    const roleMap = makeRoleMap([producer, consumer], { "spec:p1": "producer", "spec:c1": "consumer" });

    const edges = resolveHttpRelations([producer, consumer], roleMap);
    expect(edges).toHaveLength(1);
    expect(edges[0]!.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("does NOT match different paths", () => {
    const producer = makeHttpSpec({
      id: "spec:p1", contractId: "c:p1", repoId: "repo-orders",
      method: "GET", path: "/api/orders"
    });
    const consumer = makeHttpSpec({
      id: "spec:c1", contractId: "c:c1", repoId: "repo-web",
      method: "POST", path: "/api/users"
    });
    const roleMap = makeRoleMap([producer, consumer], { "spec:p1": "producer", "spec:c1": "consumer" });

    const edges = resolveHttpRelations([producer, consumer], roleMap);
    expect(edges).toHaveLength(0);
  });

  it("does NOT match when segment count differs", () => {
    const producer = makeHttpSpec({
      id: "spec:p1", contractId: "c:p1", repoId: "repo-orders",
      method: "GET", path: "/api/users/{id}", pathTemplate: "/api/users/{id}"
    });
    const consumer = makeHttpSpec({
      id: "spec:c1", contractId: "c:c1", repoId: "repo-web",
      method: "GET", path: "/api/users/{id}/posts", pathTemplate: "/api/users/{id}/posts"
    });
    const roleMap = makeRoleMap([producer, consumer], { "spec:p1": "producer", "spec:c1": "consumer" });

    const edges = resolveHttpRelations([producer, consumer], roleMap);
    expect(edges).toHaveLength(0);
  });

  it("skips same-repo pairs", () => {
    const producer = makeHttpSpec({
      id: "spec:p1", contractId: "c:p1", repoId: "repo-same",
      method: "GET", path: "/api/orders"
    });
    const consumer = makeHttpSpec({
      id: "spec:c1", contractId: "c:c1", repoId: "repo-same",
      method: "GET", path: "/api/orders"
    });
    const roleMap = makeRoleMap([producer, consumer], { "spec:p1": "producer", "spec:c1": "consumer" });

    const edges = resolveHttpRelations([producer, consumer], roleMap);
    expect(edges).toHaveLength(0);
  });

  it("handles empty input gracefully", () => {
    const edges = resolveHttpRelations([], new Map());
    expect(edges).toHaveLength(0);
  });

  it("handles non-http specs (they are filtered out)", () => {
    const spec: ContractSpecNode = {
      id: "spec:1", contractId: "c:1", specKind: "event",
      repoId: "repo-a", fileId: "f:1", evidenceId: "ev:1",
      canonicalKey: "order.created", eventTopic: "order.created",
      specJson: serializeSpec({ kind: "event", topic: "order.created" }),
      confidence: 0.9
    };
    const edges = resolveHttpRelations([spec], new Map());
    expect(edges).toHaveLength(0);
  });

  it("buckets specs by first path segment correctly", () => {
    const bucket1Producer = makeHttpSpec({
      id: "spec:p1", contractId: "c:p1", repoId: "repo-a",
      method: "GET", path: "/api/orders"
    });
    const bucket1Consumer = makeHttpSpec({
      id: "spec:c1", contractId: "c:c1", repoId: "repo-b",
      method: "GET", path: "/api/orders"
    });
    const bucket2Consumer = makeHttpSpec({
      id: "spec:c2", contractId: "c:c2", repoId: "repo-c",
      method: "GET", path: "/other/users"
    });
    const roleMap = makeRoleMap(
      [bucket1Producer, bucket1Consumer, bucket2Consumer],
      { "spec:p1": "producer", "spec:c1": "consumer", "spec:c2": "consumer" }
    );

    const edges = resolveHttpRelations(
      [bucket1Producer, bucket1Consumer, bucket2Consumer],
      roleMap
    );
    // bucket2Consumer is in /other bucket, producer is in /api bucket — no match
    expect(edges).toHaveLength(1);
    expect(edges[0]!.fromSpecId).toBe(bucket1Consumer.id);
    expect(edges[0]!.toSpecId).toBe(bucket1Producer.id);
  });

  it("matches wildcard when first segment is a template param", () => {
    const producer = makeHttpSpec({
      id: "spec:p1", contractId: "c:p1", repoId: "repo-a",
      method: "GET", path: "/{tenant}/orders", pathTemplate: "/{tenant}/orders"
    });
    const consumer = makeHttpSpec({
      id: "spec:c1", contractId: "c:c1", repoId: "repo-b",
      method: "GET", path: "/acme/orders", pathTemplate: "/acme/orders"
    });
    const roleMap = makeRoleMap([producer, consumer], { "spec:p1": "producer", "spec:c1": "consumer" });

    const edges = resolveHttpRelations([producer, consumer], roleMap);
    // Wildcard first segment: /{tenant}/orders and /acme/orders have different
    // first segments, so bucket keys differ. But the template-first-segment spec
    // goes to the "*" catch-all bucket and the static spec matches there.
    expect(edges).toHaveLength(1);
  });

  it("does NOT match static-to-template when methods differ", () => {
    const producer = makeHttpSpec({
      id: "spec:p1", contractId: "c:p1", repoId: "repo-orders",
      method: "DELETE", path: "/api/orders/{id}", pathTemplate: "/api/orders/{id}"
    });
    const consumer = makeHttpSpec({
      id: "spec:c1", contractId: "c:c1", repoId: "repo-web",
      method: "GET", path: "/api/orders/42", pathTemplate: "/api/orders/42"
    });
    const roleMap = makeRoleMap([producer, consumer], { "spec:p1": "producer", "spec:c1": "consumer" });

    const edges = resolveHttpRelations([producer, consumer], roleMap);
    expect(edges).toHaveLength(0);
  });

  it("does NOT match template-compatible when methods differ", () => {
    const producer = makeHttpSpec({
      id: "spec:p1", contractId: "c:p1", repoId: "repo-orders",
      method: "POST", path: "/api/orders/{id}", pathTemplate: "/api/orders/{id}"
    });
    const consumer = makeHttpSpec({
      id: "spec:c1", contractId: "c:c1", repoId: "repo-web",
      method: "GET", path: "/api/orders/{orderId}", pathTemplate: "/api/orders/{orderId}"
    });
    const roleMap = makeRoleMap([producer, consumer], { "spec:p1": "producer", "spec:c1": "consumer" });

    const edges = resolveHttpRelations([producer, consumer], roleMap);
    expect(edges).toHaveLength(0);
  });

  it("does NOT match wildcard when methods differ", () => {
    const producer = makeHttpSpec({
      id: "spec:p1", contractId: "c:p1", repoId: "repo-a",
      method: "POST", path: "/{tenant}/orders", pathTemplate: "/{tenant}/orders"
    });
    const consumer = makeHttpSpec({
      id: "spec:c1", contractId: "c:c1", repoId: "repo-b",
      method: "GET", path: "/acme/orders", pathTemplate: "/acme/orders"
    });
    const roleMap = makeRoleMap([producer, consumer], { "spec:p1": "producer", "spec:c1": "consumer" });

    const edges = resolveHttpRelations([producer, consumer], roleMap);
    expect(edges).toHaveLength(0);
  });
});
