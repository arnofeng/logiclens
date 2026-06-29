import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { javaDubboExtractor } from "../src/core/contracts/extraction/builtin/javaDubboExtractor.js";
import type { ExtractorFactBundle } from "../src/core/contracts/extraction/crossRepoContracts.js";
import type { DubboMethodSpec } from "../src/core/contracts/spec.js";
import { parseSourceFile } from "../src/core/parsing/parserRegistry.js";
import { repoId } from "../src/shared/path.js";

async function extract(source: string): Promise<ExtractorFactBundle> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-java-dubbo-"));
  const rel = "src/main/java/com/acme/order/OrderDubbo.java";
  const abs = path.join(dir, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, source, "utf8");
  const repo = { id: repoId("java-dubbo"), name: "java-dubbo", path: dir, remoteUrl: "", branch: "", commitSha: "", language: "java", indexedAt: "now" } as any;
  const parsed = await parseSourceFile({ repoId: repo.id, absolutePath: abs, relativePath: rel, language: "java" });
  const bundle = await javaDubboExtractor.extract({ repos: [repo], parsedFiles: [parsed], repoResolver: () => repo });
  await fs.rm(dir, { recursive: true, force: true });
  return bundle;
}

function specs(bundle: ExtractorFactBundle): DubboMethodSpec[] {
  return bundle.contractSpecs.map((row) => JSON.parse(row.specJson) as DubboMethodSpec);
}

function roleKeys(bundle: ExtractorFactBundle, role: "producer" | "consumer"): string[] {
  const contractIds = new Set(bundle.repoContracts.filter((edge) => edge.role === role).map((edge) => edge.contractId));
  return bundle.contracts
    .filter((contract) => contractIds.has(contract.id))
    .map((contract) => contract.key)
    .sort();
}

describe("Java Dubbo extractor", () => {
  it("extracts @DubboService producers", async () => {
    const bundle = await extract(`
      package com.acme.order;
      import org.apache.dubbo.config.annotation.DubboService;
      import com.acme.api.OrderService;

      @DubboService(group = "orders", version = "1.0.0")
      class OrderServiceImpl implements OrderService {
        public OrderResponse createOrder(CreateOrderRequest request) { return null; }
        public void cancelOrder(String orderId) {}
      }
    `);

    expect(roleKeys(bundle, "producer")).toEqual([
      "com.acme.api.orderservice#cancelOrder",
      "com.acme.api.orderservice#createOrder"
    ]);
    expect(specs(bundle)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "dubbo-method",
        interfaceName: "com.acme.api.OrderService",
        method: "createOrder",
        requestTypes: ["CreateOrderRequest"],
        responseType: "OrderResponse",
        group: "orders",
        version: "1.0.0",
        config: "annotation",
        framework: "dubbo-java"
      })
    ]));
  });

  it("extracts @DubboReference consumers from field calls", async () => {
    const bundle = await extract(`
      package com.acme.web;
      import org.apache.dubbo.config.annotation.DubboReference;
      import com.acme.api.OrderService;
      import com.acme.dto.CreateOrderRequest;

      class OrderController {
        @DubboReference(group = "orders", version = "1.0.0")
        private OrderService orderService;

        public void submit() {
          orderService.createOrder(new CreateOrderRequest());
          orderService.createOrder(new CreateOrderRequest());
        }
      }
    `);

    expect(roleKeys(bundle, "consumer")).toEqual(["com.acme.api.orderservice#createOrder"]);
    expect(specs(bundle)).toEqual([
      expect.objectContaining({
        interfaceName: "com.acme.api.OrderService",
        method: "createOrder",
        requestTypes: ["CreateOrderRequest"],
        group: "orders",
        version: "1.0.0",
        config: "annotation"
      })
    ]);
  });

  it("does not treat Spring @Service as Dubbo without a Dubbo import", async () => {
    const bundle = await extract(`
      package com.acme.order;
      import org.springframework.stereotype.Service;
      import com.acme.api.OrderService;

      @Service
      class OrderServiceImpl implements OrderService {
        public OrderResponse createOrder(CreateOrderRequest request) { return null; }
      }
    `);

    expect(bundle.contractSpecs).toHaveLength(0);
    expect(bundle.contracts).toHaveLength(0);
  });

  it("allows legacy Dubbo @Service only when imported from Dubbo", async () => {
    const bundle = await extract(`
      package com.acme.order;
      import org.apache.dubbo.config.annotation.Service;
      import com.acme.api.OrderService;

      @Service
      class OrderServiceImpl implements OrderService {
        public OrderResponse createOrder(CreateOrderRequest request) { return null; }
      }
    `);

    expect(roleKeys(bundle, "producer")).toEqual(["com.acme.api.orderservice#createOrder"]);
  });

  it("detects this.field consumer calls", async () => {
    const bundle = await extract(`
      package com.acme.web;
      import org.apache.dubbo.config.annotation.DubboReference;
      import com.acme.api.OrderService;
      import com.acme.dto.CreateOrderRequest;

      class OrderController {
        @DubboReference
        private OrderService orderService;

        public void submit() {
          this.orderService.createOrder(new CreateOrderRequest());
        }
      }
    `);

    expect(roleKeys(bundle, "consumer")).toEqual(["com.acme.api.orderservice#createOrder"]);
  });

  it("does not extract nested class methods as outer Dubbo service methods", async () => {
    const bundle = await extract(`
      package com.acme.order;
      import org.apache.dubbo.config.annotation.DubboService;
      import com.acme.api.OrderService;

      @DubboService
      class OrderServiceImpl implements OrderService {
        public OrderResponse createOrder(CreateOrderRequest request) { return null; }
        class Helper {
          public void helperMethod() {}
        }
      }
    `);

    expect(roleKeys(bundle, "producer")).toEqual(["com.acme.api.orderservice#createOrder"]);
  });

  it("prefers service-like interface when a class implements multiple interfaces", async () => {
    const bundle = await extract(`
      package com.acme.order;
      import org.apache.dubbo.config.annotation.DubboService;
      import com.acme.api.OrderService;
      import org.springframework.beans.factory.InitializingBean;

      @DubboService
      class OrderServiceImpl implements InitializingBean, OrderService {
        public OrderResponse createOrder(CreateOrderRequest request) { return null; }
      }
    `);

    expect(roleKeys(bundle, "producer")).toEqual(["com.acme.api.orderservice#createOrder"]);
    expect(specs(bundle)[0]).toMatchObject({ interfaceName: "com.acme.api.OrderService" });
  });
});
