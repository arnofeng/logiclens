import { describe, expect, it } from "vitest";
import { resolveDubboRelations } from "../../../src/core/contracts/matching/dubboResolver.js";
import type { SpecRoleMap } from "../../../src/core/contracts/matching/types.js";
import { serializeSpec } from "../../../src/core/contracts/spec.js";
import type { ContractSpecNode } from "../../../src/core/parsing/types.js";

function makeDubboSpec(opts: {
  id: string;
  contractId: string;
  repoId: string;
  interfaceName: string;
  method: string;
  role?: "producer" | "consumer" | "shared";
  group?: string;
  version?: string;
}): ContractSpecNode {
  return {
    id: opts.id,
    contractId: opts.contractId,
    specKind: "dubbo-method",
    repoId: opts.repoId,
    fileId: `file:${opts.repoId}:dubbo`,
    evidenceId: `ev:${opts.id}`,
    canonicalKey: `${opts.interfaceName.toLowerCase()}#${opts.method}`,
    specJson: serializeSpec({
      kind: "dubbo-method",
      interfaceName: opts.interfaceName,
      method: opts.method,
      fullName: `${opts.interfaceName}#${opts.method}`,
      group: opts.group,
      version: opts.version,
      config: "annotation",
      framework: "dubbo-java"
    }),
    confidence: 0.9
  };
}

function makeRoleMap(specs: ContractSpecNode[], roles: Record<string, string>): SpecRoleMap {
  const map: SpecRoleMap = new Map();
  for (const spec of specs) {
    map.set(`${spec.contractId}:${spec.repoId}`, (roles[spec.id] ?? "shared") as any);
  }
  return map;
}

describe("Dubbo Resolver", () => {
  it("matches consumers and producers by interface FQN and method", () => {
    const producer = makeDubboSpec({
      id: "spec-p",
      contractId: "c-p",
      repoId: "repo-provider",
      interfaceName: "com.acme.api.OrderService",
      method: "createOrder",
      group: "orders",
      version: "1.0.0"
    });
    const consumer = makeDubboSpec({
      id: "spec-c",
      contractId: "c-c",
      repoId: "repo-consumer",
      interfaceName: "com.acme.api.OrderService",
      method: "createOrder",
      group: "orders",
      version: "1.0.0"
    });

    const edges = resolveDubboRelations([producer, consumer], makeRoleMap([producer, consumer], {
      "spec-p": "producer",
      "spec-c": "consumer"
    }));

    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      fromSpecId: "spec-c",
      toSpecId: "spec-p",
      kind: "CALLS_ENDPOINT",
      confidence: 0.95
    });
  });

  it("treats owner specs as producers", () => {
    const owner = makeDubboSpec({ id: "spec-owner", contractId: "c-owner", repoId: "repo-provider", interfaceName: "com.acme.api.OrderService", method: "createOrder" });
    const consumer = makeDubboSpec({ id: "spec-c", contractId: "c-c", repoId: "repo-consumer", interfaceName: "com.acme.api.OrderService", method: "createOrder" });
    const edges = resolveDubboRelations([owner, consumer], makeRoleMap([owner, consumer], {
      "spec-owner": "owner",
      "spec-c": "consumer"
    }));

    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ fromSpecId: consumer.id, toSpecId: owner.id });
  });

  it("skips same-repo pairs", () => {
    const producer = makeDubboSpec({ id: "spec-p", contractId: "c-p", repoId: "repo-a", interfaceName: "com.acme.OrderService", method: "createOrder" });
    const consumer = makeDubboSpec({ id: "spec-c", contractId: "c-c", repoId: "repo-a", interfaceName: "com.acme.OrderService", method: "createOrder" });
    const edges = resolveDubboRelations([producer, consumer], makeRoleMap([producer, consumer], {
      "spec-p": "producer",
      "spec-c": "consumer"
    }));
    expect(edges).toHaveLength(0);
  });

  it("downgrades but keeps group/version mismatches", () => {
    const producer = makeDubboSpec({ id: "spec-p", contractId: "c-p", repoId: "repo-p", interfaceName: "com.acme.OrderService", method: "createOrder", group: "orders" });
    const consumer = makeDubboSpec({ id: "spec-c", contractId: "c-c", repoId: "repo-c", interfaceName: "com.acme.OrderService", method: "createOrder", group: "legacy" });
    const edges = resolveDubboRelations([producer, consumer], makeRoleMap([producer, consumer], {
      "spec-p": "producer",
      "spec-c": "consumer"
    }));
    expect(edges).toHaveLength(1);
    expect(edges[0]!.confidence).toBe(0.8);
  });

  it("supports XML interface-level fallback", () => {
    const producer = makeDubboSpec({ id: "spec-p", contractId: "c-p", repoId: "repo-p", interfaceName: "com.acme.OrderService", method: "*" });
    const consumer = makeDubboSpec({ id: "spec-c", contractId: "c-c", repoId: "repo-c", interfaceName: "com.acme.OrderService", method: "createOrder" });
    const edges = resolveDubboRelations([producer, consumer], makeRoleMap([producer, consumer], {
      "spec-p": "producer",
      "spec-c": "consumer"
    }));
    expect(edges).toHaveLength(1);
    expect(edges[0]!.confidence).toBe(0.6);
  });
});
