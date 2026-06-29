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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-dubbo-xml-"));
  const rel = "src/main/resources/dubbo.xml";
  const abs = path.join(dir, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, source, "utf8");
  const repo = { id: repoId("dubbo-xml"), name: "dubbo-xml", path: dir, remoteUrl: "", branch: "", commitSha: "", language: "java", indexedAt: "now" } as any;
  const parsed = await parseSourceFile({ repoId: repo.id, absolutePath: abs, relativePath: rel, language: "xml" });
  const bundle = await dubboXmlExtractor.extract({ repos: [repo], parsedFiles: [parsed], repoResolver: () => repo });
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
