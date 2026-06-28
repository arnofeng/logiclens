import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseSourceFile } from "../src/core/parsing/parserRegistry.js";
import { javaEventExtractor } from "../src/core/contracts/extraction/builtin/javaEventExtractor.js";
import { repoId } from "../src/shared/path.js";
import type { ExtractorFactBundle } from "../src/core/contracts/extraction/crossRepoContracts.js";

async function extract(source: string): Promise<ExtractorFactBundle> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-java-event-"));
  const rel = "src/main/java/com/example/Events.java";
  const abs = path.join(dir, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, source, "utf8");
  const repo = { id: repoId("java-event"), name: "java-event", path: dir, remoteUrl: "", branch: "", commitSha: "", language: "java", indexedAt: "now" } as any;
  const parsed = await parseSourceFile({ repoId: repo.id, absolutePath: abs, relativePath: rel, language: "java" });
  const bundle = await javaEventExtractor.extract({ repos: [repo], parsedFiles: [parsed], repoResolver: () => repo });
  await fs.rm(dir, { recursive: true, force: true });
  return bundle;
}

describe("Java Event Extractor", () => {
  it("extracts a @KafkaListener consumer with topic", async () => {
    const bundle = await extract(`
import org.springframework.kafka.annotation.KafkaListener;
public class OrderConsumer {
  @KafkaListener(topics = "order.created")
  public void handle(String msg) {}
}`);
    const spec = bundle.contractSpecs.find((s) => s.eventTopic === "order.created");
    expect(spec).toBeDefined();
    expect(JSON.parse(spec!.specJson).broker).toBe("kafka");
    expect(spec!.confidence).toBe(0.9);
    const consumers = bundle.repoContracts.filter((e) => e.role === "consumer");
    expect(consumers.length).toBe(1);
  });

  it("extracts multiple topics from a @KafkaListener array", async () => {
    const bundle = await extract(`
import org.springframework.kafka.annotation.KafkaListener;
public class C {
  @KafkaListener(topics = {"order.created", "order.updated"})
  public void handle(String msg) {}
}`);
    const topics = bundle.contractSpecs.map((s) => s.eventTopic).sort();
    expect(topics).toContain("order.created");
    expect(topics).toContain("order.updated");
  });

  it("extracts a @RabbitListener consumer as rabbitmq", async () => {
    const bundle = await extract(`
import org.springframework.amqp.rabbit.annotation.RabbitListener;
public class C {
  @RabbitListener(queues = "order.created")
  public void handle(String msg) {}
}`);
    const spec = bundle.contractSpecs.find((s) => s.eventTopic === "order.created");
    expect(spec).toBeDefined();
    expect(JSON.parse(spec!.specJson).broker).toBe("rabbitmq");
  });

  it("extracts a kafkaTemplate.send producer (import-gated)", async () => {
    const bundle = await extract(`
import org.springframework.kafka.core.KafkaTemplate;
public class P {
  private KafkaTemplate<String, String> kafkaTemplate;
  public void publish() {
    kafkaTemplate.send("order.created", payload);
  }
}`);
    const spec = bundle.contractSpecs.find((s) => s.eventTopic === "order.created");
    expect(spec).toBeDefined();
    expect(JSON.parse(spec!.specJson).broker).toBe("kafka");
    const producers = bundle.repoContracts.filter((e) => e.role === "producer");
    expect(producers.length).toBe(1);
  });

  it("labels an amqpTemplate.send producer as rabbitmq, not kafka", async () => {
    // `send` is ambiguous (kafka & amqp both expose it); in a spring-amqp file
    // it must defer to the imported broker rather than default to kafka.
    const bundle = await extract(`
import org.springframework.amqp.core.AmqpTemplate;
public class P {
  private AmqpTemplate amqpTemplate;
  public void publish() {
    amqpTemplate.send("order.created", message);
  }
}`);
    const spec = bundle.contractSpecs.find((s) => s.eventTopic === "order.created");
    expect(spec).toBeDefined();
    expect(JSON.parse(spec!.specJson).broker).toBe("rabbitmq");
  });

  it("skips a @KafkaListener whose topic is a property placeholder", async () => {
    const bundle = await extract(`
import org.springframework.kafka.annotation.KafkaListener;
public class C {
  @KafkaListener(topics = "\${app.topic}")
  public void handle(String msg) {}
}`);
    expect(bundle.contractSpecs.some((s) => s.specKind === "event")).toBe(false);
  });

  it("does not extract producer calls without a messaging import", async () => {
    const bundle = await extract(`
public class P {
  public void publish() {
    someTemplate.send("order.created", payload);
  }
}`);
    expect(bundle.contractSpecs.some((s) => s.specKind === "event")).toBe(false);
  });
});
