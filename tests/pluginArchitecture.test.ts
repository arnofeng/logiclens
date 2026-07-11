import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ExtractionBuilder } from "../src/core/contracts/extraction/extractionBuilder.js";
import { normalizePublicFacts } from "../src/core/plugins/publicFactNormalizer.js";
import { adaptFactExtractor, adaptFrameworkDetector, adaptLanguageParser } from "../src/core/plugins/adapter.js";
import { clearRegisteredPluginCapabilities, registerLoadedPlugins } from "../src/core/plugins/register.js";
import { autoDetectAndRegisterPlugins } from "../src/core/plugins/register.js";
import { detectActiveLanguages, builtinLanguagePluginManifests, scanRepoPathSnapshot } from "../src/core/plugins/detection.js";
import { registerCommonBuiltins, resetJavaBuiltinCapabilities } from "../src/core/plugins/bootstrap.js";
import { ContractExtractorRegistry, FrameworkDetectorRegistry, contractExtractorRegistry, frameworkDetectorRegistry, parserRegistry } from "../src/core/registries/registry.js";
import { parseSourceFile, registerBuiltinParsers } from "../src/core/parsing/parserRegistry.js";
import { getLoadedLanguageGrammar, LANGUAGE_DEFINITIONS } from "../src/core/parsing/languages/registry.js";
import { discoverLogicLensPlugin, loadDiscoveredLogicLensPlugins, validatePlugin } from "@logiclens/plugin-runtime";
import { LOGICLENS_PLUGIN_API_VERSION, definePlugin } from "@logiclens/plugin-sdk";
import { joinHttpPaths, normalizeRouteTemplate } from "@logiclens/plugin-sdk/utils";
import { defaultConfig } from "../src/config/loadConfig.js";

describe("plugin architecture foundation", () => {
  it("publishes plugin APIs as workspace packages only", async () => {
    const packageJson = JSON.parse(await fs.readFile(path.resolve("package.json"), "utf8")) as {
      exports?: Record<string, { types?: string; default?: string }>;
      dependencies?: Record<string, string>;
    };

    expect(packageJson.exports?.["./plugin-sdk"]).toBeUndefined();
    expect(packageJson.exports?.["./plugin-sdk/utils"]).toBeUndefined();
    expect(packageJson.exports?.["./plugin-runtime"]).toBeUndefined();
    expect(packageJson.dependencies?.["@logiclens/plugin-sdk"]).toBe("workspace:*");
    expect(packageJson.dependencies?.["@logiclens/plugin-runtime"]).toBe("workspace:*");
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

  it("requires exported language declarations to match manifest languages", () => {
    const manifest = {
      name: "bad-language-plugin",
      version: "0.0.1",
      logiclensPluginApiVersion: LOGICLENS_PLUGIN_API_VERSION,
      capabilities: ["language" as const],
      languages: [{ id: "go", extensions: [".go"] }]
    };
    const plugin = definePlugin({
      manifest,
      languages: [{
        id: "go",
        extensions: [".go2"],
        parse() {
          return {};
        }
      }]
    });

    expect(() => validatePlugin(plugin, "bad-language-plugin")).toThrow(/exactly match/);
  });

  it("resolves plugin entry from package.json when plugin.json omits entry", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-plugin-entry-"));
    await fs.writeFile(path.join(dir, "plugin.json"), JSON.stringify({
      name: "entry-test",
      version: "0.0.1",
      logiclensPluginApiVersion: LOGICLENS_PLUGIN_API_VERSION,
      capabilities: ["fact-extractor"]
    }), "utf8");
    await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ exports: { ".": { import: "./index.js" } } }), "utf8");
    await fs.writeFile(path.join(dir, "index.js"), "export default { manifest: { name: 'entry-test', version: '0.0.1', logiclensPluginApiVersion: '0.1.0', capabilities: ['fact-extractor'] }, factExtractors: [] };", "utf8");

    const discovered = await discoverLogicLensPlugin(dir);
    expect(discovered.entryPath).toBe(path.join(dir, "index.js"));
    await expect(loadDiscoveredLogicLensPlugins([discovered], { failFast: true })).resolves.toHaveLength(1);
  });

  it("detects Vue and cascades to JS/TS delegate languages", async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-vue-detect-"));
    await fs.writeFile(path.join(repo, "App.vue"), "<script setup lang=\"ts\">const x = 1</script>", "utf8");
    const config = { ...defaultConfig(), include: ["**/*.vue"], repos: [{ name: "vue", path: repo }] };
    const snapshot = await scanRepoPathSnapshot(repo, config);
    const active = detectActiveLanguages({ plugins: builtinLanguagePluginManifests, snapshots: [snapshot] });

    expect(active.has("vue")).toBe(true);
    expect(active.has("javascript")).toBe(true);
    expect(active.has("jsx")).toBe(true);
    expect(active.has("typescript")).toBe(true);
    expect(active.has("tsx")).toBe(true);
  });

  it("matches markers up to three repo levels after ignore filtering", async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-marker-depth-"));
    await fs.mkdir(path.join(repo, "packages", "apps", "orders"), { recursive: true });
    await fs.mkdir(path.join(repo, "dist", "nested"), { recursive: true });
    await fs.writeFile(path.join(repo, "packages", "apps", "orders", "pom.xml"), "<project />", "utf8");
    await fs.writeFile(path.join(repo, "dist", "nested", "go.mod"), "module ignored", "utf8");
    const config = { ...defaultConfig(), include: ["**/*"], exclude: ["**/dist/**"], repos: [{ name: "markers", path: repo }] };
    const snapshot = await scanRepoPathSnapshot(repo, config);
    const active = detectActiveLanguages({ plugins: builtinLanguagePluginManifests, snapshots: [snapshot] });

    expect(active.has("java")).toBe(true);
    expect(active.has("go")).toBe(false);
  });

  it("matches glob double-star slash against zero nested directories", () => {
    const active = detectActiveLanguages({
      plugins: [{
        source: "test:java-glob",
        sourceKind: "project",
        manifest: {
          name: "java-glob",
          version: "0.0.1",
          capabilities: ["language"],
          languages: [{
            id: "java",
            extensions: [".java"],
            detect: { globs: ["src/main/java/**/*.java"] }
          }]
        }
      }],
      snapshots: [{ repoPath: ".", paths: ["src/main/java/MyClass.java"] }]
    });

    expect(active.has("java")).toBe(true);
  });

  it("activates Java build markers without registering the Java parser or source extractors", async () => {
    resetJavaBuiltinCapabilities();
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-java-marker-only-"));
    await fs.writeFile(path.join(repo, "pom.xml"), "<project />", "utf8");
    const config = { ...defaultConfig(), repos: [{ name: "marker", path: repo }] };

    await autoDetectAndRegisterPlugins({ config, cwd: repo, repoConfigs: config.repos });

    expect(parserRegistry.resolve({ language: "java" })).toBeUndefined();
    expect(getLoadedLanguageGrammar("java")).toBeUndefined();
    expect(contractExtractorRegistry.names()).not.toContain("builtin:spring-mvc");
    expect(frameworkDetectorRegistry.names()).toContain("builtin:pom-xml-detector");
  });

  it("activates Dubbo XML without registering the Java parser", async () => {
    resetJavaBuiltinCapabilities();
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-dubbo-xml-only-"));
    await fs.writeFile(path.join(repo, "dubbo.xml"), "<beans xmlns:dubbo=\"http://dubbo.apache.org/schema/dubbo\"><dubbo:service interface=\"com.example.Api\" /></beans>", "utf8");
    const config = { ...defaultConfig(), repos: [{ name: "dubbo", path: repo }] };

    const bootstrap = await autoDetectAndRegisterPlugins({ config, cwd: repo, repoConfigs: config.repos });

    expect(parserRegistry.resolve({ language: "java" })).toBeUndefined();
    expect(getLoadedLanguageGrammar("java")).toBeUndefined();
    expect(contractExtractorRegistry.names()).toContain("builtin:dubbo-xml");
    expect(frameworkDetectorRegistry.names()).toContain("builtin:dubbo-xml-detector");
    expect(bootstrap.additionalIndexFilesByRepo.get(repo)).toEqual(["dubbo.xml"]);
  });

  it("registers Java parser and source extractors only when Java source files are present", async () => {
    resetJavaBuiltinCapabilities();
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-java-source-"));
    await fs.mkdir(path.join(repo, "src", "main", "java"), { recursive: true });
    await fs.writeFile(path.join(repo, "src", "main", "java", "OrderController.java"), "class OrderController {}", "utf8");
    const config = { ...defaultConfig(), include: ["**/*"], repos: [{ name: "java", path: repo }] };

    await autoDetectAndRegisterPlugins({ config, cwd: repo, repoConfigs: config.repos });

    expect(parserRegistry.resolve({ language: "java" })).toBeDefined();
    expect(getLoadedLanguageGrammar("java")).toBeUndefined();
    await parseSourceFile({
      repoId: "repo:java",
      absolutePath: path.join(repo, "src", "main", "java", "OrderController.java"),
      relativePath: "src/main/java/OrderController.java",
      language: "java"
    });
    expect(getLoadedLanguageGrammar("java")).toBeDefined();
    expect(contractExtractorRegistry.names()).toContain("builtin:spring-mvc");
    expect(frameworkDetectorRegistry.names()).toContain("builtin:java-fallback-detector");
  });

  it("loads legacy configured generic plugins without matching a language", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-legacy-generic-"));
    const pluginDir = path.join(cwd, "generic-plugin");
    const repoDir = path.join(cwd, "repo");
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.mkdir(repoDir, { recursive: true });
    await fs.writeFile(path.join(repoDir, "README.md"), "# test", "utf8");
    await fs.writeFile(path.join(pluginDir, "plugin.js"), `
      export default {
        manifest: { name: "generic-plugin", version: "0.0.1", logiclensPluginApiVersion: "${LOGICLENS_PLUGIN_API_VERSION}", capabilities: ["fact-extractor"] },
        factExtractors: [{ name: "generic:test", extract() {} }]
      };
    `, "utf8");
    const config = {
      ...defaultConfig(),
      repos: [{ name: "repo", path: repoDir }],
      plugins: { enabled: ["./generic-plugin/plugin.js"], failFast: true }
    };

    await autoDetectAndRegisterPlugins({ config, cwd, repoConfigs: config.repos });
    expect(contractExtractorRegistry.names()).toContain("generic:test");
    clearRegisteredPluginCapabilities();
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

  it("restores common builtins after same-named plugin capabilities are removed", () => {
    clearRegisteredPluginCapabilities();
    registerCommonBuiltins();
    const builtinExtractor = contractExtractorRegistry.resolve("builtin:package-json");
    const builtinDetector = frameworkDetectorRegistry.resolve("builtin:package-json-detector");

    registerLoadedPlugins([{
      source: "memory:builtin-override",
      plugin: definePlugin({
        manifest: {
          name: "memory-builtin-override",
          version: "0.0.1",
          logiclensPluginApiVersion: LOGICLENS_PLUGIN_API_VERSION,
          capabilities: ["fact-extractor", "framework-detector"]
        },
        factExtractors: [{ name: "builtin:package-json", extract() {} }],
        frameworkDetectors: [{ name: "builtin:package-json-detector", detect() {} }]
      })
    }]);

    expect(contractExtractorRegistry.resolve("builtin:package-json")).not.toBe(builtinExtractor);
    expect(frameworkDetectorRegistry.resolve("builtin:package-json-detector")).not.toBe(builtinDetector);

    clearRegisteredPluginCapabilities();
    registerCommonBuiltins();

    expect(contractExtractorRegistry.resolve("builtin:package-json")).toBe(builtinExtractor);
    expect(frameworkDetectorRegistry.resolve("builtin:package-json-detector")).toBe(builtinDetector);
  });

  it("restores extension mappings when a plugin parser overrides a builtin extension", async () => {
    clearRegisteredPluginCapabilities();
    await registerBuiltinParsers(new Set(["typescript"]));
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

  it("keeps supported languages in core and reserves plugins for extensions", async () => {
    expect(LANGUAGE_DEFINITIONS.map((definition) => definition.id).sort()).toEqual([
      "go",
      "java",
      "javascript",
      "jsx",
      "python",
      "tsx",
      "typescript"
    ]);
    await expect(fs.stat(path.resolve("src/core/plugins/bundled"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
