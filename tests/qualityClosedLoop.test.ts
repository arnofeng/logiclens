import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { KuzuGraphDB } from "../src/core/graph-model/db.js";
import { auditContractQuality } from "../src/features/quality/qualityRules.js";
import { traceContract } from "../src/core/graph-model/queries.js";
import { retrieveForQuestion } from "../src/features/ask/retrieve.js";
import { BRAND } from "../src/shared/branding.js";

describe("Quality Closed-Loop Test Suite", () => {
  it("runs end-to-end contract quality audits, tracing, and retrieval", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "test-quality-closed-loop-"));
    const db = await KuzuGraphDB.open(path.join(dir, "graph"));
    try {
      await db.initSchema("closed-loop-test");

      const repoA = { id: "repo:service-a", name: "service-a", path: "/path/service-a", remoteUrl: "", branch: "", commitSha: "", language: "java", indexedAt: new Date().toISOString() };
      const repoB = { id: "repo:service-b", name: "service-b", path: "/path/service-b", remoteUrl: "", branch: "", commitSha: "", language: "javascript", indexedAt: new Date().toISOString() };
      await db.upsertRepo(repoA);
      await db.upsertRepo(repoB);

      async function setupContractEvidence(contractNode: any, evidenceNode: any, role: string) {
        await db.upsertContract(contractNode);
        await db.upsertEvidence(evidenceNode);
        await db.addContractEvidence(contractNode.id, evidenceNode.id);
        await db.addRepoEvidence(evidenceNode.repoId, evidenceNode.id);
        await db.addRepoContract({
          repoId: evidenceNode.repoId,
          contractId: contractNode.id,
          role: role as any,
          evidenceId: evidenceNode.id,
          confidence: evidenceNode.confidence,
          batchId: "b1",
          active: true
        });
      }

      // Case 1: Java class-level package contract
      await setupContractEvidence(
        { id: "contract:package:java.util.list", kind: "package", key: "java.util.list", name: "java.util.list", description: "" },
        { id: "evidence:e1", repoId: repoA.id, fileId: "f1", filePath: "Main.java", line: 5, raw: "import java.util.list;", rule: "java-package-path", confidence: 0.9, batchId: "b1", indexedAt: new Date().toISOString(), active: true },
        "owner"
      );

      // Case 2: API contract without leading slash
      await setupContractEvidence(
        { id: "contract:api:smart-backorder-noslash", kind: "api", key: "smart/backorder", name: "smart/backorder", description: "" },
        { id: "evidence:e2", repoId: repoA.id, fileId: "f2", filePath: "Main.java", line: 10, raw: '"smart/backorder"', rule: "spring-mapping", confidence: 0.9, batchId: "b1", indexedAt: new Date().toISOString(), active: true },
        "producer"
      );

      // Case 3: API producer with method path only
      await setupContractEvidence(
        { id: "contract:api:list-method", kind: "api", key: "/list", name: "/list", description: "" },
        { id: "evidence:e3", repoId: repoA.id, fileId: "f3", filePath: "Main.java", line: 15, raw: '"/list"', rule: "spring-mapping", confidence: 0.9, batchId: "b1", indexedAt: new Date().toISOString(), active: true },
        "producer"
      );

      // Case 4: Consumer vs. Producer subpath mismatch (Consumer has /smart/backorder, Producer has /smart/backorder/list)
      await setupContractEvidence(
        { id: "contract:api:smart-backorder-base", kind: "api", key: "/smart/backorder", name: "/smart/backorder", description: "" },
        { id: "evidence:e4", repoId: repoB.id, fileId: "f4", filePath: "client.js", line: 20, raw: '"/smart/backorder"', rule: "js-http", confidence: 0.9, batchId: "b1", indexedAt: new Date().toISOString(), active: true },
        "consumer"
      );

      await setupContractEvidence(
        { id: "contract:api:smart-backorder-list", kind: "api", key: "/smart/backorder/list", name: "/smart/backorder/list", description: "" },
        { id: "evidence:e5", repoId: repoA.id, fileId: "f5", filePath: "Main.java", line: 25, raw: '"/smart/backorder/list"', rule: "spring-mapping", confidence: 0.9, batchId: "b1", indexedAt: new Date().toISOString(), active: true },
        "producer"
      );

      // Case 5: Duplicate API case variations (e.g. /smart/backorder and /smart/Backorder)
      await setupContractEvidence(
        { id: "contract:api:smart-backorder-case", kind: "api", key: "/smart/Backorder", name: "/smart/Backorder", description: "" },
        { id: "evidence:e6", repoId: repoA.id, fileId: "f6", filePath: "Main.java", line: 30, raw: '"/smart/Backorder"', rule: "spring-mapping", confidence: 0.9, batchId: "b1", indexedAt: new Date().toISOString(), active: true },
        "producer"
      );

      // Case 6: Package contract inflation (> 1000)
      for (let i = 0; i < 5; i++) {
        const key = `com.example.pkg${i}`;
        await setupContractEvidence(
          { id: `contract:package:${key}`, kind: "package", key, name: key, description: "" },
          { id: `evidence:epkg${i}`, repoId: repoA.id, fileId: "fpkg", filePath: "Main.java", line: 1, raw: `package ${key}`, rule: "java-package-path", confidence: 0.9, batchId: "b1", indexedAt: new Date().toISOString(), active: true },
          "owner"
        );
      }

      // --- EXECUTE QUALITY AUDIT ---
      const violations = await auditContractQuality(db, { packageInflationLimit: 3 });
      
      const ruleIds = violations.map(v => v.ruleId);
      expect(ruleIds).toContain("java-class-level-package");
      expect(ruleIds).toContain("api-no-leading-slash");
      expect(ruleIds).toContain("api-method-only-producer");
      expect(ruleIds).toContain("api-missing-class-level-mapping");
      expect(ruleIds).toContain("api-case-variations");
      expect(ruleIds).toContain("package-contract-inflation");

      const javaClassViolation = violations.find(v => v.ruleId === "java-class-level-package");
      expect(javaClassViolation?.details).toContain("- java.util.list");

      const noSlashViolation = violations.find(v => v.ruleId === "api-no-leading-slash");
      expect(noSlashViolation?.details).toContain("- smart/backorder");

      // --- VERIFY TRACE TEST ---
      const traces = await traceContract(db, "api", "/smart/backorder/list");
      expect(traces.length).toBe(1);
      expect(traces[0]?.repoName).toBe("service-a");
      expect(traces[0]?.role).toBe("producer");

      // --- VERIFY ASK RETRIEVAL TEST ---
      const retrieval = await retrieveForQuestion(db, "Who calls /smart/backorder?", {
        config: {
          embedding: { level: "off", model: "test", apiKey: "", baseUrl: "" },
          semantic: { provider: "json", jsonPath: `${BRAND.configDirName}/test-semantic-index.json` }
        } as any
      });
      expect(retrieval.contracts.some(c => c.key === "/smart/backorder")).toBe(true);

    } finally {
      await db.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
