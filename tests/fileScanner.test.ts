import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { configSchema } from "../src/config/schema.js";
import { parserRegistry } from "../src/core/registries/registry.js";
import { registerBuiltinParsers } from "../src/core/parsing/parserRegistry.js";
import { scanRepoFiles } from "../src/core/workspace/fileScanner.js";
import { isGeneratedFile } from "../src/shared/generatedFile.js";

describe("file scanner", () => {
  beforeAll(async () => {
    await registerBuiltinParsers();
  });

  it("includes JavaScript, JSX, and Markdown document files", async () => {
    const files = await scanRepoFiles(path.resolve("tests/fixtures/service-c"), configSchema.parse({}));
    expect(files.map((file) => [file.relativePath, file.language])).toEqual([
      ["Guide.mdx", "markdown"],
      ["src/InventoryPanel.jsx", "jsx"],
      ["src/InventoryService.js", "javascript"]
    ]);
  });

  it("includes Java source files", async () => {
    const files = await scanRepoFiles(path.resolve("tests/fixtures/service-d"), configSchema.parse({}));
    expect(files.map((file) => [file.relativePath, file.language])).toEqual([
      ["src/OrderService.java", "java"]
    ]);
  });

  it("includes Python and Go source files by default", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "test-scanner-langs-"));
    await fs.writeFile(path.join(cwd, "main.py"), "print('hello')\n", "utf8");
    await fs.writeFile(path.join(cwd, "main.go"), "package main\n", "utf8");

    const files = await scanRepoFiles(cwd, configSchema.parse({}));
    expect(files.map((file) => [file.relativePath, file.language])).toEqual([
      ["main.go", "go"],
      ["main.py", "python"]
    ]);
  });

  it("includes file-level config files by default", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "test-scanner-config-"));
    await fs.writeFile(path.join(cwd, "application.yml"), "server:\n  port: 8080\n", "utf8");
    await fs.writeFile(path.join(cwd, "Cargo.toml"), "[package]\nname = \"demo\"\n", "utf8");
    await fs.writeFile(path.join(cwd, "app.properties"), "spring.application.name=demo\n", "utf8");

    const files = await scanRepoFiles(cwd, configSchema.parse({}));
    expect(files.map((file) => [file.relativePath, file.language])).toEqual([
      ["Cargo.toml", "toml"],
      ["app.properties", "properties"],
      ["application.yml", "yaml"]
    ]);
  });

  it("prefers the most specific registered extension", async () => {
    parserRegistry.register({
      name: "test:declaration-parser",
      language: "typescript-declaration",
      extensions: [".d.ts"],
      parse(input) {
        return {
          repoId: input.repoId,
          fileId: input.fileId,
          path: input.relativePath,
          language: "typescript-declaration",
          hash: input.hash,
          loc: input.source.split(/\r?\n/).length,
          imports: [],
          symbols: [],
          calls: []
        };
      }
    });

    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "test-scanner-"));
    await fs.mkdir(path.join(cwd, "src"), { recursive: true });
    await fs.writeFile(path.join(cwd, "src", "index.d.ts"), "export interface User {}\n", "utf8");

    const files = await scanRepoFiles(cwd, configSchema.parse({}));
    expect(files.map((file) => [file.relativePath, file.language])).toEqual([
      ["src/index.d.ts", "typescript-declaration"]
    ]);
  });

  it("excludes auto-generated files from the scan result", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "test-scanner-gen-"));
    await fs.mkdir(path.join(cwd, "src"), { recursive: true });
    // real source files that should be indexed
    await fs.writeFile(path.join(cwd, "src", "main.go"), "package main\n", "utf8");
    await fs.writeFile(path.join(cwd, "src", "service.py"), "class Foo: pass\n", "utf8");
    // generated files that must be skipped
    await fs.writeFile(path.join(cwd, "src", "user.pb.go"), "// generated\n", "utf8");
    await fs.writeFile(path.join(cwd, "src", "user_grpc.pb.go"), "// generated\n", "utf8");
    await fs.writeFile(path.join(cwd, "src", "user_mock.go"), "// generated\n", "utf8");
    await fs.writeFile(path.join(cwd, "src", "user_pb2.py"), "# generated\n", "utf8");

    const files = await scanRepoFiles(cwd, configSchema.parse({}));
    expect(files.map((f) => f.relativePath).sort()).toEqual(["src/main.go", "src/service.py"]);
  });

  it("revalidates core-added paths against exclusions and path traversal", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "test-core-added-paths-"));
    await fs.mkdir(path.join(cwd, "dist"), { recursive: true });
    await fs.writeFile(path.join(cwd, "dubbo.xml"), "<dubbo:service interface=\"x.Api\" />", "utf8");
    await fs.writeFile(path.join(cwd, "dist", "ignored.xml"), "<dubbo:service interface=\"x.Ignored\" />", "utf8");

    const files = await scanRepoFiles(cwd, configSchema.parse({}), {
      additionalPaths: ["dubbo.xml", "dist/ignored.xml", "../outside.xml"]
    });

    expect(files.map((file) => file.relativePath)).toEqual(["dubbo.xml"]);
  });

  it("applies normal safety filters to active plugin source globs", async () => {
    parserRegistry.register({
      name: "test:csharp-source-filter",
      language: "csharp",
      extensions: [".cs"],
      parse() { throw new Error("not used"); }
    });
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "test-plugin-source-filters-"));
    await fs.mkdir(path.join(cwd, "dist"));
    await fs.writeFile(path.join(cwd, ".gitignore"), "ignored.cs\n", "utf8");
    await fs.writeFile(path.join(cwd, "kept.cs"), "class Kept {}", "utf8");
    await fs.writeFile(path.join(cwd, "ignored.cs"), "class Ignored {}", "utf8");
    await fs.writeFile(path.join(cwd, "dist", "excluded.cs"), "class Excluded {}", "utf8");
    await fs.writeFile(path.join(cwd, "generated.g.cs"), "class Generated {}", "utf8");
    await fs.writeFile(path.join(cwd, "binary.cs"), Buffer.from([0, 1, 2]));

    const files = await scanRepoFiles(cwd, configSchema.parse({}), {
      activePluginSourceGlobs: ["**/*.cs"]
    });
    expect(files.map((file) => file.relativePath)).toEqual(["kept.cs"]);
    parserRegistry.unregisterLanguage("csharp");
  });

  it("treats a custom include as a scope restriction for plugin sources", async () => {
    parserRegistry.register({ name: "test:csharp-scope", language: "csharp", extensions: [".cs"], parse() { throw new Error("not used"); } });
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "test-plugin-source-scope-"));
    await fs.mkdir(path.join(cwd, "src"));
    await fs.writeFile(path.join(cwd, "src", "Included.cs"), "class Included {}", "utf8");
    await fs.writeFile(path.join(cwd, "Outside.cs"), "class Outside {}", "utf8");
    const files = await scanRepoFiles(cwd, configSchema.parse({ include: ["src/**"] }), { activePluginSourceGlobs: ["**/*.cs"] });
    expect(files.map((file) => file.relativePath)).toEqual(["src/Included.cs"]);
    parserRegistry.unregisterLanguage("csharp");
  });

  it("does not scan an explicitly included extension through another repo's scoped parser", async () => {
    const ownerParser = {
      name: "test:owner-only",
      language: "owner-only",
      scopeRepoId: "repo:owner",
      extensions: [".foreign"],
      parse() { throw new Error("not used"); }
    };
    parserRegistry.register(ownerParser);
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "test-foreign-scoped-parser-"));
    await fs.writeFile(path.join(cwd, "leak.foreign"), "should not parse", "utf8");

    const files = await scanRepoFiles(cwd, configSchema.parse({ include: ["**/*.foreign"] }), { repoId: "repo:other" });

    expect(files).toEqual([]);
    parserRegistry.unregister(ownerParser);
  });
});

describe("isGeneratedFile", () => {
  const generated = [
    // Go
    "internal/api/user.pb.go",
    "internal/api/user_grpc.pb.go",
    "mocks/mock_repository.go",
    "service/user_mock.go",
    "service/user_mocks.go",
    // Python
    "proto/user_pb2.py",
    "proto/user_pb2_grpc.py",
    // Java
    "src/UserServiceGrpc.java",
    "src/UserOuterClass.java",
    // TypeScript
    "src/graphql/types.generated.ts",
    "src/proto/user.pb.ts",
    "dist/bundle.min.js",
    // C#
    "src/User.g.cs",
    "src/UserGrpc.cs",
    // Dart
    "lib/models/user.g.dart",
    "lib/models/user.freezed.dart",
  ];

  const notGenerated = [
    "src/user_service.go",
    "src/UserService.java",
    "src/UserRepository.java",
    "src/components/UserCard.tsx",
    "src/utils/mock_helper.ts",   // "mock" in name but not a generated mock
    "main.py",
  ];

  for (const p of generated) {
    it(`detects ${p} as generated`, () => {
      expect(isGeneratedFile(p)).toBe(true);
    });
  }

  for (const p of notGenerated) {
    it(`does not flag ${p} as generated`, () => {
      expect(isGeneratedFile(p)).toBe(false);
    });
  }
});
