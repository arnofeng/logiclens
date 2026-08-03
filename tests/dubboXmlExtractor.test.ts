import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { dubboXmlExtractor } from "../src/core/contracts/extraction/builtin/dubboXmlExtractor.js";
import type { ExtractorFactBundle } from "../src/core/contracts/extraction/crossRepoContracts.js";
import type { DubboMethodSpec } from "../src/core/contracts/spec.js";
import { builtinLanguageForPath, parseSourceFile } from "../src/core/parsing/parserRegistry.js";
import { repoId } from "../src/shared/path.js";

async function extract(source: string): Promise<ExtractorFactBundle> {
  return extractWorkspace(source, []);
}

async function extractWorkspace(
  source: string,
  javaFiles: Array<{ path: string; source: string }>
): Promise<ExtractorFactBundle> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "test-dubbo-xml-"));
  const rel = "src/main/resources/dubbo.xml";
  const abs = path.join(dir, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, source, "utf8");
  const repo = { id: repoId("dubbo-xml"), name: "dubbo-xml", path: dir, remoteUrl: "", branch: "", commitSha: "", language: "java", indexedAt: "now" } as any;
  const parsedFiles = [await parseSourceFile({ repoId: repo.id, absolutePath: abs, relativePath: rel, language: "xml" })];
  for (const javaFile of javaFiles) {
    const javaAbs = path.join(dir, javaFile.path);
    await fs.mkdir(path.dirname(javaAbs), { recursive: true });
    await fs.writeFile(javaAbs, javaFile.source, "utf8");
    parsedFiles.push(await parseSourceFile({
      repoId: repo.id,
      absolutePath: javaAbs,
      relativePath: javaFile.path,
      language: "java"
    }));
  }
  const bundle = await dubboXmlExtractor.extract({ repos: [repo], parsedFiles, repoResolver: () => repo });
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

describe("Dubbo XML extractor", () => {
  it("routes .xml files to the source-preserving parser", async () => {
    expect(builtinLanguageForPath("src/main/resources/dubbo.xml")).toBe("xml");
  });

  it("does not retain source for unrelated XML files", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "test-plain-xml-"));
    const rel = "pom.xml";
    const abs = path.join(dir, rel);
    await fs.writeFile(abs, `<project><modelVersion>4.0.0</modelVersion></project>`, "utf8");
    const parsed = await parseSourceFile({
      repoId: repoId("plain-xml"),
      absolutePath: abs,
      relativePath: rel,
      language: "xml"
    });
    await fs.rm(dir, { recursive: true, force: true });

    expect(parsed.language).toBe("xml");
    expect("source" in parsed ? parsed.source : undefined).toBeUndefined();
  });

  it("retains source for Dubbo XML files so the extractor can inspect them", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "test-dubbo-source-"));
    const rel = "src/main/resources/dubbo.xml";
    const abs = path.join(dir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, `<beans xmlns:dubbo="http://dubbo.apache.org/schema/dubbo"><dubbo:service interface="com.acme.OrderService" /></beans>`, "utf8");
    const parsed = await parseSourceFile({
      repoId: repoId("dubbo-source"),
      absolutePath: abs,
      relativePath: rel,
      language: "xml"
    });
    await fs.rm(dir, { recursive: true, force: true });

    expect(parsed.language).toBe("xml");
    expect("source" in parsed ? parsed.source : undefined).toContain("<dubbo:service");
  });

  it("extracts service and reference declarations as interface-level specs", async () => {
    const bundle = await extract(`
      <beans xmlns:dubbo="http://dubbo.apache.org/schema/dubbo">
        <dubbo:service interface="com.acme.api.OrderService" ref="orderService" group="orders" version="1.0.0" />
        <dubbo:reference id="orderService" interface="com.acme.api.OrderService" group="orders" version="1.0.0" />
      </beans>
    `);

    expect(roleKeys(bundle, "producer")).toEqual(["com.acme.api.orderservice#*"]);
    expect(roleKeys(bundle, "consumer")).toEqual(["com.acme.api.orderservice#*"]);
    expect(specs(bundle)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        interfaceName: "com.acme.api.OrderService",
        method: "*",
        group: "orders",
        version: "1.0.0",
        config: "xml",
        framework: "dubbo-java"
      })
    ]));
  });

  it("ignores commented declarations while preserving the active declaration line", async () => {
    const bundle = await extract(`<beans xmlns:dubbo="http://dubbo.apache.org/schema/dubbo">
      <!--
        <dubbo:service interface="com.acme.api.OrderService" ref="oldOrderService" />
      -->
      <dubbo:service interface="com.acme.api.OrderService" ref="orderService" />
    </beans>`);

    expect(bundle.contractSpecs).toHaveLength(1);
    expect(bundle.evidence).toHaveLength(1);
    expect(bundle.evidence[0]!.line).toBe(5);
    expect(bundle.evidence[0]!.raw).toContain("ref=\"orderService\"");
  });

  it("extracts explicitly configured Dubbo methods instead of an interface wildcard", async () => {
    const bundle = await extract(`<beans xmlns:dubbo="http://dubbo.apache.org/schema/dubbo">
      <dubbo:service interface="com.acme.api.OrderService" ref="orderService">
        <dubbo:method name="createOrder" timeout="1000" />
      </dubbo:service>
    </beans>`);

    expect(roleKeys(bundle, "producer")).toEqual(["com.acme.api.orderservice#createOrder"]);
    expect(specs(bundle)).toEqual([
      expect.objectContaining({ interfaceName: "com.acme.api.OrderService", method: "createOrder" })
    ]);
  });

  it("resolves an XML service ref to exact methods on its Java implementation", async () => {
    const bundle = await extractWorkspace(
      `<beans xmlns:dubbo="http://dubbo.apache.org/schema/dubbo">
        <dubbo:service interface="com.acme.api.OrderService" ref="orderServiceImpl" />
      </beans>`,
      [{
        path: "src/main/java/com/acme/server/OrderServiceImpl.java",
        source: `package com.acme.server;
          import com.acme.api.OrderService;
          import org.springframework.stereotype.Component;
          @Component
          public class OrderServiceImpl implements OrderService {
            public String createOrder(CreateOrderRequest request) { return "ok"; }
            public void cancelOrder(CancelOrderRequest request) {}
          }`
      }]
    );

    expect(roleKeys(bundle, "producer")).toEqual([
      "com.acme.api.orderservice#cancelOrder",
      "com.acme.api.orderservice#createOrder"
    ]);
    expect(specs(bundle).map((spec) => spec.method).sort()).toEqual(["cancelOrder", "createOrder"]);
    expect(bundle.contractSpecs.every((spec) => spec.fileId.includes("OrderServiceImpl.java"))).toBe(true);
    expect(bundle.evidence.every((evidence) => evidence.rule === "dubbo-xml-service-implementation")).toBe(true);
  });

  it("uses the declared service interface, including inherited methods, as typed XML roots", async () => {
    const bundle = await extractWorkspace(
      `<beans xmlns:dubbo="http://dubbo.apache.org/schema/dubbo">
        <dubbo:service interface="com.acme.api.ActivityService" ref="activityService" />
      </beans>`,
      [{
        path: "src/main/java/com/acme/api/ActivityService.java",
        source: `package com.acme.api;
          interface BaseService { Activity exchange(Activity value); }
          interface ActivityService extends BaseService {}`
      }]
    );

    expect(specs(bundle)).toEqual([
      expect.objectContaining({
        method: "exchange",
        requestSlots: [{ index: 0, name: "value", type: "Activity" }],
        responseType: "Activity",
        methodSignature: "exchange(Activity):Activity"
      })
    ]);
    expect(bundle.evidence[0]!.rule).toBe("dubbo-xml-service-interface");
  });

  it("ignores unrelated XML", async () => {
    const bundle = await extract(`<beans><bean id="plain" class="com.acme.Plain" /></beans>`);
    expect(bundle.contractSpecs).toHaveLength(0);
  });

  it("uses distinct symbol ids for repeated interface declarations", async () => {
    const bundle = await extract(`
      <beans xmlns:dubbo="http://dubbo.apache.org/schema/dubbo">
        <dubbo:service interface="com.acme.api.OrderService" group="orders" />
        <dubbo:service interface="com.acme.api.OrderService" group="billing" />
      </beans>
    `);

    const sourceSymbolIds = bundle.contractSpecs.map((spec) => spec.sourceSymbolId);
    expect(new Set(sourceSymbolIds).size).toBe(2);
  });
});
