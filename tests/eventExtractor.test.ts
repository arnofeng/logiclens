import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseSourceFile } from "../src/core/parsing/parserRegistry.js";
import { eventExtractor } from "../src/core/contracts/extraction/builtin/eventExtractor.js";
import { canonicalEventContractKey, inferBrokerFromCallee } from "../src/core/contracts/event.js";
import { buildGraphFactsBatch } from "../src/core/graph-model/facts.js";
import { KuzuGraphDB } from "../src/core/graph-model/db.js";
import { writeGraphFactsWithMerge } from "../src/core/graph-model/upsert.js";
import { repoId } from "../src/shared/path.js";
import type { ExtractedRelation } from "../src/core/contracts/extraction/crossRepoContracts.js";
import type { ExtractorFactBundle } from "../src/core/contracts/extraction/crossRepoContracts.js";

function isRepoContractRelation(relation: ExtractedRelation): relation is ExtractedRelation & { kind: "repo-contract" } {
  return relation.kind === "repo-contract";
}

async function extractEvents(source: string): Promise<ExtractorFactBundle> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-event-unit-"));
  const sourcePath = path.join(dir, "main.ts");
  await fs.writeFile(sourcePath, source, "utf8");
  const repo = { id: repoId("event-unit"), name: "event-unit", path: dir, remoteUrl: "", branch: "", commitSha: "", language: "typescript", indexedAt: "now" } as any;
  const parsed = await parseSourceFile({ repoId: repo.id, absolutePath: sourcePath, relativePath: "main.ts", language: "typescript" });
  const bundle = await eventExtractor.extract({ repos: [repo], parsedFiles: [parsed], repoResolver: () => repo });
  await fs.rm(dir, { recursive: true, force: true });
  return bundle;
}

describe("Event Extractor", () => {
  it("extracts event publisher and subscriber contracts using AST", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-event-test-"));
    const sourcePath = path.join(dir, "main.ts");
    await fs.writeFile(
      sourcePath,
      `import { Kafka } from "kafkajs";
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

// --- 2-A: canonicalEventContractKey + broker inference (pure unit) ---

describe("canonicalEventContractKey", () => {
  it("lowercases and trims topics", () => {
    expect(canonicalEventContractKey("Order.Created")).toBe("order.created");
    expect(canonicalEventContractKey("  user.registered  ")).toBe("user.registered");
  });

  it("is idempotent", () => {
    const once = canonicalEventContractKey("ORDER.CREATED");
    expect(canonicalEventContractKey(once)).toBe(once);
  });
});

describe("inferBrokerFromCallee", () => {
  it("infers kafka", () => {
    expect(inferBrokerFromCallee("kafkaProducer")).toBe("kafka");
    expect(inferBrokerFromCallee("this.kafkaClient")).toBe("kafka");
  });

  it("infers rabbitmq from rabbit/amqp receivers", () => {
    expect(inferBrokerFromCallee("rabbitChannel")).toBe("rabbitmq");
    expect(inferBrokerFromCallee("amqpChannel")).toBe("rabbitmq");
  });

  it("infers redis-stream", () => {
    expect(inferBrokerFromCallee("redisStream")).toBe("redis-stream");
  });

  it("degrades unknown receivers (EventEmitter, plain names)", () => {
    expect(inferBrokerFromCallee("emitter")).toBe("unknown");
    expect(inferBrokerFromCallee("eventBus")).toBe("unknown");
    expect(inferBrokerFromCallee(undefined)).toBe("unknown");
  });
});

// --- 2-A: broker inference through the extractor ---

describe("Event Extractor broker inference", () => {
  it("infers kafka broker from receiver", async () => {
    const bundle = await extractEvents(`kafkaProducer.send("order.created", new OrderCreatedEvent());`);
    const spec = bundle.contractSpecs.find((s) => s.eventTopic === "order.created");
    expect(spec).toBeDefined();
    expect(JSON.parse(spec!.specJson).broker).toBe("kafka");
    expect(spec!.framework).toBe("kafka");
  });

  it("infers rabbitmq broker from receiver", async () => {
    const bundle = await extractEvents(`rabbitChannel.publish("order.created", new OrderCreatedEvent());`);
    const spec = bundle.contractSpecs.find((s) => s.eventTopic === "order.created");
    expect(JSON.parse(spec!.specJson).broker).toBe("rabbitmq");
  });

  it("import-gates generic methods: bare emitter.emit without a broker signal is dropped", async () => {
    const bundle = await extractEvents(`emitter.emit("order.created", payload);`);
    expect(bundle.contractSpecs.some((s) => s.eventTopic === "order.created")).toBe(false);
    expect(bundle.contracts.length).toBe(0);
  });

  it("import-gates generic methods: a messaging-library import lets emit/send through", async () => {
    const bundle = await extractEvents(`import { Kafka } from "kafkajs";\nbus.emit("order.created", new OrderCreatedEvent());`);
    const spec = bundle.contractSpecs.find((s) => s.eventTopic === "order.created");
    expect(spec).toBeDefined();
    expect(JSON.parse(spec!.specJson).broker).toBe("kafka");
  });

  it("does not treat res.send / process.on as events (no broker import)", async () => {
    const bundle = await extractEvents(`res.send("ok");\nprocess.on("SIGTERM", () => {});`);
    expect(bundle.contracts.length).toBe(0);
  });

  it("leaves framework unset for a specific method with an unknown broker", async () => {
    // `publish` is a specific method, so it survives the import gate even with
    // no broker signal; broker stays unknown and framework is left unset.
    const bundle = await extractEvents(`eventBus.publish("order.created", new OrderCreatedEvent());`);
    const spec = bundle.contractSpecs.find((s) => s.eventTopic === "order.created");
    expect(JSON.parse(spec!.specJson).broker).toBe("unknown");
    expect(spec!.framework).toBeUndefined();
  });
});

// --- 2-A: payload type inference (resolvable vs degraded) ---

describe("Event Extractor payload inference", () => {
  it("resolves payload type from a constructor expression", async () => {
    const bundle = await extractEvents(`kafkaProducer.send("order.created", new OrderCreatedEvent({ id: 1 }));`);
    const spec = bundle.contractSpecs.find((s) => s.eventTopic === "order.created");
    expect(JSON.parse(spec!.specJson).payloadType).toBe("OrderCreatedEvent");
    expect(bundle.evidence.some((e) => e.rule === "payload-type-unresolvable")).toBe(false);
  });

  it("resolves payload type from an explicit type argument", async () => {
    const bundle = await extractEvents(`eventBus.publish<OrderCreatedEvent>("order.created", buildPayload());`);
    const spec = bundle.contractSpecs.find((s) => s.eventTopic === "order.created");
    expect(JSON.parse(spec!.specJson).payloadType).toBe("OrderCreatedEvent");
  });

  it("resolves payload type from an 'as' assertion", async () => {
    const bundle = await extractEvents(`eventBus.publish("order.created", raw as OrderCreatedEvent);`);
    const spec = bundle.contractSpecs.find((s) => s.eventTopic === "order.created");
    expect(JSON.parse(spec!.specJson).payloadType).toBe("OrderCreatedEvent");
  });

  it("treats an anonymous object literal as a payload without a named type (no degrade evidence)", async () => {
    const bundle = await extractEvents(`eventBus.publish("order.created", { id: 1 });`);
    const spec = bundle.contractSpecs.find((s) => s.eventTopic === "order.created");
    expect(JSON.parse(spec!.specJson).payloadType).toBeUndefined();
    expect(bundle.evidence.some((e) => e.rule === "payload-type-unresolvable")).toBe(false);
  });

  it("infers consumer payload type from a typed handler parameter", async () => {
    const bundle = await extractEvents(`kafkaConsumer.consume("order.created", (msg: OrderCreatedEvent) => {});`);
    const spec = bundle.contractSpecs.find((s) => s.eventTopic === "order.created");
    expect(JSON.parse(spec!.specJson).payloadType).toBe("OrderCreatedEvent");
    // Consumer handlers never trigger the producer-only degrade audit.
    expect(bundle.evidence.some((e) => e.rule === "payload-type-unresolvable")).toBe(false);
  });

  it("treats an array literal as an inline payload without a degrade audit", async () => {
    const bundle = await extractEvents(`eventBus.publish("order.created", [{ id: 1 }, { id: 2 }]);`);
    const spec = bundle.contractSpecs.find((s) => s.eventTopic === "order.created");
    expect(JSON.parse(spec!.specJson).payloadType).toBeUndefined();
    expect(bundle.evidence.some((e) => e.rule === "payload-type-unresolvable")).toBe(false);
  });

  it("degrades an un-typed dynamic payload reference with a confidence:0 audit evidence", async () => {
    const bundle = await extractEvents(`eventBus.publish("order.created", payload);`);
    const spec = bundle.contractSpecs.find((s) => s.eventTopic === "order.created");
    expect(JSON.parse(spec!.specJson).payloadType).toBeUndefined();
    const degraded = bundle.evidence.find((e) => e.rule === "payload-type-unresolvable");
    expect(degraded).toBeDefined();
    expect(degraded!.confidence).toBe(0);
  });
});

// --- 2-A: EventSpec production shape ---

describe("Event Extractor EventSpec production", () => {
  it("produces an event ContractSpec + HAS_SPEC edge with the topic column populated", async () => {
    const bundle = await extractEvents(`kafkaProducer.send("order.created", new OrderCreatedEvent());`);
    const spec = bundle.contractSpecs.find((s) => s.eventTopic === "order.created");
    expect(spec).toBeDefined();
    expect(spec!.specKind).toBe("event");
    expect(spec!.canonicalKey).toBe("order.created");
    expect(spec!.httpMethod).toBeUndefined();
    expect(spec!.pathTemplate).toBeUndefined();

    const parsed = JSON.parse(spec!.specJson);
    expect(parsed.kind).toBe("event");
    expect(parsed.topic).toBe("order.created");

    expect(bundle.contractSpecEdges.some((e) => e.specId === spec!.id)).toBe(true);
  });

  it("produces specs for both producer and consumer sides", async () => {
    const bundle = await extractEvents(`
      kafkaProducer.send("order.created", new OrderCreatedEvent());
      kafkaConsumer.consume("order.created", (msg) => {});
    `);
    const specs = bundle.contractSpecs.filter((s) => s.eventTopic === "order.created");
    expect(specs.length).toBe(2);
  });
});

// --- 2-A: multi-language wiring through the indexing fact pipeline ---

describe("Event Spec multi-language pipeline", () => {
  it("extracts event specs from Python, Go and Java via buildGraphFactsBatch", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-event-multilang-"));
    try {
      const repo = { id: repoId("event-multilang"), name: "event-multilang", path: dir, remoteUrl: "", branch: "main", commitSha: "abc", language: "python", indexedAt: "now" } as any;

      const files: { rel: string; lang: string; src: string }[] = [
        { rel: "producer.py", lang: "python", src: `from kafka import KafkaProducer\nproducer = KafkaProducer()\nproducer.send("py.order.created", value=b"x")` },
        { rel: "main.go", lang: "go", src: `package main\nimport "github.com/nats-io/nats.go"\nfunc run(nc *nats.Conn) { nc.Publish("go.order.created", nil) }` },
        { rel: "src/main/java/com/example/C.java", lang: "java", src: `import org.springframework.kafka.annotation.KafkaListener;\npublic class C {\n  @KafkaListener(topics = "java.order.created")\n  public void handle(String m) {}\n}` }
      ];
      const parsedFiles = [];
      for (const f of files) {
        const abs = path.join(dir, f.rel);
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, f.src, "utf8");
        parsedFiles.push(await parseSourceFile({ repoId: repo.id, absolutePath: abs, relativePath: f.rel, language: f.lang as any }));
      }

      const facts = await buildGraphFactsBatch({ batchId: "batch:event-multilang", repos: [repo], parsedFiles, semantic: false });
      const eventTopics = facts.contractSpecs.filter((s) => s.specKind === "event").map((s) => s.eventTopic);
      expect(eventTopics).toContain("py.order.created");
      expect(eventTopics).toContain("go.order.created");
      expect(eventTopics).toContain("java.order.created");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

// --- 2-B: Event Spec end-to-end through the indexing fact pipeline + Kuzu ---

describe("Event Spec end-to-end (2-B)", () => {
  it("indexes an event publish/subscribe repo and lands EventSpec nodes in the graph", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-event-e2e-"));
    try {
      const repo = { id: repoId("event-e2e"), name: "event-e2e", path: dir, remoteUrl: "", branch: "main", commitSha: "abc", language: "typescript", indexedAt: "now" } as any;

      const publisherPath = path.join(dir, "publisher.ts");
      await fs.writeFile(publisherPath, `
        export function publishOrder() {
          kafkaProducer.send("order.created", new OrderCreatedEvent({ id: 1 }));
        }
      `, "utf8");
      const consumerPath = path.join(dir, "consumer.ts");
      await fs.writeFile(consumerPath, `
        export function handleOrder() {
          kafkaConsumer.consume("order.created", (msg) => {});
          kafkaProducer.emit("notice.sent", payload);
        }
      `, "utf8");

      const parsedPublisher = await parseSourceFile({ repoId: repo.id, absolutePath: publisherPath, relativePath: "publisher.ts", language: "typescript" });
      const parsedConsumer = await parseSourceFile({ repoId: repo.id, absolutePath: consumerPath, relativePath: "consumer.ts", language: "typescript" });

      const facts = await buildGraphFactsBatch({
        batchId: "batch:event-e2e",
        repos: [repo],
        parsedFiles: [parsedPublisher, parsedConsumer],
        semantic: false
      });

      const eventSpecs = facts.contractSpecs.filter((s) => s.specKind === "event");
      expect(eventSpecs.length).toBeGreaterThanOrEqual(3);

      const orderProducer = eventSpecs.find((s) => s.eventTopic === "order.created" && JSON.parse(s.specJson).payloadType === "OrderCreatedEvent");
      expect(orderProducer).toBeDefined();
      expect(JSON.parse(orderProducer!.specJson).broker).toBe("kafka");

      // payload degradation lands in the audit evidence stream
      expect(facts.evidence.some((e) => e.rule === "payload-type-unresolvable")).toBe(true);

      const db = await KuzuGraphDB.open(path.join(dir, "graph"));
      try {
        await db.initSchema(repo.id);
        await writeGraphFactsWithMerge(db, facts);
        const rows = await db.query<{ topic: string; specJson: string }>(
          "MATCH (s:ContractSpec) WHERE s.specKind = 'event' AND s.eventTopic = 'order.created' RETURN s.eventTopic AS topic, s.specJson AS specJson;"
        );
        expect(rows.length).toBeGreaterThanOrEqual(1);
        const brokers = rows.map((r) => JSON.parse(r.specJson).broker);
        expect(brokers).toContain("kafka");
      } finally {
        await db.close();
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
