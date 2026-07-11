import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { PluginParseInput } from "@logiclens/plugin-sdk";
import { createCSharpParser } from "../src/parser.js";

describe("C# parser facts", () => {
  it("extracts qualified symbols, imports, calls, annotations, and literals deterministically", async () => {
    const relativePath = "ParserFacts.cs";
    const source = await fs.readFile(path.resolve(import.meta.dirname, "fixtures", relativePath), "utf8");
    const input: PluginParseInput = { repoId: "repo:test", absolutePath: path.resolve(relativePath), relativePath, language: "csharp", source };
    const parse = createCSharpParser();
    const result = await parse(input);

    expect(result.symbols?.map(({ kind, qualifiedName }) => [kind, qualifiedName])).toEqual([
      ["interface", "Block.Scoped.IService"], ["struct", "Block.Scoped.Point"],
      ["struct", "Block.Scoped.Coordinate"], ["enum", "Block.Scoped.State"],
      ["class", "Block.Scoped.Outer"], ["class", "Block.Scoped.Outer.Inner"],
      ["method", "Block.Scoped.Outer.Inner.Inner"], ["method", "Block.Scoped.Outer.Inner.Convert"],
      ["function", "Block.Scoped.Outer.Inner.Convert.Local"],
      ["class", "File.Scoped.Client"], ["method", "File.Scoped.Client.Run"]
    ]);
    expect(result.symbols?.every((symbol) => symbol.source && symbol.signature && symbol.startLine <= symbol.endLine)).toBe(true);
    expect(result.symbols?.some((symbol) => "id" in symbol)).toBe(false);
    expect(result.imports).toEqual([
      expect.objectContaining({ module: "System.Collections.Generic.List<string>", raw: expect.stringContaining("global using") }),
      expect.objectContaining({ module: "SimpleNamespace", raw: "using SimpleAlias = SimpleNamespace;" }),
      expect.objectContaining({ module: "System.Math", raw: expect.stringContaining("using static") }),
      expect.objectContaining({ module: "Plain.Project.Services" })
    ]);
    expect(result.calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ calleeName: "Create", receiver: "Factory", argsCount: 2, callerSymbolName: expect.stringContaining("Local") }),
      expect.objectContaining({ calleeName: "Send", receiver: "service", argsCount: 3, callerSymbolName: "File.Scoped.Client.Run" })
    ]));
    expect(result.facts?.annotations).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Marker", arguments: [{ value: "type", raw: "\"type\"" }, { name: "Enabled", value: "true", raw: "Enabled = true" }] }),
      expect.objectContaining({ name: "Marker", ownerKind: "method", arguments: [
        { value: "7", raw: "7" }, { name: "slot", value: "2", raw: "slot: 2" },
        { name: "Name", value: "primary", raw: "Name = \"primary\"" }
      ] })
    ]));
    expect(result.facts?.literals).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "string", value: "payload" }),
      expect.objectContaining({ kind: "number", value: "42" }),
      expect.objectContaining({ kind: "number", value: "3.5" }),
      expect.objectContaining({ kind: "template", value: "$\"sent:{42}\"" })
    ]));
    expect(await parse(input)).toEqual(result);
  });

  it("keeps valid facts from malformed or partial source", async () => {
    const source = `namespace Partial;\nclass Good { void Run() { Client.Send(\"ok\"); } }\nclass Broken { void Missing( { }`;
    const input: PluginParseInput = {
      repoId: "repo:test", absolutePath: path.resolve("Partial.cs"), relativePath: "Partial.cs", language: "csharp", source
    };
    const result = await createCSharpParser()(input);
    expect(result.symbols?.map((symbol) => symbol.qualifiedName)).toEqual(["Partial.Good", "Partial.Good.Run"]);
    expect(result.calls).toEqual([expect.objectContaining({
      calleeName: "Send", receiver: "Client", argsCount: 1, callerSymbolName: "Partial.Good.Run"
    })]);
    expect(result.facts?.literals).toContainEqual(expect.objectContaining({ kind: "string", value: "ok" }));
  });
});
