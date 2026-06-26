import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseSourceFile } from "../src/parsers/parserRegistry.js";
import { goExtractor } from "../src/extractors/builtin/goExtractor.js";
import { repoId } from "../src/utils/path.js";
import type { ExtractorFactBundle } from "../src/extractors/crossRepoContracts.js";

async function extract(source: string): Promise<ExtractorFactBundle> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-go-event-"));
  const rel = "main.go";
  const abs = path.join(dir, rel);
  await fs.writeFile(abs, source, "utf8");
  const repo = { id: repoId("go-event"), name: "go-event", path: dir, remoteUrl: "", branch: "", commitSha: "", language: "go", indexedAt: "now" } as any;
  const parsed = await parseSourceFile({ repoId: repo.id, absolutePath: abs, relativePath: rel, language: "go" });
  const bundle = await goExtractor.extract({ repos: [repo], parsedFiles: [parsed], repoResolver: () => repo });
  await fs.rm(dir, { recursive: true, force: true });
  return bundle;
}

describe("Go Event Extractor", () => {
  it("extracts a NATS producer (nc.Publish with subject string)", async () => {
    const bundle = await extract(`package main
import "github.com/nats-io/nats.go"
func run(nc *nats.Conn) {
  nc.Publish("order.created", []byte("x"))
}`);
    const spec = bundle.contractSpecs.find((s) => s.eventTopic === "order.created");
    expect(spec).toBeDefined();
    expect(JSON.parse(spec!.specJson).broker).toBe("nats");
    const producers = bundle.relations.filter((r) => r.kind === "repo-contract" && r.role === "producer");
    expect(producers.length).toBe(1);
  });

  it("extracts a NATS consumer (nc.Subscribe)", async () => {
    const bundle = await extract(`package main
import "github.com/nats-io/nats.go"
func run(nc *nats.Conn) {
  nc.Subscribe("order.created", handler)
}`);
    const spec = bundle.contractSpecs.find((s) => s.eventTopic === "order.created");
    expect(spec).toBeDefined();
    const consumers = bundle.relations.filter((r) => r.kind === "repo-contract" && r.role === "consumer");
    expect(consumers.length).toBe(1);
  });

  it("extracts a kafka-go producer from a struct Topic field", async () => {
    const bundle = await extract(`package main
import "github.com/segmentio/kafka-go"
func run(w *kafka.Writer) {
  w.WriteMessages(ctx, kafka.Message{Topic: "order.created", Value: []byte("x")})
}`);
    const spec = bundle.contractSpecs.find((s) => s.eventTopic === "order.created");
    expect(spec).toBeDefined();
    expect(JSON.parse(spec!.specJson).broker).toBe("kafka");
  });

  it("degrades a kafka struct with a non-literal Topic to a confidence:0 audit", async () => {
    const bundle = await extract(`package main
import "github.com/segmentio/kafka-go"
func run(w *kafka.Writer, topic string) {
  w.WriteMessages(ctx, kafka.Message{Topic: topic, Value: []byte("x")})
}`);
    expect(bundle.contractSpecs.some((s) => s.specKind === "event")).toBe(false);
    const degraded = bundle.evidence.find((e) => e.rule === "event-topic-unresolvable");
    expect(degraded).toBeDefined();
    expect(degraded!.confidence).toBe(0);
  });

  it("does not mislabel a non-NATS Subscribe in a kafka-only file as a nats event", async () => {
    // `Subscribe` is a generic method name; in a kafka-go file it must not be
    // attributed to NATS just because a broker was imported.
    const bundle = await extract(`package main
import "github.com/segmentio/kafka-go"
func run(r *kafka.Reader) {
  r.Subscribe("order.created", handler)
}`);
    expect(bundle.contractSpecs.some((s) => JSON.parse(s.specJson).broker === "nats")).toBe(false);
  });

  it("import-gates events: no messaging import means nothing is extracted", async () => {
    const bundle = await extract(`package main
func run(nc *Conn) {
  nc.Publish("order.created", nil)
}`);
    expect(bundle.contractSpecs.some((s) => s.specKind === "event")).toBe(false);
  });
});
