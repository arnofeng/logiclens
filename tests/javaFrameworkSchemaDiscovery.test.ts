import { extractFacts } from "./helpers/extractFacts.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config/loadConfig.js";
import { buildGraphFactsBatch } from "../src/core/graph-model/facts.js";
import { parseSourceFile } from "../src/core/parsing/parserRegistry.js";
import type { ContractSpecNode, ParsedGraphFile, RepoNode } from "../src/core/parsing/types.js";
import type { DubboMethodSpec, EventSpec, SchemaSpec } from "../src/core/contracts/spec.js";
import { buildProtoJavaIdentityBridge } from "../src/core/contracts/extraction/protoJavaBridge.js";
import { protoExtractor } from "../src/core/contracts/extraction/builtin/protoExtractor.js";
import { deriveWorkspaceId } from "../src/core/workspace/identity.js";
import { repoId } from "../src/shared/path.js";
import { KuzuGraphDB } from "../src/core/graph-model/db.js";
import { runIndexing } from "../src/core/indexing/run.js";
import { captureSchemaBaselineSnapshot } from "./helpers/schemaBaselineSnapshot.js";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))));

describe("JS-010..JS-012 deterministic Java framework schema discovery", () => {
  it("honors framework exclusions before running language-compatible extractors", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "repohelix-java-framework-gate-"));
    directories.push(directory);
    const id = repoId("java-framework-gate");
    const parsedFiles = await parseSources(directory, id, new Map([
      ["src/main/java/acme/Activity.java", "package acme; public class Activity { private String id; }"],
      ["src/main/java/acme/Events.java", `
        package acme;
        import org.springframework.context.event.EventListener;
        public class Events { @EventListener public void on(Activity payload) {} }
      `]
    ]));
    const repo = repoNode(id, directory);
    const base = defaultConfig();
    const config = {
      ...base,
      systemName: "java-framework-gate",
      repos: [{ name: repo.name, path: directory }],
      frameworks: {
        ...base.frameworks,
        exclude: [...(base.frameworks?.exclude ?? []), "java:spring-events"]
      }
    };
    const facts = await buildGraphFactsBatch({
      workspaceId: deriveWorkspaceId(config.systemName), generation: "generation:test", systemName: config.systemName,
      batchId: "batch:test", indexedAt: "2026-08-03T00:00:00.000Z", repos: [repo], parsedFiles, semantic: true, config
    });

    expect(facts.contractSpecs.some((node) => node.specKind === "event")).toBe(false);
  });

  it("materializes Dubbo parameter slots and shared event payloads through the Java adapter", async () => {
    const { facts, parsedFiles, repo } = await indexSources(new Map([
      ["src/main/java/acme/Activity.java", `package acme; public class Activity { private String id; }`],
      ["src/main/java/acme/Headers.java", `package acme; public class Headers {}`],
      ["src/main/java/acme/GenericApi.java", `package acme; public interface GenericApi<T> { T load(T value); }`],
      ["src/main/java/acme/ActivityApi.java", `
        package acme;
        import org.apache.dubbo.config.annotation.DubboService;
        @DubboService public interface ActivityApi extends GenericApi<Activity> {
          Activity find(Activity filter, int page);
          Activity find(Activity filter);
        }
      `],
      ["src/main/java/acme/Events.java", `
        package acme;
        import org.springframework.context.ApplicationEventPublisher;
        import org.springframework.context.event.EventListener;
        public class Events {
          private ApplicationEventPublisher publisher;
          @EventListener public void on(Activity value, Headers headers) {}
          public void publish(Activity value) { publisher.publishEvent(value); }
        }
      `]
    ]));
    const schemas = schemaNodes(facts.contractSpecs);
    const activity = schemas.find(({ spec }) => spec.displayName === "Activity");
    expect(activity).toBeDefined();
    const dubbo = facts.contractSpecs.filter((node) => node.specKind === "dubbo-method")
      .map((node) => ({ node, spec: JSON.parse(node.specJson) as DubboMethodSpec }));
    expect(dubbo.filter(({ spec }) => spec.method === "find")).toHaveLength(2);
    expect(new Set(dubbo.filter(({ spec }) => spec.method === "find").map(({ spec }) => spec.methodSignature)).size).toBe(2);
    expect(dubbo.find(({ spec }) => spec.method === "load")?.spec.requestSlots).toEqual([{ index: 0, name: "value", type: "Activity" }]);
    const findTwo = dubbo.find(({ spec }) => spec.methodSignature === "find(Activity,int):Activity")!;
    expect(findTwo.spec.requestSlots).toEqual([
      { index: 0, name: "filter", type: "Activity" },
      { index: 1, name: "page", type: "int" }
    ]);
    expect(facts.semanticRelations).toEqual(expect.arrayContaining([
      expect.objectContaining({ fromSpecId: findTwo.node.id, toSpecId: activity?.node.id, kind: "REQUEST_SCHEMA" }),
      expect.objectContaining({ fromSpecId: findTwo.node.id, toSpecId: activity?.node.id, kind: "RESPONSE_SCHEMA" })
    ]));
    const events = facts.contractSpecs.filter((node) => node.specKind === "event")
      .map((node) => ({ node, spec: JSON.parse(node.specJson) as EventSpec }));
    expect(events).toHaveLength(2);
    expect(events.every(({ spec }) => spec.payloadType === "Activity" && spec.payloadInference === "resolved")).toBe(true);
    expect(facts.semanticRelations.filter((relation) => relation.kind === "EVENT_PAYLOAD" && relation.toSpecId === activity?.node.id)).toHaveLength(2);
    expect(schemas.filter(({ spec }) => spec.displayName === "Headers")).toHaveLength(0);
  });

  it("bridges generated Java gRPC types directly to canonical Proto schemas", async () => {
    const { facts, parsedFiles, repo } = await indexSources(new Map([
      ["proto/order.proto", `
        syntax = "proto3";
        package acme.order.v1;
        option java_package = "gen.order";
        option java_outer_classname = "Wire";
        option java_multiple_files = false;
        message Create { string id = 1; }
        message Result { string id = 1; }
        service Orders {
          rpc Unary(Create) returns (Result);
          rpc Server(Create) returns (stream Result);
          rpc Client(stream Create) returns (Result);
          rpc Bidi(stream Create) returns (stream Result);
        }
      `],
      ["src/main/java/acme/OrdersServer.java", `
        package acme;
        import gen.order.Wire;
        import gen.order.OrdersGrpc;
        import io.grpc.stub.StreamObserver;
        public class OrdersServer extends OrdersGrpc.OrdersImplBase {
          public void unary(Wire.Create request, StreamObserver<Wire.Result> observer) {}
          public void server(Wire.Create request, StreamObserver<Wire.Result> observer) {}
          public StreamObserver<Wire.Create> client(StreamObserver<Wire.Result> observer) { return null; }
          public StreamObserver<Wire.Create> bidi(StreamObserver<Wire.Result> observer) { return null; }
        }
      `]
    ]));
    const protoFacts = await extractFacts(protoExtractor, { repos: [repo], parsedFiles, repoResolver: () => repo });
    const debugBridge = buildProtoJavaIdentityBridge(parsedFiles, protoFacts.contractSpecs);
    const javaFile = parsedFiles.find((file) => file.language === "java")!;
    expect(debugBridge.mappings).toEqual(expect.arrayContaining([
      expect.objectContaining({ javaName: "gen.order.Wire.Create", protoName: "acme.order.v1.Create", schemaSpecId: expect.any(String) }),
      expect.objectContaining({ javaName: "gen.order.Wire.Result", protoName: "acme.order.v1.Result", schemaSpecId: expect.any(String) })
    ]));
    expect(debugBridge.resolve(javaFile.fileId, "Wire.Create")).toMatchObject({ kind: "resolved" });
    expect(debugBridge.resolveMethod(javaFile.fileId, "Orders", "Unary")).toEqual({
      fullName: "acme.order.v1.Orders/Unary",
      streaming: "unary"
    });
    const javaMethods = facts.contractSpecs.filter((node) => node.specKind === "grpc-method" && node.framework === "grpc-java");
    expect(javaMethods).toHaveLength(4);
    expect(javaMethods.map((node) => (JSON.parse(node.specJson) as { fullName: string }).fullName)).toEqual(expect.arrayContaining([
      "acme.order.v1.Orders/Unary",
      "acme.order.v1.Orders/Server",
      "acme.order.v1.Orders/Client",
      "acme.order.v1.Orders/Bidi"
    ]));
    expect(javaMethods.map((node) => (JSON.parse(node.specJson) as { streaming: string }).streaming).sort()).toEqual([
      "bidi-stream", "client-stream", "server-stream", "unary"
    ]);
    expect(facts.crossRepo.schemaInternalFacts.diagnostics.filter((diagnostic) => javaMethods.some((node) => node.id === diagnostic.ownerSpecId))).toEqual([]);
    expect(facts.crossRepo.schemaInternalFacts.roots.length).toBeGreaterThan(0);
    const bridgedRoots = facts.crossRepo.schemaInternalFacts.roots.filter((root) => javaMethods.some((node) => node.id === root.ownerSpecId));
    expect(bridgedRoots).toHaveLength(8);
    expect(facts.semanticRelations.filter((relation) => javaMethods.some((node) => node.id === relation.fromSpecId))).toHaveLength(8);
    const schemas = schemaNodes(facts.contractSpecs);
    expect(schemas.map(({ spec }) => spec.declaration.canonicalName)).toEqual(expect.arrayContaining([
      "acme.order.v1.Create", "acme.order.v1.Result"
    ]));
    const request = schemas.find(({ spec }) => spec.declaration.canonicalName === "acme.order.v1.Create")!;
    const response = schemas.find(({ spec }) => spec.declaration.canonicalName === "acme.order.v1.Result")!;
    for (const javaMethod of javaMethods) expect(facts.semanticRelations).toEqual(expect.arrayContaining([
      expect.objectContaining({ fromSpecId: javaMethod.id, toSpecId: request.node.id, kind: "REQUEST_SCHEMA" }),
      expect.objectContaining({ fromSpecId: javaMethod.id, toSpecId: response.node.id, kind: "RESPONSE_SCHEMA" })
    ]));
    expect(schemas.some(({ spec }) => spec.languageId === "java" && ["Create", "Result"].includes(spec.displayName))).toBe(false);
    expect(facts.crossRepo.schemaInternalFacts.roots.filter((root) => javaMethods.some((node) => node.id === root.ownerSpecId))
      .every((root) => root.languageId === "proto" && root.frameworkId === "grpc-java-proto-bridge")).toBe(true);
  });

  it("maps default, multiple-file, outer-class and nested generated Java identities structurally", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "repohelix-proto-bridge-"));
    directories.push(directory);
    const id = repoId("proto-bridge-identity");
    const sources = new Map([
      ["proto/default_name.proto", `syntax="proto3"; package p.one; message Top { message Inner {} }`],
      ["proto/multiple.proto", `syntax="proto3"; package p.two; option java_package="j.two"; option java_multiple_files=true; message Top { message Inner {} }`],
      ["src/main/java/use/Use.java", `
        package use;
        import p.one.DefaultName;
        import j.two.Top;
        class Use { DefaultName.Top.Inner a; Top.Inner b; }
      `]
    ]);
    const parsed = await parseSources(directory, id, sources);
    const repo = repoNode(id, directory);
    const protoFacts = await extractFacts(protoExtractor, { repos: [repo], parsedFiles: parsed, repoResolver: () => repo });
    const bridge = buildProtoJavaIdentityBridge(parsed, protoFacts.contractSpecs);
    const javaFile = parsed.find((file) => file.language === "java")!;
    expect(bridge.mappings).toEqual(expect.arrayContaining([
      expect.objectContaining({ javaName: "p.one.DefaultName.Top.Inner", protoName: "p.one.Top.Inner" }),
      expect.objectContaining({ javaName: "j.two.Top.Inner", protoName: "p.two.Top.Inner" })
    ]));
    expect(bridge.resolve(javaFile.fileId, "DefaultName.Top.Inner")).toMatchObject({ kind: "resolved", protoCanonicalName: "p.one.Top.Inner" });
    expect(bridge.resolve(javaFile.fileId, "Top.Inner")).toMatchObject({ kind: "resolved", protoCanonicalName: "p.two.Top.Inner" });
  });

  it("retains contracts and diagnostics without inventing event or gRPC schema edges", async () => {
    const { facts } = await indexSources(new Map([
      ["src/main/java/acme/Unknown.java", `
        package acme;
        import org.springframework.kafka.annotation.KafkaListener;
        import io.grpc.stub.StreamObserver;
        class Left {} class Right {}
        class AmbiguousEvents { @KafkaListener(topics="known.topic") void on(Left left, Right right) {} }
        class UnknownServer extends MissingGrpc.MissingImplBase {
          public void call(MissingRequest request, StreamObserver<MissingResponse> observer) {}
        }
      `]
    ]));
    const event = facts.contractSpecs.find((node) => node.specKind === "event")!;
    const grpc = facts.contractSpecs.find((node) => node.specKind === "grpc-method" && node.framework === "grpc-java")!;
    expect(event).toBeDefined();
    expect(grpc).toBeDefined();
    expect(facts.semanticRelations.some((relation) => relation.fromSpecId === event.id && relation.kind === "EVENT_PAYLOAD")).toBe(false);
    expect(facts.semanticRelations.some((relation) => relation.fromSpecId === grpc.id
      && (relation.kind === "REQUEST_SCHEMA" || relation.kind === "RESPONSE_SCHEMA"))).toBe(false);
    expect(facts.crossRepo.schemaInternalFacts.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ ownerSpecId: event.id, code: "ambiguous", symbol: "event-payload" }),
      expect.objectContaining({ ownerSpecId: grpc.id, code: "unresolved", symbol: "MissingRequest" }),
      expect.objectContaining({ ownerSpecId: grpc.id, code: "unresolved", symbol: "MissingResponse" })
    ]));
  });

  it("converges changed-only with clean full when a shared payload declaration changes", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "repohelix-java-framework-convergence-"));
    directories.push(directory);
    const sources = new Map([
      ["src/main/java/acme/Activity.java", `package acme; public class Activity { private String id; }`],
      ["src/main/java/acme/Api.java", `
        package acme;
        import org.apache.dubbo.config.annotation.DubboService;
        import org.springframework.context.event.EventListener;
        @DubboService interface Api { Activity call(Activity value); }
        class Events { @EventListener void on(Activity value) {} }
      `],
      ["proto/activity.proto", `
        syntax = "proto3";
        package acme.rpc;
        option java_package = "acme.generated";
        option java_multiple_files = true;
        message FetchRequest { string id = 1; }
        message FetchResponse { string id = 1; }
        service ActivityRpc { rpc Fetch(FetchRequest) returns (FetchResponse); }
      `],
      ["src/main/java/acme/ActivityRpcServer.java", `
        package acme;
        import acme.generated.ActivityRpcGrpc;
        import acme.generated.FetchRequest;
        import acme.generated.FetchResponse;
        import io.grpc.stub.StreamObserver;
        class ActivityRpcServer extends ActivityRpcGrpc.ActivityRpcImplBase {
          public void fetch(FetchRequest request, StreamObserver<FetchResponse> observer) {}
        }
      `]
    ]);
    await writeSources(directory, sources);
    const base = defaultConfig();
    const config = { ...base, systemName: "java-framework-convergence", repos: [{ name: "frameworks", path: directory }] };
    const workspaceId = deriveWorkspaceId(config.systemName);
    const incrementalDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "repohelix-framework-incremental-db-"));
    const cleanDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "repohelix-framework-clean-db-"));
    directories.push(incrementalDirectory, cleanDirectory);
    const incrementalDb = await KuzuGraphDB.open(path.join(incrementalDirectory, "graph"));
    const cleanDb = await KuzuGraphDB.open(path.join(cleanDirectory, "graph"));
    try {
      await incrementalDb.initSchema(config.systemName);
      await runIndexing(incrementalDb, config, { cwd: directory, writeMode: "auto" });
      await fs.writeFile(path.join(directory, "src/main/java/acme/Activity.java"),
        `package acme; public class Activity { private String code; private long revision; }`, "utf8");
      await fs.writeFile(path.join(directory, "src/main/java/acme/ActivityRpcServer.java"),
        `${sources.get("src/main/java/acme/ActivityRpcServer.java")!}\n// regenerated without a proto identity change`, "utf8");
      await runIndexing(incrementalDb, config, { cwd: directory, writeMode: "auto", changedOnly: true });
      const incremental = await captureSchemaBaselineSnapshot(incrementalDb, workspaceId);
      await cleanDb.initSchema(config.systemName);
      await runIndexing(cleanDb, config, { cwd: directory, writeMode: "auto" });
      const clean = await captureSchemaBaselineSnapshot(cleanDb, workspaceId);
      expect(incremental).toEqual(clean);
      const activitySchemas = clean.publicGraph.contractSpecs
        .filter((spec) => spec.specKind === "schema"
          && typeof spec.specJson === "string"
          && spec.specJson.includes('"displayName":"Activity"'))
      expect(activitySchemas).toHaveLength(1);
      expect(String(activitySchemas[0]!.specJson)).toContain("revision");
      const javaGrpc = clean.publicGraph.contractSpecs.find((spec) => spec.specKind === "grpc-method"
        && spec.framework === "grpc-java");
      const grpcDiagnostics = clean.internalIndex.diagnostics.items.filter((item) => typeof item.payload === "string"
        && item.payload.includes(String(javaGrpc?.id)));
      expect(grpcDiagnostics).toEqual([]);
      expect(clean.publicGraph.semanticRelations.filter((relation) => relation.fromSpecId === javaGrpc?.id
        && (relation.kind === "REQUEST_SCHEMA" || relation.kind === "RESPONSE_SCHEMA"))).toHaveLength(2);
    } finally {
      await incrementalDb.close();
      await cleanDb.close();
    }
  }, 120000);
});

async function indexSources(sources: Map<string, string>) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "repohelix-java-frameworks-"));
  directories.push(directory);
  const id = repoId(`java-frameworks-${directories.length}`);
  const parsedFiles = await parseSources(directory, id, sources);
  const repo = repoNode(id, directory);
  const base = defaultConfig();
  const config = { ...base, systemName: `java-frameworks-${directories.length}`, repos: [{ name: repo.name, path: directory }] };
  const facts = await buildGraphFactsBatch({
    workspaceId: deriveWorkspaceId(config.systemName), generation: "generation:test", systemName: config.systemName,
    batchId: "batch:test", indexedAt: "2026-08-03T00:00:00.000Z", repos: [repo], parsedFiles, semantic: true, config
  });
  return { facts, parsedFiles, repo };
}

async function parseSources(directory: string, id: string, sources: Map<string, string>): Promise<ParsedGraphFile[]> {
  await writeSources(directory, sources);
  const files: ParsedGraphFile[] = [];
  for (const [relativePath, source] of sources) {
    const absolutePath = path.join(directory, relativePath);
    const language = relativePath.endsWith(".proto") ? "proto" : "java";
    files.push(await parseSourceFile({ repoId: id, absolutePath, relativePath, language }));
  }
  return files;
}

async function writeSources(directory: string, sources: Map<string, string>): Promise<void> {
  for (const [relativePath, source] of sources) {
    const absolutePath = path.join(directory, relativePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, source, "utf8");
  }
}

function repoNode(id: string, directory: string): RepoNode {
  return { id, name: "java-frameworks", path: directory, remoteUrl: "", branch: "main", commitSha: "fixture", language: "java", indexedAt: "fixture" };
}

function schemaNodes(nodes: ContractSpecNode[]): { node: ContractSpecNode; spec: SchemaSpec }[] {
  return nodes.filter((node) => node.specKind === "schema").map((node) => ({ node, spec: JSON.parse(node.specJson) as SchemaSpec }));
}
