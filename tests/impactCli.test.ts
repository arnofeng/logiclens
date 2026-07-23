import { afterEach, describe, expect, it, vi } from "vitest";
import type { SemanticImpactReport } from "../src/core/contracts/impact/semanticImpact.js";
import { printSemanticImpactReport } from "../src/interfaces/cli/impact.js";

function node(input: {
  specId: string;
  repoId: string;
  hop: number;
  summary: string;
  relationKind?: "CALLS_HTTP" | "INTERNAL_CALL" | "CALLS_DUBBO";
  resolution?: "exact" | "probable";
  reason?: string;
  viaSpecId?: string;
}) {
  return {
    contractId: `contract:${input.specId}`,
    specKind: input.relationKind === "CALLS_DUBBO" ? "dubbo-method" : "http-endpoint",
    canonicalKey: input.summary,
    filePath: `${input.repoId}/${input.specId}.ts`,
    confidence: 0.9,
    ...input
  };
}

describe("semantic impact CLI output", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("separates affected consumers from implementation dependencies and prints reasons before children", () => {
    const origin = node({
      specId: "http-producer",
      repoId: "repo:front-service",
      hop: 0,
      summary: "POST /orders"
    });
    const frontend = node({
      specId: "http-consumer",
      repoId: "repo:web-app",
      hop: 1,
      summary: "POST /orders",
      relationKind: "CALLS_HTTP",
      resolution: "exact",
      reason: "Exact method+path match",
      viaSpecId: origin.specId
    });
    const rpcConsumer = node({
      specId: "rpc-consumer",
      repoId: "repo:front-service",
      hop: 1,
      summary: "OrderApi#createOrder",
      relationKind: "INTERNAL_CALL",
      resolution: "exact",
      reason: "Direct contract invocation in parsed source symbol",
      viaSpecId: origin.specId
    });
    const rpcProvider = node({
      specId: "rpc-provider",
      repoId: "repo:center-service",
      hop: 2,
      summary: "OrderApi#createOrder",
      relationKind: "CALLS_DUBBO",
      resolution: "probable",
      reason: "Dubbo method match with group/version unspecified",
      viaSpecId: rpcConsumer.specId
    });
    const report: SemanticImpactReport = {
      target: "POST /orders",
      normalizedTarget: "http:post:/orders",
      maxHops: 3,
      targets: [origin],
      nodes: [origin, frontend, rpcConsumer, rpcProvider],
      edges: [
        {
          fromSpecId: frontend.specId,
          toSpecId: origin.specId,
          kind: "CALLS_HTTP",
          evidenceId: "ev:http",
          resolution: "exact",
          reason: frontend.reason!,
          confidence: 0.95,
          hop: 1
        },
        {
          fromSpecId: origin.specId,
          toSpecId: rpcConsumer.specId,
          kind: "INTERNAL_CALL",
          evidenceId: "ev:internal",
          resolution: "exact",
          reason: rpcConsumer.reason!,
          confidence: 0.9,
          hop: 1
        },
        {
          fromSpecId: rpcConsumer.specId,
          toSpecId: rpcProvider.specId,
          kind: "CALLS_DUBBO",
          evidenceId: "ev:dubbo",
          resolution: "probable",
          reason: rpcProvider.reason!,
          confidence: 0.9,
          hop: 2
        }
      ],
      affectedRepos: ["center-service", "front-service", "web-app"],
      recommendedFiles: [],
      truncated: false
    };
    const output: string[] = [];
    vi.spyOn(console, "log").mockImplementation((value?: unknown) => {
      output.push(value === undefined ? "" : String(value));
    });

    printSemanticImpactReport(report, { showSymbolHint: false, rawTarget: report.target });

    const text = output.join("\n");
    expect(text).toContain("Impact Scope: 3 related repos, 3 related specs");
    expect(text).toContain("Change Origin:\n  - front-service");
    expect(text).toContain("Affected Consumers:\n  - web-app");
    expect(text).toContain("Implementation Dependencies to Inspect:\n  - center-service");
    expect(text).toContain("[impact: affected consumer; via CALLS_HTTP exact]");
    expect(text).toContain("[impact: implementation dependency; via INTERNAL_CALL exact]");
    expect(text).toContain("[impact: implementation dependency; via CALLS_DUBBO probable]");
    expect(text.indexOf(`reason: ${rpcProvider.reason}`)).toBeLessThan(
      text.indexOf("[Hop 2] [implementation dependency]")
    );
  });
});
