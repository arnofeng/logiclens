import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseSourceFile } from "../src/core/parsing/parserRegistry.js";
import type { SourceLanguage } from "../src/core/parsing/types.js";
import type { ExtractorFactBundle } from "../src/core/contracts/extraction/crossRepoContracts.js";
import type { GrpcMethodSpec } from "../src/core/contracts/spec.js";
import { javaGrpcExtractor } from "../src/core/contracts/extraction/builtin/javaGrpcExtractor.js";
import { pythonGrpcExtractor } from "../src/core/contracts/extraction/builtin/pythonGrpcExtractor.js";
import { jsGrpcExtractor } from "../src/core/contracts/extraction/builtin/jsGrpcExtractor.js";
import { repoId } from "../src/shared/path.js";

async function extractOne(
  language: SourceLanguage,
  relPath: string,
  source: string,
  extractor: { extract(context: any): Promise<ExtractorFactBundle> }
): Promise<ExtractorFactBundle> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "test-grpc-multilang-"));
  const abs = path.join(dir, relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, source, "utf8");

  const repo = {
    id: repoId(`${language}-grpc-repo`),
    name: `${language}-grpc-repo`,
    path: dir,
    remoteUrl: "",
    branch: "",
    commitSha: "",
    language,
    indexedAt: "now"
  } as any;

  const parsed = await parseSourceFile({
    repoId: repo.id,
    absolutePath: abs,
    relativePath: relPath,
    language
  });

  const bundle = await extractor.extract({
    repos: [repo],
    parsedFiles: [parsed],
    repoResolver: () => repo
  });

  await fs.rm(dir, { recursive: true, force: true });
  return bundle;
}

function specs(bundle: ExtractorFactBundle): GrpcMethodSpec[] {
  return bundle.contractSpecs.map((row) => JSON.parse(row.specJson) as GrpcMethodSpec);
}

function roleKeys(bundle: ExtractorFactBundle, role: "producer" | "consumer"): string[] {
  const contractIds = new Set(bundle.repoContracts.filter((edge) => edge.role === role).map((edge) => edge.contractId));
  return bundle.contracts
    .filter((contract) => contractIds.has(contract.id))
    .map((contract) => contract.key)
    .sort();
}

describe("multi-language gRPC extractors", () => {
  it("extracts Java grpc-java producers and consumers", async () => {
    const bundle = await extractOne("java", "src/main/java/acme/OrderEndpoint.java", `
      package acme;
      import io.grpc.stub.StreamObserver;

      class OrderEndpoint extends OrderServiceGrpc.OrderServiceImplBase {
        @Override
        public void createOrder(CreateOrderRequest request, StreamObserver<Order> responseObserver) {
        }

        private void helperLog(String message) {
        }

        int compute(int value) {
          return value + 1;
        }

        void call(OrderServiceGrpc.OrderServiceBlockingStub stub) {
          CreateOrderRequest request = CreateOrderRequest.newBuilder().build();
          stub.createOrder(request);
        }
      }

      class ClientHolder {
        void run(io.grpc.Channel channel) {
          OrderServiceGrpc.OrderServiceBlockingStub client = OrderServiceGrpc.newBlockingStub(channel);
          client.createOrder(CreateOrderRequest.newBuilder().build());
        }
      }
    `, javaGrpcExtractor);

    expect(roleKeys(bundle, "producer")).toEqual(["OrderService/CreateOrder"]);
    expect(roleKeys(bundle, "consumer")).toEqual(["OrderService/CreateOrder"]);
    const producer = specs(bundle).find((spec) => spec.framework === "grpc-java" && spec.requestType === "CreateOrderRequest" && spec.responseType === "Order");
    expect(producer).toMatchObject({ service: "OrderService", method: "CreateOrder", streaming: "unary" });
  });

  it("extracts Python grpcio producers and consumers", async () => {
    const bundle = await extractOne("python", "service/order_service.py", `
      import grpc
      import order_pb2
      import order_pb2_grpc

      class OrderService(order_pb2_grpc.OrderServiceServicer):
          def CreateOrder(self, request, context):
              return order_pb2.Order()

          def HelperPublic(self, value):
              return value

      def call(channel):
          stub = order_pb2_grpc.OrderServiceStub(channel)
          return stub.CreateOrder(order_pb2.CreateOrderRequest(user_id="u1"))
    `, pythonGrpcExtractor);

    expect(roleKeys(bundle, "producer")).toEqual(["OrderService/CreateOrder"]);
    expect(roleKeys(bundle, "consumer")).toEqual(["OrderService/CreateOrder"]);
    expect(specs(bundle)).toEqual(expect.arrayContaining([
      expect.objectContaining({ framework: "grpc-python", service: "OrderService", method: "CreateOrder" })
    ]));
  });

  it("extracts @grpc/grpc-js producers and consumers", async () => {
    const bundle = await extractOne("typescript", "src/order-grpc.ts", `
      import * as grpc from "@grpc/grpc-js";
      import { OrderServiceClient, OrderServiceService } from "./generated/order";

      const server = new grpc.Server();
      server.addService(OrderServiceService, {
        createOrder(call: any, callback: any) {
          callback(null, {});
        }
      });

      const client = new OrderServiceClient("localhost:50051", grpc.credentials.createInsecure());
      client.createOrder({ userId: "u1" }, () => {});
    `, jsGrpcExtractor);

    expect(roleKeys(bundle, "producer")).toEqual(["OrderService/CreateOrder"]);
    expect(roleKeys(bundle, "consumer")).toEqual(["OrderService/CreateOrder"]);
    expect(specs(bundle)).toEqual(expect.arrayContaining([
      expect.objectContaining({ framework: "grpc-js", service: "OrderService", method: "CreateOrder" })
    ]));
    const producerEvidenceIds = new Set(bundle.repoContracts.filter((edge) => edge.role === "producer").map((edge) => edge.evidenceId));
    const producerSpecs = bundle.contractSpecs
      .filter((row) => producerEvidenceIds.has(row.evidenceId))
      .map((row) => JSON.parse(row.specJson) as GrpcMethodSpec);
    expect(producerSpecs).toEqual(expect.arrayContaining([
      expect.objectContaining({ framework: "grpc-js", service: "OrderService", method: "CreateOrder" })
    ]));
    const consumerEvidenceIds = new Set(bundle.repoContracts.filter((edge) => edge.role === "consumer").map((edge) => edge.evidenceId));
    const consumerSpecs = bundle.contractSpecs
      .filter((row) => consumerEvidenceIds.has(row.evidenceId))
      .map((row) => JSON.parse(row.specJson) as GrpcMethodSpec);
    expect(consumerSpecs).toHaveLength(1);
    expect(consumerSpecs[0]).toMatchObject({ framework: "grpc-js", service: "OrderService", method: "CreateOrder" });
    expect(consumerSpecs[0]?.requestType).toBeUndefined();
  });

  it("detects Java request-streaming server methods", async () => {
    const bundle = await extractOne("java", "src/main/java/acme/Stream.java", `
      import io.grpc.stub.StreamObserver;
      class StreamEndpoint extends ChatServiceGrpc.ChatServiceImplBase {
        public void send(SendRequest request, StreamObserver<Ack> responseObserver) {}
        public StreamObserver<ChatMessage> collect(StreamObserver<Summary> responseObserver) { return null; }
      }
    `, javaGrpcExtractor);

    const byMethod = Object.fromEntries(specs(bundle).map((s) => [s.method, s.streaming]));
    // unary/server-streaming are indistinguishable from the ImplBase signature → unary
    expect(byMethod["Send"]).toBe("unary");
    expect(byMethod["Collect"]).toBe("client-stream");
  });

  it("detects Python servicer streaming kinds", async () => {
    const bundle = await extractOne("python", "service/chat.py", `
      import chat_pb2_grpc
      class ChatService(chat_pb2_grpc.ChatServiceServicer):
          def Unary(self, request, context):
              return 1
          def ServerStream(self, request, context):
              yield 1
          def ClientStream(self, request_iterator, context):
              return 2
          def BidiStream(self, request_iterator, context):
              yield 3
    `, pythonGrpcExtractor);

    const byMethod = Object.fromEntries(specs(bundle).map((s) => [s.method, s.streaming]));
    expect(byMethod).toEqual({
      Unary: "unary",
      ServerStream: "server-stream",
      ClientStream: "client-stream",
      BidiStream: "bidi-stream"
    });
  });

  it("detects @grpc/grpc-js handler streaming kinds", async () => {
    const bundle = await extractOne("typescript", "src/chat-grpc.ts", `
      import * as grpc from "@grpc/grpc-js";
      import { ChatServiceService } from "./generated/chat";
      const server = new grpc.Server();
      server.addService(ChatServiceService, {
        unary(call: any, callback: any) { callback(null, {}); },
        serverStream(call: any) { call.write({}); call.end(); },
        clientStream(call: any, callback: any) { call.on('data', () => {}); },
        bidiStream(call: any) { call.on('data', () => {}); call.write({}); }
      });
    `, jsGrpcExtractor);

    const byMethod = Object.fromEntries(specs(bundle).map((s) => [s.method, s.streaming]));
    expect(byMethod).toEqual({
      Unary: "unary",
      ServerStream: "server-stream",
      ClientStream: "client-stream",
      BidiStream: "bidi-stream"
    });
  });
});
