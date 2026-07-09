import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ExtractionBuilder } from "../src/core/contracts/extraction/extractionBuilder.js";
import { normalizePublicFacts } from "../src/core/plugins/publicFactNormalizer.js";
import { adaptFactExtractor, adaptFrameworkDetector, adaptLanguageParser } from "../src/core/plugins/adapter.js";
import { clearRegisteredPluginCapabilities, registerLoadedPlugins } from "../src/core/plugins/register.js";
import { ContractExtractorRegistry, FrameworkDetectorRegistry, contractExtractorRegistry, frameworkDetectorRegistry, parserRegistry } from "../src/core/registries/registry.js";
import { registerBuiltinParsers } from "../src/core/parsing/parserRegistry.js";
import { validatePlugin } from "@logiclens/plugin-runtime";
import { LOGICLENS_PLUGIN_API_VERSION, definePlugin } from "@logiclens/plugin-sdk";
import { joinHttpPaths, normalizeRouteTemplate } from "@logiclens/plugin-sdk/utils";

describe("plugin architecture foundation", () => {
  it("publishes plugin APIs as workspace packages only", async () => {
    const packageJson = JSON.parse(await fs.readFile(path.resolve("package.json"), "utf8")) as {
      exports?: Record<string, { types?: string; default?: string }>;
      dependencies?: Record<string, string>;
    };

    expect(packageJson.exports?.["./plugin-sdk"]).toBeUndefined();
    expect(packageJson.exports?.["./plugin-sdk/utils"]).toBeUndefined();
    expect(packageJson.exports?.["./plugin-runtime"]).toBeUndefined();
    expect(packageJson.dependencies?.["@logiclens/plugin-sdk"]).toBe("0.1.0");
    expect(packageJson.dependencies?.["@logiclens/plugin-runtime"]).toBe("0.1.0");
  });

  it("keeps plugin SDK free of core imports", async () => {
    const sdkSources = await Promise.all([
      fs.readFile(path.resolve("packages/plugin-sdk/src/index.ts"), "utf8"),
      fs.readFile(path.resolve("packages/plugin-sdk/src/utils.ts"), "utf8")
    ]);
    const sdkSource = sdkSources.join("\n");
    for (const blocked of ["src/core", "../core", "FactCollector", "ContractSpecNode", "ParsedFile"]) {
      expect(sdkSource).not.toContain(blocked);
    }
  });

  it("normalizes public HTTP and schema facts into internal extracted facts", () => {
    const builder = new ExtractionBuilder();
    normalizePublicFacts([
      {
        kind: "httpEndpoint",
        repoId: "repo:orders",
        filePath: "Controllers/OrdersController.cs",
        method: "get",
        rawPath: "api/[controller]/{id:int}",
        path: joinHttpPaths("api/orders", normalizeRouteTemplate("{id:int}")),
        role: "producer",
        framework: "aspnet-core",
        evidence: {
          repoId: "repo:orders",
          filePath: "Controllers/OrdersController.cs",
          line: 12,
          raw: "[HttpGet(\"{id:int}\")]",
          rule: "aspnet-http-attribute",
          confidence: "exact"
        }
      },
      {
        kind: "schema",
        repoId: "repo:orders",
        filePath: "Dtos/OrderDto.cs",
        name: "OrderDto",
        language: "csharp",
        fields: [{ name: "id", type: "string", optional: false }],
        evidence: {
          repoId: "repo:orders",
          filePath: "Dtos/OrderDto.cs",
          line: 3,
          raw: "public record OrderDto(string Id);",
          rule: "csharp-schema-record",
          confidence: 0.8
        }
      }
    ], builder);

    const facts = builder.build();
    expect(facts.contractSpecs.some((spec) =>
      spec.specKind === "http-endpoint" &&
      spec.httpMethod === "GET" &&
      spec.pathTemplate === "/api/orders/{id}" &&
      spec.framework === "aspnet-core"
    )).toBe(true);
    expect(facts.contractSpecs.some((spec) =>
      spec.specKind === "schema" &&
      spec.specJson.includes("\"language\":\"csharp\"")
    )).toBe(true);
    expect(facts.evidence.map((item) => item.rule)).toContain("aspnet-http-attribute");
  });

  it("allows external capabilities to register without replacing builtins", () => {
    const contractExtractors = new ContractExtractorRegistry();
    const frameworkDetectors = new FrameworkDetectorRegistry();
    contractExtractors.register({
      name: "test:plugin-extractor",
      languages: ["test-lang"],
      extract() {}
    });
    frameworkDetectors.register({
      name: "test:plugin-detector",
      detect() {
        return [];
      }
    });

    expect(contractExtractors.names()).toContain("test:plugin-extractor");
    expect(frameworkDetectors.names()).toContain("test:plugin-detector");
  });

  it("adapts SDK fact extractors into core contract extractors", async () => {
    const extractor = adaptFactExtractor({
      name: "plugin:csharp-schema",
      languages: ["csharp"],
      extract(ctx) {
        const file = ctx.files.byLanguage("csharp")[0];
        if (!file) return;
        ctx.emit.schema({
          repoId: file.repoId,
          filePath: file.path,
          name: "OrderDto",
          language: "csharp",
          fields: [{ name: "id", type: "string", optional: false }],
          evidence: {
            filePath: file.path,
            line: 1,
            raw: "public record OrderDto(string Id);",
            rule: "plugin-csharp-schema",
            confidence: "probable"
          }
        });
      },
      postExtract(ctx) {
        if (ctx.facts.schemas().some((schema) => schema.name === "OrderDto")) {
          ctx.emit.packageUsage({
            repoId: "repo:orders",
            filePath: "Orders.csproj",
            packageName: "Microsoft.AspNetCore.App",
            evidence: {
              filePath: "Orders.csproj",
              line: 1,
              raw: "<FrameworkReference Include=\"Microsoft.AspNetCore.App\" />",
              rule: "plugin-csproj-framework-reference",
              confidence: "exact"
            }
          });
        }
      }
    });

    const builder = new ExtractionBuilder();
    const parsedFiles = [{
      repoId: "repo:orders",
      fileId: "file:repo:orders:OrderDto.cs",
      path: "OrderDto.cs",
      language: "csharp",
      hash: "h",
      loc: 1,
      source: "public record OrderDto(string Id);",
      imports: [],
      symbols: [],
      calls: []
    }];
    await extractor.extract({
      repos: [{ id: "repo:orders", name: "orders", path: ".", remoteUrl: "", branch: "", commitSha: "", language: "csharp", indexedAt: "now" }],
      parsedFiles
    }, builder);
    const firstPass = builder.build();
    await extractor.postExtract?.({ mergedFacts: firstPass, repos: [], parsedFiles: [] }, builder);
    const facts = builder.build();

    expect(facts.contractSpecs.some((spec) => spec.specKind === "schema" && spec.specJson.includes("OrderDto"))).toBe(true);
    expect(facts.packageUsages.some((usage) => usage.packageName === "Microsoft.AspNetCore.App")).toBe(true);
  });

  it("adapts SDK framework detectors into core framework detectors", async () => {
    const detector = adaptFrameworkDetector({
      name: "plugin:csharp-framework-detector",
      detect(ctx) {
        const repo = ctx.repos[0]!;
        ctx.emit.framework({
          repoId: repo.id,
          name: "csharp:aspnet-core",
          language: "csharp",
          evidence: [{
            filePath: "Orders.csproj",
            line: 1,
            raw: "Microsoft.AspNetCore.App",
            rule: "plugin-csproj-aspnet-core",
            confidence: "exact"
          }]
        });
      }
    });

    const frameworks = await detector.detect(
      { id: "repo:orders", name: "orders", path: ".", remoteUrl: "", branch: "", commitSha: "", language: "csharp", indexedAt: "now" },
      []
    );
    expect(frameworks[0]?.name).toBe("csharp:aspnet-core");
    expect(frameworks[0]?.evidence[0]?.rule).toBe("plugin-csproj-aspnet-core");
  });

  it("adapts SDK language parsers into core language parsers", async () => {
    const parser = adaptLanguageParser({
      id: "toy",
      extensions: [".toy"],
      parse(input) {
        return {
          symbols: [{
            kind: "class",
            name: "Order",
            startLine: 1,
            endLine: 1,
            signature: "class Order"
          }],
          imports: [{ module: "shared.contracts", raw: "use shared.contracts", line: 1 }],
          calls: [{ callerSymbolName: "Order", calleeName: "Validate", raw: "Validate()", line: 1 }]
        };
      }
    });

    const parsed = await parser!.parse({
      repoId: "repo:toy",
      absolutePath: "Order.toy",
      relativePath: "Order.toy",
      language: "toy",
      source: "class Order",
      fileId: "file:repo:toy:Order.toy",
      hash: "h"
    });

    expect("symbols" in parsed && parsed.symbols[0]?.name).toBe("Order");
    expect("imports" in parsed && parsed.imports[0]?.module).toBe("shared.contracts");
    expect("calls" in parsed && parsed.calls[0]?.callerSymbolId).toBeDefined();
  });

  it("validates plugin manifests against the public API version", () => {
    const plugin = definePlugin({
      manifest: {
        name: "test-plugin",
        version: "0.0.1",
        logiclensPluginApiVersion: LOGICLENS_PLUGIN_API_VERSION,
        capabilities: ["fact-extractor"]
      },
      factExtractors: []
    });

    expect(() => validatePlugin(plugin, "test-plugin")).not.toThrow();
    expect(() => validatePlugin({
      manifest: {
        name: "bad-plugin",
        version: "0.0.1",
        logiclensPluginApiVersion: "999.0.0",
        capabilities: ["fact-extractor"]
      }
    }, "bad-plugin")).toThrow(/requires plugin API/);
  });

  it("lets language plugins declare AST fact extraction without core types", () => {
    const plugin = definePlugin({
      manifest: {
        name: "csharp-plugin",
        version: "0.0.1",
        logiclensPluginApiVersion: LOGICLENS_PLUGIN_API_VERSION,
        capabilities: ["language", "fact-extractor"]
      },
      languages: [{
        id: "csharp",
        extensions: [".cs"],
        parse() {
          return { symbols: [] };
        },
        facts: {
          queries: {
            annotations: "(attribute_list) @annotation",
            literals: "(string_literal) @literal"
          },
          extract(input) {
            return {
              packageName: input.filePath.includes("/") ? input.filePath.split("/")[0] : undefined,
              annotations: []
            };
          }
        }
      }],
      factExtractors: [{
        name: "csharp:test",
        extract() {},
        postExtract(ctx) {
          ctx.facts.httpEndpoints();
          ctx.facts.schemas();
        }
      }]
    });

    expect(plugin.languages?.[0]?.facts?.queries?.annotations).toContain("attribute_list");
    expect(plugin.factExtractors?.[0]?.postExtract).toBeDefined();
  });

  it("clears plugin-registered capabilities between config loads", () => {
    clearRegisteredPluginCapabilities();
    registerLoadedPlugins([{
      source: "memory:test-plugin",
      plugin: definePlugin({
        manifest: {
          name: "memory-test-plugin",
          version: "0.0.1",
          logiclensPluginApiVersion: LOGICLENS_PLUGIN_API_VERSION,
          capabilities: ["language", "fact-extractor", "framework-detector"]
        },
        languages: [{
          id: "memory-lang",
          extensions: [".mem"],
          parse() {
            return {};
          }
        }],
        factExtractors: [{
          name: "memory:extractor",
          extract() {}
        }],
        frameworkDetectors: [{
          name: "memory:detector",
          detect() {}
        }]
      })
    }]);

    expect(parserRegistry.resolve({ language: "memory-lang" })).toBeDefined();
    expect(contractExtractorRegistry.names()).toContain("memory:extractor");
    expect(frameworkDetectorRegistry.names()).toContain("memory:detector");

    clearRegisteredPluginCapabilities();

    expect(parserRegistry.resolve({ language: "memory-lang" })).toBeUndefined();
    expect(contractExtractorRegistry.names()).not.toContain("memory:extractor");
    expect(frameworkDetectorRegistry.names()).not.toContain("memory:detector");
  });

  it("restores extension mappings when a plugin parser overrides a builtin extension", () => {
    clearRegisteredPluginCapabilities();
    registerBuiltinParsers(new Set(["typescript"]));
    const originalTsParser = parserRegistry.resolve({ relativePath: "src/OrderService.ts" });
    expect(originalTsParser?.language).toBe("typescript");

    registerLoadedPlugins([{
      source: "memory:ts-override",
      plugin: definePlugin({
        manifest: {
          name: "memory-ts-override",
          version: "0.0.1",
          logiclensPluginApiVersion: LOGICLENS_PLUGIN_API_VERSION,
          capabilities: ["language"]
        },
        languages: [{
          id: "memory-typescript-override",
          extensions: [".ts"],
          parse() {
            return {};
          }
        }]
      })
    }]);

    expect(parserRegistry.resolve({ relativePath: "src/OrderService.ts" })?.language).toBe("memory-typescript-override");

    clearRegisteredPluginCapabilities();

    expect(parserRegistry.resolve({ relativePath: "src/OrderService.ts" })?.language).toBe("typescript");
  });
});
