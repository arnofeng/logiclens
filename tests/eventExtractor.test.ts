import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseSourceFile } from "../src/parsers/parserRegistry.js";
import { eventExtractor } from "../src/extractors/builtin/eventExtractor.js";
import { repoId } from "../src/utils/path.js";
import type { ExtractedRelation } from "../src/extractors/crossRepoContracts.js";

function isRepoContractRelation(relation: ExtractedRelation): relation is ExtractedRelation & { kind: "repo-contract" } {
  return relation.kind === "repo-contract";
}

describe("Event Extractor", () => {
  it("extracts event publisher and subscriber contracts using AST", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-event-test-"));
    const sourcePath = path.join(dir, "main.ts");
    await fs.writeFile(
      sourcePath,
      `
      // Producers
      eventBus.publish('user.registered', { id: 123 });
      emitter.emit("order.created");
      channel.send(\`message.sent\`);

      // Consumers
      eventBus.subscribe('user.registered', (msg) => {});
      emitter.on("order.created", () => {});
      channel.consume('message.sent', (data) => {});

      // Ignored dynamic or non-string calls
      emitter.emit(dynamicTopic);
      eventBus.publish(12345);
      send("not.event");
      `,
      "utf8"
    );

    const parsed = await parseSourceFile({
      repoId: repoId("event-test"),
      absolutePath: sourcePath,
      relativePath: "main.ts",
      language: "typescript"
    });

    const context = {
      repos: [{ id: "event-test", name: "event-test", path: dir } as any],
      parsedFiles: [parsed],
      repoResolver: () => null as any
    };

    const extracted = await eventExtractor.extract(context);

    // 1. Verify Contracts
    const contractKeys = extracted.contracts.map((c) => c.key);
    const uniqueKeys = [...new Set(contractKeys)];
    expect(uniqueKeys.length).toBe(3);
    expect(uniqueKeys).toContain("user.registered");
    expect(uniqueKeys).toContain("order.created");
    expect(uniqueKeys).toContain("message.sent");
    expect(uniqueKeys).not.toContain("not.event");

    // 2. Verify Relations (repo-contracts)
    const repoContracts = extracted.relations.filter(isRepoContractRelation);
    expect(repoContracts.length).toBe(6);

    const producers = repoContracts.filter((r) => r.role === "producer");
    const consumers = repoContracts.filter((r) => r.role === "consumer");

    expect(producers.length).toBe(3);
    expect(consumers.length).toBe(3);

    const producerContractIds = producers.map((p) => p.contractId);
    expect(producerContractIds).toContain("contract:event:user.registered");
    expect(producerContractIds).toContain("contract:event:order.created");
    expect(producerContractIds).toContain("contract:event:message.sent");

    const consumerContractIds = consumers.map((c) => c.contractId);
    expect(consumerContractIds).toContain("contract:event:user.registered");
    expect(consumerContractIds).toContain("contract:event:order.created");
    expect(consumerContractIds).toContain("contract:event:message.sent");

    // 3. Verify Evidence
    expect(extracted.evidence.length).toBe(6);

    // Check exact line numbers and rules
    const signupProducer = extracted.evidence.find(
      (e) => e.raw.includes("publish") && e.raw.includes("user.registered")
    );
    expect(signupProducer).toBeDefined();
    expect(signupProducer?.line).toBe(3);
    expect(signupProducer?.rule).toBe("event-publisher");

    const signupConsumer = extracted.evidence.find(
      (e) => e.raw.includes("subscribe") && e.raw.includes("user.registered")
    );
    expect(signupConsumer).toBeDefined();
    expect(signupConsumer?.line).toBe(8);
    expect(signupConsumer?.rule).toBe("event-consumer");

    await fs.rm(dir, { recursive: true, force: true });
  });
});
