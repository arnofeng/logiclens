import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseSourceFile } from "../src/core/parsing/parserRegistry.js";
import { pythonEventExtractor } from "../src/core/contracts/extraction/builtin/pythonEventExtractor.js";
import { repoId } from "../src/shared/path.js";
import type { ExtractorFactBundle } from "../src/core/contracts/extraction/crossRepoContracts.js";

async function extract(source: string): Promise<ExtractorFactBundle> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "test-py-event-"));
  const rel = "app.py";
  const abs = path.join(dir, rel);
  await fs.writeFile(abs, source, "utf8");
  const repo = { id: repoId("py-event"), name: "py-event", path: dir, remoteUrl: "", branch: "", commitSha: "", language: "python", indexedAt: "now" } as any;
  const parsed = await parseSourceFile({ repoId: repo.id, absolutePath: abs, relativePath: rel, language: "python" });
  const bundle = await pythonEventExtractor.extract({ repos: [repo], parsedFiles: [parsed], repoResolver: () => repo });
  await fs.rm(dir, { recursive: true, force: true });
  return bundle;
}

describe("Python Event Extractor", () => {
  it("extracts a kafka-python producer (.send) with import gating", async () => {
    const bundle = await extract(`from kafka import KafkaProducer\nproducer = KafkaProducer()\nproducer.send("order.created", value=b"x")`);
    const spec = bundle.contractSpecs.find((s) => s.eventTopic === "order.created");
    expect(spec).toBeDefined();
    expect(spec!.specKind).toBe("event");
    expect(JSON.parse(spec!.specJson).broker).toBe("kafka");
    const producers = bundle.repoContracts.filter((e) => e.role === "producer");
    expect(producers.length).toBe(1);
  });

  it("extracts a kafka consumer (.subscribe with list topic)", async () => {
    const bundle = await extract(`from kafka import KafkaConsumer\nconsumer = KafkaConsumer()\nconsumer.subscribe(["order.created"])`);
    const spec = bundle.contractSpecs.find((s) => s.eventTopic === "order.created");
    expect(spec).toBeDefined();
    const consumers = bundle.repoContracts.filter((e) => e.role === "consumer");
    expect(consumers.length).toBe(1);
  });

  it("extracts a pika producer (basic_publish routing_key kwarg) as rabbitmq", async () => {
    const bundle = await extract(`import pika\nchannel.basic_publish(exchange="", routing_key="order.created", body=b"x")`);
    const spec = bundle.contractSpecs.find((s) => s.eventTopic === "order.created");
    expect(spec).toBeDefined();
    expect(JSON.parse(spec!.specJson).broker).toBe("rabbitmq");
  });

  it("extracts a celery task handler as a consumer gated on celery import", async () => {
    const bundle = await extract(`from celery import shared_task\n\n@shared_task\ndef process_order():\n    pass`);
    const spec = bundle.contractSpecs.find((s) => s.eventTopic === "process_order");
    expect(spec).toBeDefined();
    expect(spec!.framework).toBe("celery");
    const consumers = bundle.repoContracts.filter((e) => e.role === "consumer");
    expect(consumers.length).toBe(1);
  });

  it("import-gates call-based events: no messaging import means nothing is extracted", async () => {
    const bundle = await extract(`obj.send("order.created", value=1)\nobj.publish("x")`);
    expect(bundle.contracts.length).toBe(0);
  });

  it("does not treat a bare @task without a celery import as an event", async () => {
    const bundle = await extract(`@task\ndef helper():\n    pass`);
    expect(bundle.contracts.length).toBe(0);
  });
});
