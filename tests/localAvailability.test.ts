import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { KuzuGraphDB } from "../src/core/graph-model/db.js";
import { traceContract } from "../src/core/graph-model/queries.js";
import { upsertParsedFiles } from "../src/core/graph-model/upsert.js";
import { parseSourceFile } from "../src/core/parsing/parserRegistry.js";
import { retrieveForQuestion } from "../src/features/ask/retrieve.js";
import { answerQuestion } from "../src/features/ask/answer.js";
import { repoId } from "../src/shared/path.js";

describe("local availability", () => {
  it("indexes, queries, and answers cross-repo graph data without OPENAI_API_KEY", async () => {
    const originalKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-local-"));
    try {
      const db = await KuzuGraphDB.open(path.join(dir, "graph"));
      try {
        await db.initSchema("local-test");
        const repoA = { id: repoId("service-a"), name: "service-a", path: path.resolve("tests/fixtures/service-a"), remoteUrl: "", branch: "", commitSha: "", language: "typescript", indexedAt: new Date().toISOString() };
        const repoB = { id: repoId("service-b"), name: "service-b", path: path.resolve("tests/fixtures/service-b"), remoteUrl: "", branch: "", commitSha: "", language: "typescript", indexedAt: new Date().toISOString() };
        const repoC = { id: repoId("service-c"), name: "service-c", path: path.resolve("tests/fixtures/service-c"), remoteUrl: "", branch: "", commitSha: "", language: "javascript", indexedAt: new Date().toISOString() };
        await db.upsertRepo(repoA);
        await db.upsertRepo(repoB);
        await db.upsertRepo(repoC);
        const parsed = await Promise.all([
          parseSourceFile({ repoId: repoA.id, absolutePath: path.resolve("tests/fixtures/service-a/src/OrderController.ts"), relativePath: "src/OrderController.ts", language: "typescript" }),
          parseSourceFile({ repoId: repoA.id, absolutePath: path.resolve("tests/fixtures/service-a/src/OrderService.ts"), relativePath: "src/OrderService.ts", language: "typescript" }),
          parseSourceFile({ repoId: repoB.id, absolutePath: path.resolve("tests/fixtures/service-b/src/PaymentService.ts"), relativePath: "src/PaymentService.ts", language: "typescript" }),
          parseSourceFile({ repoId: repoB.id, absolutePath: path.resolve("tests/fixtures/service-b/src/events/OrderCreatedEvent.ts"), relativePath: "src/events/OrderCreatedEvent.ts", language: "typescript" }),
          parseSourceFile({ repoId: repoB.id, absolutePath: path.resolve("tests/fixtures/service-b/README.md"), relativePath: "README.md", language: "markdown" }),
          parseSourceFile({ repoId: repoC.id, absolutePath: path.resolve("tests/fixtures/service-c/src/InventoryService.js"), relativePath: "src/InventoryService.js", language: "javascript" }),
          parseSourceFile({ repoId: repoC.id, absolutePath: path.resolve("tests/fixtures/service-c/src/InventoryPanel.jsx"), relativePath: "src/InventoryPanel.jsx", language: "jsx" })
        ]);
        await upsertParsedFiles(db, parsed, { semantic: true }, [repoA, repoB, repoC]);

        const dependencies = await db.query<{ count: number }>("MATCH (:Repo)-[d:DEPENDS_ON]->(:Repo) RETURN count(d) AS count;");
        expect(Number(dependencies[0]?.count ?? 0)).toBeGreaterThan(0);

        const apiTrace = await traceContract(db, "api", "/api/order/:id");
        expect(apiTrace).toEqual(expect.arrayContaining([
          expect.objectContaining({ repoName: "service-a", role: "producer" }),
          expect.objectContaining({ repoName: "service-b", role: "consumer" })
        ]));

        const retrieval = await retrieveForQuestion(db, "OrderCreatedEvent");
        const answer = await answerQuestion("OrderCreatedEvent", retrieval, "gpt-4.1-mini", undefined, undefined);
        expect(answer).toContain("Matched code:");
        expect(answer).toContain("Call edges:");

        const summaries = await db.query<{ repoSummary: string; systemSummary: string }>(
          "MATCH (r:Repo), (s:System) RETURN r.summary AS repoSummary, s.summary AS systemSummary LIMIT 1;"
        );
        expect(summaries[0]?.repoSummary.length ?? 0).toBeGreaterThan(0);
        expect(summaries[0]?.systemSummary).toContain("System contains 3 indexed repositories");
      } finally {
        await db.close();
      }
    } finally {
      if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = originalKey;
    }
  }, 20000);
});
