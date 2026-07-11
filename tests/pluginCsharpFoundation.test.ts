import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  discoverLogicLensPlugin,
  loadDiscoveredLogicLensPlugins,
  validatePlugin
} from "@logiclens/plugin-runtime";
import type { PluginParseInput } from "@logiclens/plugin-sdk";
import { createCSharpParser } from "../packages/plugin-csharp/src/parser.js";

const pluginDir = path.resolve("packages/plugin-csharp");
const parseInput = (source = "class Sample {}"): PluginParseInput => ({
  repoId: "repo:test",
  absolutePath: path.join(pluginDir, "Sample.cs"),
  relativePath: "Sample.cs",
  language: "csharp",
  source
});

describe("C# plugin foundation", () => {
  it("is discovered and validated with capability payloads matching its manifest", async () => {
    const discovered = await discoverLogicLensPlugin(pluginDir);
    expect(discovered.manifest.languages).toEqual([expect.objectContaining({
      id: "csharp",
      extensions: [".cs"]
    })]);
    expect(discovered.entryPath).toBe(path.join(pluginDir, "dist", "index.js"));

    const loaded = await loadDiscoveredLogicLensPlugins([discovered], { failFast: true });
    expect(loaded).toHaveLength(1);
    const plugin = loaded[0]!.plugin;
    expect(() => validatePlugin(plugin, "csharp-test", discovered.manifest)).not.toThrow();
    expect(plugin.languages?.map((language) => language.id)).toEqual(["csharp"]);
    expect(plugin.factExtractors?.map((extractor) => extractor.name)).toEqual(["csharp:project-package-usage", "csharp-aspnet-http"]);
    expect(plugin.frameworkDetectors?.map((detector) => detector.name)).toEqual(["csharp:project-frameworks"]);
  });

  it("separates source extensions from project detection globs", async () => {
    const { manifest } = await discoverLogicLensPlugin(pluginDir);
    const language = manifest.languages?.[0];
    expect(language?.extensions).toEqual([".cs"]);
    expect(language?.detect?.globs).toEqual([
      "**/*.csproj",
      "**/*.sln",
      "**/Directory.Build.props",
      "**/Directory.Packages.props"
    ]);
    expect(language?.extensions).not.toContain(".csproj");
    expect(language?.extensions).not.toContain(".sln");
    expect(language?.extensions).not.toContain(".props");
  });

  it("contains no core or internal imports and keeps grammar imports dynamic", async () => {
    const sourceFiles = ["src/index.ts", "src/manifest.ts", "src/parser.ts", "src/projectMetadata.ts", "src/projectFacts.ts"];
    const sources = await Promise.all(sourceFiles.map((file) => fs.readFile(path.join(pluginDir, file), "utf8")));
    const source = sources.join("\n");
    expect(source).not.toMatch(/(?:from|import\s*\()["'][^"']*(?:src\/|src\\|core\/|core\\)/);
    expect(source).not.toMatch(/^\s*import\s+.*["']tree-sitter(?:-c-sharp)?["']/m);
    expect(source).toContain('moduleLoader("tree-sitter-c-sharp")');
  });

  it("does not load modules until parse and shares concurrent initialization", async () => {
    class FakeParser {
      setLanguage(): void {}
      parse(): { rootNode: { type: string; hasError: boolean } } {
        return { rootNode: { type: "compilation_unit", hasError: false } };
      }
    }
    let resolveGrammar!: (value: unknown) => void;
    const grammar = new Promise<unknown>((resolve) => { resolveGrammar = resolve; });
    const loader = vi.fn(async (specifier: string) => specifier === "tree-sitter" ? FakeParser : grammar);
    const parse = createCSharpParser(loader);
    expect(loader).not.toHaveBeenCalled();

    const first = parse(parseInput());
    const second = parse(parseInput());
    expect(loader).toHaveBeenCalledTimes(2);
    resolveGrammar({});
    await Promise.all([first, second]);
    expect(loader.mock.calls.filter(([specifier]) => specifier === "tree-sitter-c-sharp")).toHaveLength(1);
  });

  it("retries initialization after a failed grammar load", async () => {
    class FakeParser {
      setLanguage(): void {}
      parse(): { rootNode: { type: string; hasError: boolean } } {
        return { rootNode: { type: "compilation_unit", hasError: false } };
      }
    }
    let grammarAttempts = 0;
    const loader = vi.fn(async (specifier: string) => {
      if (specifier === "tree-sitter") return FakeParser;
      grammarAttempts += 1;
      if (grammarAttempts === 1) throw new Error("simulated native binding failure");
      return {};
    });
    const parse = createCSharpParser(loader);
    await expect(parse(parseInput())).rejects.toThrow("simulated native binding failure");
    await expect(parse(parseInput())).resolves.toEqual({ symbols: [], imports: [], calls: [], facts: {} });
    expect(grammarAttempts).toBe(2);
  });

  it("parses representative modern C# without root syntax errors", async () => {
    const source = await fs.readFile(path.resolve("tests/fixtures/plugin-csharp/ModernApi.cs"), "utf8");
    const parse = createCSharpParser();
    const result = await parse(parseInput(source));
    expect(result.symbols?.map((symbol) => symbol.qualifiedName)).toContain("LogicLens.Fixtures.Helpers.Convert");
    expect(result.imports?.[0]?.module).toBe("Microsoft.AspNetCore.Mvc");
    expect(result.calls?.map((call) => call.calleeName)).toContain("MapGet");
    expect(result.facts?.annotations?.map((annotation) => annotation.name)).toContain("Marker");
  });

  it("leaves builtin languages and default include free of C# additions", async () => {
    const defaultConfigSource = await fs.readFile(path.resolve("src/config/schema.ts"), "utf8");
    const builtinSource = await fs.readFile(path.resolve("src/core/plugins/detection.ts"), "utf8");
    expect(defaultConfigSource).not.toMatch(/\.cs(?:["'`]|\b)/i);
    expect(builtinSource).not.toMatch(/csharp|\.csproj|\.sln|(?:["'`])\.cs(?:["'`])/i);
  });
});
