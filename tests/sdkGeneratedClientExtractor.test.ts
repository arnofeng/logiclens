import { extractFacts } from "./helpers/extractFacts.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sdkGeneratedClientExtractor } from "../src/core/contracts/extraction/builtin/sdkGeneratedClientExtractor.js";
import { parseSourceFile } from "../src/core/parsing/parserRegistry.js";
import type { ParsedFile } from "../src/core/parsing/types.js";
import { repoId } from "../src/shared/path.js";

describe("generated SDK client extractor", () => {
  it("preserves the import-construction-call-bridge evidence chain", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "test-sdk-generated-client-"));
    try {
      const repo = {
        id: repoId("sdk-generated-client"),
        name: "sdk-generated-client",
        path: dir,
        remoteUrl: "",
        branch: "",
        commitSha: "",
        language: "typescript",
        indexedAt: "now"
      } as any;
      const generatedPath = path.join(dir, "generated.ts");
      const consumerPath = path.join(dir, "consumer.ts");
      await fs.writeFile(
        generatedPath,
        "export class OrdersClient { getOrder() { return request({ url: '/api/orders/:id' }); } }\n",
        "utf8"
      );
      await fs.writeFile(
        consumerPath,
        "import { OrdersClient } from './generated';\nexport function loadOrder() { const client = new OrdersClient(); return client.getOrder(); }\n",
        "utf8"
      );
      const parsedFiles = await Promise.all([
        parseSourceFile({ repoId: repo.id, absolutePath: generatedPath, relativePath: "generated.ts", language: "typescript" }),
        parseSourceFile({ repoId: repo.id, absolutePath: consumerPath, relativePath: "consumer.ts", language: "typescript" })
      ]) as ParsedFile[];

      const bundle = await extractFacts(sdkGeneratedClientExtractor, { repos: [repo], parsedFiles, repoResolver: () => repo });

      expect(bundle.contracts).toEqual([expect.objectContaining({ kind: "api", key: "/api/orders/{id}" })]);
      expect(bundle.repoContracts).toEqual([expect.objectContaining({ role: "consumer" })]);
      expect(bundle.evidence).toEqual([expect.objectContaining({
        rule: "sdk-generated-client-consumer",
        raw: expect.stringContaining("client.getOrder()")
      })]);
      expect(bundle.contractSpecs).toEqual([expect.objectContaining({
        specKind: "http-endpoint",
        pathTemplate: "/api/orders/{id}"
      })]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
