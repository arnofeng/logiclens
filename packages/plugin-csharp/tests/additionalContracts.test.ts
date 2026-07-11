import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { PluginCallView, PluginEventFact, PluginGrpcMethodFact, PluginSchemaFact, PluginSymbolView } from "@logiclens/plugin-sdk";
import { parseCSharp } from "../src/parser.js";
import { csharpGrpcExtractor } from "../src/grpcFacts.js";
import { csharpEventExtractor } from "../src/eventFacts.js";
import { csharpSchemaExtractor } from "../src/schemaFacts.js";

async function context(sourceInput?: string, filePath = "AdditionalContracts.cs") {
  const source = sourceInput ?? await fs.readFile(path.resolve(import.meta.dirname, "fixtures", filePath), "utf8");
  const parsed = await parseCSharp({ repoId: "repo:csharp", absolutePath: path.resolve(filePath), relativePath: filePath, language: "csharp", source });
  const symbols: PluginSymbolView[] = (parsed.symbols ?? []).map((symbol, index) => ({ id: `symbol:${index}`, filePath,
    name: symbol.name, kind: symbol.kind, qualifiedName: symbol.qualifiedName ?? symbol.name, startLine: symbol.startLine,
    endLine: symbol.endLine, signature: symbol.signature ?? "" }));
  const calls: PluginCallView[] = (parsed.calls ?? []).map((call) => ({ filePath, calleeName: call.calleeName,
    receiver: call.receiver, raw: call.raw, line: call.line }));
  const view = { repoId: "repo:csharp", path: filePath, language: "csharp", source, symbols, imports: [], calls };
  const files = Object.assign([view], { all: () => [view], byLanguage: (language: string) => language === "csharp" ? [view] : [],
    byRepo: (repoId: string) => repoId === "repo:csharp" ? [view] : [], get: () => view });
  return { source, symbols, files };
}

function emit(grpc: PluginGrpcMethodFact[], events: PluginEventFact[], schemas: PluginSchemaFact[]) {
  return { fact: () => undefined, httpEndpoint: () => undefined, packageUsage: () => undefined, framework: () => undefined,
    semanticRelation: () => undefined, grpcMethod: (fact: Omit<PluginGrpcMethodFact, "kind">) => grpc.push({ kind: "grpcMethod", ...fact }),
    event: (fact: Omit<PluginEventFact, "kind">) => events.push({ kind: "event", ...fact }),
    schema: (fact: Omit<PluginSchemaFact, "kind">) => schemas.push({ kind: "schema", ...fact }) };
}

describe("C# additional contracts", () => {
  it("extracts generated-base implementations and typed clients with all streaming modes", async () => {
    const { symbols, files } = await context();
    const grpc: PluginGrpcMethodFact[] = [];
    await csharpGrpcExtractor.extract({ repos: [], files, symbols, imports: [], calls: [], emit: emit(grpc, [], []) });
    expect(grpc.filter((fact) => fact.role === "producer").map((fact) => [fact.method, fact.streaming])).toEqual([
      ["GetOrder", "unary"], ["Upload", "client-stream"], ["Download", "server-stream"], ["Chat", "bidi-stream"]
    ]);
    expect(grpc.find((fact) => fact.method === "GetOrder" && fact.role === "producer")).toMatchObject({ service: "Orders", fullName: "Orders/GetOrder", requestType: "OrderRequest", responseType: "OrderReply", framework: "grpc-dotnet", sourceSymbolId: expect.any(String) });
    expect(grpc.filter((fact) => fact.role === "consumer").map((fact) => [fact.method, fact.streaming, fact.requestType, fact.responseType])).toEqual([
      ["GetOrder", "unary", "OrderRequest", undefined], ["Upload", "client-stream", "OrderChunk", "OrderReply"],
      ["Download", "server-stream", "OrderRequest", "OrderReply"], ["Chat", "bidi-stream", "OrderChunk", "OrderReply"]
    ]);
    expect(grpc.some((fact) => fact.service === "Fake")).toBe(false);
  });

  it("extracts stable typed messaging patterns and omits dynamic topics and same-name methods", async () => {
    const { symbols, files } = await context();
    const events: PluginEventFact[] = [];
    await csharpEventExtractor.extract({ repos: [], files, symbols, imports: [], calls: [], emit: emit([], events, []) });
    expect(events.map((fact) => [fact.framework, fact.role, fact.topic])).toEqual(expect.arrayContaining([
      ["confluent-kafka", "producer", "orders.created"], ["confluent-kafka", "consumer", "orders.created"],
      ["rabbitmq-dotnet-client", "producer", "orders.created"], ["rabbitmq-dotnet-client", "consumer", "orders.queue"],
      ["masstransit", "producer", "OrderCreated"], ["masstransit", "consumer", "OrderCreated"],
      ["nservicebus", "producer", "OrderCreated"], ["nservicebus", "consumer", "OrderCreated"],
      ["azure-service-bus", "producer", "orders.created"], ["azure-service-bus", "producer", "orders.a"],
      ["azure-service-bus", "producer", "orders.b"]
    ]));
    expect(events.filter((fact) => fact.framework === "confluent-kafka" && fact.role === "producer")).toHaveLength(1);
    expect(events.every((fact) => fact.sourceSymbolId && fact.evidence.confidence === "exact")).toBe(true);
  });

  it("does not promote EF-only entities to schemas", async () => {
    const { symbols, files } = await context();
    const schemas: PluginSchemaFact[] = [];
    const emitter = emit([], [], schemas);
    await csharpSchemaExtractor.postExtract?.({ repos: [], files, symbols, imports: [], calls: [], facts: { httpEndpoints: () => [], schemas: () => [], events: () => [], grpcMethods: () => [], packageUsages: () => [], frameworks: () => [], all: () => [] }, emit: emitter });
    expect(schemas.some((schema) => schema.name === "EfOnlyEntity")).toBe(false);
  });

  it("keeps typed receivers inside their lexical method and rejects generated owners", async () => {
    const source = `
public class Scoped {
  public void First(IProducer<string, Notice> producer, Orders.OrdersClient client) {
    producer.Produce("first", new Message<string, Notice>());
    client.GetAsync(new Request());
  }
  public void Second() {
    producer.Produce("leaked", new Message<string, Notice>());
    client.GetAsync(new Request());
  }
  public void Shadow(IProducer<string, Notice> producer) {
    FakeProducer producer = new();
    producer.Produce("shadowed", new Message<string, Notice>());
  }
}`;
    const scoped = await context(source, "Scoped.cs");
    const grpc: PluginGrpcMethodFact[] = [];
    const events: PluginEventFact[] = [];
    await csharpGrpcExtractor.extract({ repos: [], files: scoped.files, symbols: scoped.symbols, imports: [], calls: [], emit: emit(grpc, events, []) });
    await csharpEventExtractor.extract({ repos: [], files: scoped.files, symbols: scoped.symbols, imports: [], calls: [], emit: emit(grpc, events, []) });
    expect(grpc.map((fact) => fact.method)).toEqual(["Get"]);
    expect(events.map((fact) => fact.topic)).toEqual(["first"]);

    const generated = await context(source.replace("Scoped", "Generated"), "obj/Debug/Generated.g.cs");
    const generatedGrpc: PluginGrpcMethodFact[] = [];
    const generatedEvents: PluginEventFact[] = [];
    await csharpGrpcExtractor.extract({ repos: [], files: generated.files, symbols: generated.symbols, imports: [], calls: [], emit: emit(generatedGrpc, generatedEvents, []) });
    await csharpEventExtractor.extract({ repos: [], files: generated.files, symbols: generated.symbols, imports: [], calls: [], emit: emit(generatedGrpc, generatedEvents, []) });
    expect(generatedGrpc).toEqual([]);
    expect(generatedEvents).toEqual([]);
  });

  it("rejects comment/string/invalid pseudo-code and retains same-named Azure endpoints in sibling methods", async () => {
    const source = `
public class Real {
  private readonly ServiceBusClient azure;
  public void A() { var sender = azure.CreateSender("a"); sender.SendMessageAsync(new ServiceBusMessage()); }
  public void B() { var sender = azure.CreateSender("b"); sender.SendMessageAsync(new ServiceBusMessage()); }
}
/* class FakeService : Orders.OrdersBase {
  public override Task<GhostReply> Ghost(GhostRequest request, ServerCallContext context) => Handle(request);
  IProducer<string, Notice> producer; producer.Produce("ghost", value);
} */
public class Broken : Orders.OrdersBase { public override Task<Bad> Bad(Bad request, ServerCallContext context)`;
    const parsed = await context(source, "Comments.cs");
    const grpc: PluginGrpcMethodFact[] = [];
    const events: PluginEventFact[] = [];
    await csharpGrpcExtractor.extract({ repos: [], files: parsed.files, symbols: parsed.symbols, imports: [], calls: [], emit: emit(grpc, events, []) });
    await csharpEventExtractor.extract({ repos: [], files: parsed.files, symbols: parsed.symbols, imports: [], calls: [], emit: emit(grpc, events, []) });
    expect(grpc).toEqual([]);
    expect(events.map((fact) => fact.topic)).toEqual(["a", "b"]);
  });
});
