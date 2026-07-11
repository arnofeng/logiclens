import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { PluginFrameworkFact, PluginPackageUsageFact } from "@logiclens/plugin-sdk";
import { collectProjectMetadata, parseProjectMetadata, PROJECT_SCAN_LIMITS } from "../packages/plugin-csharp/src/projectMetadata.js";
import { csharpFrameworkDetector, csharpPackageExtractor } from "../packages/plugin-csharp/src/projectFacts.js";

const fixture = path.resolve("tests/fixtures/plugin-csharp/project-metadata");

function context(repoPath: string) {
  const packages: PluginPackageUsageFact[] = [];
  const frameworks: PluginFrameworkFact[] = [];
  const repo = { id: "repo:fixture", name: "fixture", path: repoPath };
  const value = {
    repos: [repo], files: Object.assign([], { all: () => [], byLanguage: () => [], byRepo: () => [], get: () => undefined }),
    symbols: [], imports: [], calls: [],
    emit: {
      fact: () => undefined, httpEndpoint: () => undefined, schema: () => undefined, event: () => undefined,
      grpcMethod: () => undefined, semanticRelation: () => undefined,
      packageUsage: (fact: Omit<PluginPackageUsageFact, "kind">) => packages.push({ kind: "packageUsage", ...fact }),
      framework: (fact: Omit<PluginFrameworkFact, "kind">) => frameworks.push({ kind: "framework", ...fact })
    }
  };
  return { value, packages, frameworks };
}

describe("C# project metadata and facts", () => {
  it("parses SDK-style XML, multi-targeting, direct central versions, and nested versions with exact evidence", async () => {
    const files = await collectProjectMetadata(fixture);
    expect(files.map((file) => file.filePath)).toEqual([
      "Directory.Build.props", "Directory.Packages.props", "malformed.csproj", "src/Web/Web.csproj", "src/Worker/Worker.csproj"
    ].filter((name) => name !== "malformed.csproj"));
    const declarations = files.flatMap((file) => file.declarations);
    expect(declarations.filter((item) => item.kind === "targetFramework").map((item) => item.name)).toEqual(["net8.0", "net9.0", "net9.0", "net8.0"]);
    expect(declarations).toContainEqual(expect.objectContaining({ kind: "packageVersion", name: "Microsoft.EntityFrameworkCore", version: "9.0.4", line: 6 }));
    expect(declarations).toContainEqual(expect.objectContaining({ kind: "packageReference", name: "Microsoft.EntityFrameworkCore", version: "9.0.4" }));
    expect(declarations).toContainEqual(expect.objectContaining({ kind: "packageReference", name: "Microsoft.Extensions.Hosting", version: "9.0.0" }));
    expect(declarations.every((item) => item.filePath && item.line > 0 && item.raw.startsWith("<"))).toBe(true);
  });

  it("does not fabricate declarations from malformed XML or property expressions", () => {
    expect(parseProjectMetadata("bad.csproj", "<Project><ItemGroup></Project>")).toBeUndefined();
    expect(parseProjectMetadata("bad-entity.csproj", "<Project><ItemGroup><PackageReference Include=\"A & B\" /></ItemGroup></Project>")).toBeUndefined();
    expect(parseProjectMetadata("trailing.csproj", "<Project />not-xml")).toBeUndefined();
    const parsed = parseProjectMetadata("conditional.csproj", "<Project><PropertyGroup><TargetFramework>$(Inherited)</TargetFramework></PropertyGroup></Project>");
    expect(parsed?.declarations).toEqual([]);
  });

  it("keeps unresolved direct and central MSBuild version expressions out of metadata", async () => {
    const direct = parseProjectMetadata("direct.csproj", `<Project><ItemGroup>
  <PackageReference Include="Direct.Package" Version="$(DirectVersion)" />
</ItemGroup></Project>`);
    expect(direct?.declarations).toEqual([expect.objectContaining({ kind: "packageReference", name: "Direct.Package" })]);
    expect(direct?.declarations[0]).not.toHaveProperty("version");

    const root = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-csharp-unresolved-version-"));
    try {
      await fs.writeFile(path.join(root, "Directory.Packages.props"), `<Project><ItemGroup><PackageVersion Include="Central.Package" Version="$(SharedVersion)" /></ItemGroup></Project>`);
      await fs.writeFile(path.join(root, "App.csproj"), `<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><PackageReference Include="Central.Package" /></ItemGroup></Project>`);
      const declarations = (await collectProjectMetadata(root)).flatMap((file) => file.declarations);
      expect(declarations.filter((item) => item.name === "Central.Package").every((item) => item.version === undefined)).toBe(true);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("computes exact lines efficiently for large structured project files", () => {
    const references = Array.from({ length: 10_000 }, (_, index) => `  <PackageReference Include="Package.${index}" Version="1.0.0" />`).join("\n");
    const source = `<Project>\n${references}\n</Project>`;
    const started = performance.now();
    const parsed = parseProjectMetadata("large.csproj", source);
    const elapsed = performance.now() - started;
    expect(parsed?.declarations).toHaveLength(10_000);
    expect(parsed?.declarations.at(-1)?.line).toBe(10_001);
    expect(elapsed).toBeLessThan(1_500);
  });

  it("does not treat conditional declarations as directly available metadata", () => {
    const parsed = parseProjectMetadata("conditional.csproj", `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup Condition="'$(Mode)' == 'web'"><TargetFramework>net9.0</TargetFramework></PropertyGroup>
  <ItemGroup Condition="'$(Mode)' == 'web'"><PackageReference Include="Grpc.AspNetCore" /></ItemGroup>
</Project>`);
    expect(parsed?.declarations).toEqual([expect.objectContaining({ kind: "sdk", name: "Microsoft.NET.Sdk" })]);
  });

  it("uses only the nearest automatically imported central package file", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-csharp-central-"));
    try {
      await fs.mkdir(path.join(root, "src", "Nested"), { recursive: true });
      await fs.writeFile(path.join(root, "Directory.Packages.props"), `<Project><ItemGroup><PackageVersion Include="ParentOnly" Version="1.0.0" /></ItemGroup></Project>`);
      await fs.writeFile(path.join(root, "src", "Directory.Packages.props"), `<Project><ItemGroup><PackageVersion Include="NearestOnly" Version="2.0.0" /></ItemGroup></Project>`);
      await fs.writeFile(path.join(root, "src", "Nested", "App.csproj"), `<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><PackageReference Include="ParentOnly" /><PackageReference Include="NearestOnly" /></ItemGroup></Project>`);
      const declarations = (await collectProjectMetadata(root)).flatMap((file) => file.declarations);
      expect(declarations.find((item) => item.kind === "packageReference" && item.name === "ParentOnly")?.version).toBeUndefined();
      expect(declarations.find((item) => item.kind === "packageReference" && item.name === "NearestOnly")?.version).toBe("2.0.0");
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("emits marker-only framework facts from explicit project evidence and never needs C# source", async () => {
    const { value, frameworks } = context(fixture);
    await csharpFrameworkDetector.detect(value);
    expect(frameworks.map((fact) => fact.name)).toEqual([".NET", "ASP.NET Core", "EF Core", "gRPC", "xUnit", "Worker Service", "NUnit", "MSTest"]);
    expect(frameworks.every((fact) => fact.language === "csharp" && fact.evidence.every((item) => item.filePath && item.line > 0 && item.raw && item.rule && item.confidence === "exact"))).toBe(true);
  });

  it("avoids broad Worker and gRPC inference while recognizing versioned SDK and MSTest evidence", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-csharp-frameworks-"));
    try {
      await fs.writeFile(path.join(root, "App.csproj"), `<Project Sdk="Microsoft.NET.Sdk.Web/9.0.100"><ItemGroup>
  <PackageReference Include="Microsoft.Extensions.Hosting" />
  <PackageReference Include="Google.Protobuf" />
  <PackageReference Include="MSTest" />
</ItemGroup></Project>`);
      const { value, frameworks } = context(root);
      await csharpFrameworkDetector.detect(value);
      expect(frameworks.map((fact) => fact.name)).toEqual([".NET", "ASP.NET Core", "MSTest"]);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("emits exact package, framework-reference, and selected SDK usages with deterministic deduplication", async () => {
    const first = context(fixture);
    await csharpPackageExtractor.extract(first.value);
    const summarized = first.packages.map((fact) => [fact.packageName, fact.filePath, fact.evidence.line]);
    expect(summarized).toEqual([
      ["Microsoft.NET.Sdk.Web", "src/Web/Web.csproj", 1], ["Microsoft.AspNetCore.App", "src/Web/Web.csproj", 6],
      ["Microsoft.EntityFrameworkCore", "src/Web/Web.csproj", 7], ["Grpc.AspNetCore", "src/Web/Web.csproj", 8],
      ["xunit", "src/Web/Web.csproj", 9], ["Microsoft.NET.Sdk.Worker", "src/Worker/Worker.csproj", 1],
      ["Microsoft.Extensions.Hosting", "src/Worker/Worker.csproj", 6], ["NUnit", "src/Worker/Worker.csproj", 9],
      ["MSTest.TestFramework", "src/Worker/Worker.csproj", 10]
    ]);
    const second = context(fixture);
    await csharpPackageExtractor.extract(second.value);
    expect(second.packages).toEqual(first.packages);
  });

  it("bounds reads and skips excluded directories, oversized files, and symbolic links", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-csharp-bounds-"));
    try {
      await fs.mkdir(path.join(root, "obj"));
      await fs.writeFile(path.join(root, "obj", "Ignored.csproj"), "<Project Sdk=\"Microsoft.NET.Sdk.Web\" />");
      await fs.writeFile(path.join(root, "Huge.csproj"), `<Project>${" ".repeat(PROJECT_SCAN_LIMITS.maxFileSize)}</Project>`);
      await fs.writeFile(path.join(root, "Valid.csproj"), "<Project Sdk=\"Microsoft.NET.Sdk\" />");
      try { await fs.symlink(path.join(root, "Valid.csproj"), path.join(root, "Linked.csproj")); } catch { /* Symlink creation can be unavailable on Windows. */ }
      const files = await collectProjectMetadata(root);
      expect(files.map((file) => file.filePath)).toEqual(["Valid.csproj"]);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("stops metadata discovery at the deterministic file-count boundary", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-csharp-count-"));
    try {
      const writes: Promise<void>[] = [];
      for (let index = 0; index < PROJECT_SCAN_LIMITS.maxFiles + 2; index += 1) {
        const name = `${String(index).padStart(5, "0")}.csproj`;
        writes.push(fs.writeFile(path.join(root, name), `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net${index}.0</TargetFramework></PropertyGroup></Project>`));
      }
      await Promise.all(writes);
      const files = await collectProjectMetadata(root);
      expect(files).toHaveLength(PROJECT_SCAN_LIMITS.maxFiles);
      expect(files.at(-1)?.filePath).toBe("02047.csproj");
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});
