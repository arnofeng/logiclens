import { describe, expect, it } from "vitest";
import {
  candidatesFromCodeRows,
  candidatesFromContractRows,
  candidatesFromEntityRows,
  candidatesFromLexicalHits,
  candidatesFromSectionRows,
  candidatesFromSemanticResults,
  stableCandidateKey
} from "../src/features/ask/candidates.js";
import { reciprocalRankFusion } from "../src/features/ask/fusion.js";
import type { LexicalHit } from "../src/core/retrieval/types.js";
import { parseRenderRef } from "../src/core/retrieval/renderRef.js";
import { lexicalDocumentId } from "../src/core/retrieval/projection.js";

describe("retrieval candidates", () => {
  it("uses collision-safe repo/kind/canonical identity", () => {
    expect(stableCandidateKey({ repoId: "a:b", kind: "code", canonicalId: "c" })).not.toBe(
      stableCandidateKey({ repoId: "a", kind: "code", canonicalId: "b:c" })
    );
    expect(stableCandidateKey({ repoId: "repo:a", kind: "code", canonicalId: "same" })).not.toBe(
      stableCandidateKey({ repoId: "repo:a", kind: "section", canonicalId: "same" })
    );
  });

  it("aggregates lexical documents by canonical identity with stable reasons and best rank", () => {
    const hits: LexicalHit[] = [
      { canonicalId: "code:one", documentId: "doc:z", repoId: "repo:a", kind: "code", rank: 3, matchReasons: ["title", "symbol"], renderRef: "ref:a" },
      { canonicalId: "code:one", documentId: "doc:a", repoId: "repo:a", kind: "code", rank: 1, matchReasons: ["symbol", "path"], renderRef: "ref:z" }
    ];
    const result = candidatesFromLexicalHits(hits);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ canonicalId: "code:one", repoId: "repo:a", kind: "code", renderRef: "ref:z" });
    expect(result[0]?.routes).toEqual([{ route: "lexical", rank: 1, documentIds: ["doc:a", "doc:z"] }]);
    expect(result[0]?.matchReasons).toEqual(["path", "symbol", "title"]);
    expect(JSON.stringify(candidatesFromLexicalHits([...hits].reverse()))).toBe(JSON.stringify(result));
  });

  it("converts all legacy routes with canonical graph identities and locations", () => {
    const workspaceId = "workspace:test";
    const code = candidatesFromCodeRows([{
      repoName: "alpha", filePath: "src/Order.ts", codeId: "code:repo:alpha:src/Order.ts:class:Order:1",
      kind: "class", name: "Order", qualifiedName: "Order", summary: "", signature: "class Order"
    }], workspaceId)[0]!;
    const section = candidatesFromSectionRows([{
      repoName: "alpha", filePath: "README.md", sectionId: "section:repo:alpha:README.md:orders:2",
      heading: "Orders", level: 2, startLine: 2, endLine: 8, summary: "", text: "orders"
    }], workspaceId)[0]!;
    const contract = candidatesFromContractRows([{
      contractId: "contract:api:get-orders", kind: "api", key: "GET:/orders", name: "GET /orders", role: "producer",
      repoName: "alpha", filePath: "src/Order.ts", line: 10, evidenceId: "evidence:get-orders",
      raw: "route", rule: "exact-parser-route", confidence: 0.9, resolution: "exact"
    }], workspaceId)[0]!;
    const entity = candidatesFromEntityRows([{
      entityId: "entity:order", entityName: "Order", repoName: "alpha", sourceKind: "code", name: "Order",
      filePath: "src/Order.ts", line: 1, role: "definition", evidence: "class Order", confidence: 0.9
    }], workspaceId)[0]!;
    const semantic = candidatesFromSemanticResults([{
      nodeId: code.canonicalId, nodeKind: "Code", repoId: "repo:alpha", title: "Order", sourceText: "class Order",
      sourceHash: "hash", updatedAt: "2026-01-01T00:00:00.000Z", score: 999
    }])[0]!;

    expect(code.location).toEqual({ fileId: "file:repo:alpha:src/Order.ts", path: "src/Order.ts" });
    expect(code.routes[0]?.documentIds).toEqual([lexicalDocumentId(workspaceId, "repo:alpha", "code", code.canonicalId)]);
    expect(section.location).toMatchObject({ path: "README.md", startLine: 2, endLine: 8 });
    expect(section.routes[0]?.documentIds).toEqual([lexicalDocumentId(workspaceId, "repo:alpha", "section", section.canonicalId)]);
    expect(contract).toMatchObject({ kind: "contract", confidence: "resolved-contract" });
    expect(contract.routes[0]?.documentIds).toEqual([
      lexicalDocumentId(workspaceId, "repo:alpha", "contract", contract.canonicalId, "evidence:get-orders")
    ]);
    expect(entity).toMatchObject({ kind: "entity", canonicalId: "entity:order" });
    expect(stableCandidateKey(semantic)).toBe(stableCandidateKey(code));
    expect(reciprocalRankFusion([code, semantic])[0]?.routes.map(({ route }) => route)).toEqual(["exact", "semantic"]);
  });

  it("does not merge same-named facts across repositories", () => {
    const first = candidatesFromSemanticResults([{
      nodeId: "entity:order", nodeKind: "Entity", repoId: "repo:a", title: "Order", sourceText: "Order", sourceHash: "a", updatedAt: "now", score: 0.1
    }])[0]!;
    const second = candidatesFromSemanticResults([{
      nodeId: "entity:order", nodeKind: "Entity", repoId: "repo:b", title: "Order", sourceText: "Order", sourceHash: "b", updatedAt: "now", score: 100
    }])[0]!;
    expect(reciprocalRankFusion([first, second])).toHaveLength(2);
  });

  it.each([
    ["code", "src/Order.ts", 4, true],
    ["section", "README.md", 8, true],
    ["contract", "src/routes.ts", 12, true],
    ["operation", "", 0, false],
    ["workflow", "", 0, false]
  ] as const)("converts %s entity sources without fabricating file locations", (sourceKind, filePath, line, hasLocation) => {
    const converted = candidatesFromEntityRows([{
      entityId: `entity:${sourceKind}`, entityName: sourceKind, repoName: "alpha", sourceKind,
      name: sourceKind, filePath, line, role: "mention", evidence: sourceKind, confidence: 0.8
    }], "workspace:test")[0]!;
    expect(Boolean(converted.location)).toBe(hasLocation);
    const parsed = parseRenderRef(converted.renderRef!, "workspace:test");
    expect(Boolean(parsed.path)).toBe(hasLocation);
    expect(parsed.canonicalId).toBe(`entity:${sourceKind}`);
  });
});
