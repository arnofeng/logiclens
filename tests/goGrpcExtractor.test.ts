import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseSourceFile } from "../src/core/parsing/parserRegistry.js";
import { goGrpcExtractor } from "../src/core/contracts/extraction/builtin/goGrpcExtractor.js";
import { repoId } from "../src/shared/path.js";
import type { ExtractorFactBundle } from "../src/core/contracts/extraction/crossRepoContracts.js";
import type { GrpcMethodSpec } from "../src/core/contracts/spec.js";

async function extract(serverSource: string, clientSource: string): Promise<ExtractorFactBundle> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "test-go-grpc-extractor-"));
  
  const serverRel = "server/order_server.go";
  const serverAbs = path.join(dir, serverRel);
  await fs.mkdir(path.dirname(serverAbs), { recursive: true });
  await fs.writeFile(serverAbs, serverSource, "utf8");

  const clientRel = "client/order_client.go";
  const clientAbs = path.join(dir, clientRel);
  await fs.mkdir(path.dirname(clientAbs), { recursive: true });
  await fs.writeFile(clientAbs, clientSource, "utf8");
  
  const repo = {
    id: repoId("order-repo"),
    name: "order-repo",
    path: dir,
    remoteUrl: "",
    branch: "",
    commitSha: "",
    language: "go",
    indexedAt: "now"
  } as any;

  const parsedServer = await parseSourceFile({
    repoId: repo.id,
    absolutePath: serverAbs,
    relativePath: serverRel,
    language: "go"
  });

  const parsedClient = await parseSourceFile({
    repoId: repo.id,
    absolutePath: clientAbs,
    relativePath: clientRel,
    language: "go"
  });

  const bundle = await goGrpcExtractor.extract({
    repos: [repo],
    parsedFiles: [parsedServer, parsedClient],
    repoResolver: () => repo
  });

  await fs.rm(dir, { recursive: true, force: true });
  return bundle;
}

describe("Go gRPC Extractor", () => {
  it("extracts gRPC producers (servers) and consumers (client calls)", async () => {
    const serverSource = `
      package main

      import (
        "context"
        pb "github.com/acme/order/v1"
      )

      type orderServer struct {
        pb.UnimplementedOrderServiceServer
      }

      func (s *orderServer) CreateOrder(ctx context.Context, req *pb.CreateOrderRequest) (*pb.Order, error) {
        return nil, nil
      }

      func (s *orderServer) GetOrder(ctx context.Context, req *pb.GetOrderRequest) (*pb.Order, error) {
        return nil, nil
      }

      // Server streaming method
      func (s *orderServer) ListOrders(req *pb.ListOrdersRequest, stream pb.OrderService_ListOrdersServer) error {
        return nil
      }
    `;

    const clientSource = `
      package main

      import (
        "context"
        pb "github.com/acme/order/v1"
      )

      func callClient(conn grpc.ClientConnInterface) {
        c := pb.NewOrderServiceClient(conn)
        // Call CreateOrder twice (should deduplicate client contracts/specs)
        c.CreateOrder(context.Background(), &pb.CreateOrderRequest{UserId: "123"})
        c.CreateOrder(context.Background(), &pb.CreateOrderRequest{UserId: "456"})
        
        c.ListOrders(context.Background(), &pb.ListOrdersRequest{})
      }
    `;

    const bundle = await extract(serverSource, clientSource);

    // --- Assert Producer Contracts ---
    const serverContracts = bundle.contracts.filter(
      (c) => bundle.repoContracts.some((rc) => rc.contractId === c.id && rc.role === "producer")
    );
    expect(serverContracts).toHaveLength(3);

    const createOrderProducer = serverContracts.find((c) => c.key === "OrderService/CreateOrder");
    expect(createOrderProducer).toBeDefined();

    const getOrderProducer = serverContracts.find((c) => c.key === "OrderService/GetOrder");
    expect(getOrderProducer).toBeDefined();

    const listOrdersProducer = serverContracts.find((c) => c.key === "OrderService/ListOrders");
    expect(listOrdersProducer).toBeDefined();

    // Verify producer spec details (Unary)
    const createOrderSpecRow = bundle.contractSpecs.find((s) => s.contractId === createOrderProducer!.id);
    expect(createOrderSpecRow).toBeDefined();
    const createOrderSpec = JSON.parse(createOrderSpecRow!.specJson) as GrpcMethodSpec;
    expect(createOrderSpec.kind).toBe("grpc-method");
    expect(createOrderSpec.service).toBe("OrderService");
    expect(createOrderSpec.method).toBe("CreateOrder");
    expect(createOrderSpec.package).toBeUndefined(); // Go side leaves package undefined
    expect(createOrderSpec.requestType).toBe("CreateOrderRequest");
    expect(createOrderSpec.responseType).toBe("Order");
    expect(createOrderSpec.streaming).toBe("unary");

    // Verify producer spec details (Server streaming)
    const listOrdersSpecRow = bundle.contractSpecs.find((s) => s.contractId === listOrdersProducer!.id);
    expect(listOrdersSpecRow).toBeDefined();
    const listOrdersSpec = JSON.parse(listOrdersSpecRow!.specJson) as GrpcMethodSpec;
    expect(listOrdersSpec.kind).toBe("grpc-method");
    expect(listOrdersSpec.service).toBe("OrderService");
    expect(listOrdersSpec.method).toBe("ListOrders");
    expect(listOrdersSpec.package).toBeUndefined(); // Go side leaves package undefined
    expect(listOrdersSpec.requestType).toBe("ListOrdersRequest");
    expect(listOrdersSpec.responseType).toBeUndefined();
    expect(listOrdersSpec.streaming).toBe("server-stream");

    // --- Assert Consumer Contracts ---
    const clientContracts = bundle.contracts.filter(
      (c) => bundle.repoContracts.some((rc) => rc.contractId === c.id && rc.role === "consumer")
    );
    // Expecting 2 unique consumer methods (CreateOrder and ListOrders) due to deduplication
    expect(clientContracts).toHaveLength(2);

    const createOrderConsumer = clientContracts.find((c) => c.key === "OrderService/CreateOrder");
    expect(createOrderConsumer).toBeDefined();

    const consumerSpecRow = bundle.contractSpecs.find((s) => s.contractId === createOrderConsumer!.id);
    expect(consumerSpecRow).toBeDefined();
    const consumerSpec = JSON.parse(consumerSpecRow!.specJson) as GrpcMethodSpec;
    expect(consumerSpec.kind).toBe("grpc-method");
    expect(consumerSpec.service).toBe("OrderService");
    expect(consumerSpec.method).toBe("CreateOrder");
    expect(consumerSpec.package).toBeUndefined(); // Go side leaves package undefined
    expect(consumerSpec.requestType).toBe("CreateOrderRequest");
  });
});
