import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { configSchema } from "../src/config/schema.js";
import { parserRegistry } from "../src/core/plugins/registry.js";
import { scanRepoFiles } from "../src/core/workspace/fileScanner.js";
import { isGeneratedFile } from "../src/shared/generatedFile.js";

describe("file scanner", () => {
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
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-scanner-langs-"));
    await fs.writeFile(path.join(cwd, "main.py"), "print('hello')\n", "utf8");
    await fs.writeFile(path.join(cwd, "main.go"), "package main\n", "utf8");

    const files = await scanRepoFiles(cwd, configSchema.parse({}));
    expect(files.map((file) => [file.relativePath, file.language])).toEqual([
      ["main.go", "go"],
      ["main.py", "python"]
    ]);
  });

  it("includes file-level config files by default", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-scanner-config-"));
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

    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-scanner-"));
    await fs.mkdir(path.join(cwd, "src"), { recursive: true });
    await fs.writeFile(path.join(cwd, "src", "index.d.ts"), "export interface User {}\n", "utf8");

    const files = await scanRepoFiles(cwd, configSchema.parse({}));
    expect(files.map((file) => [file.relativePath, file.language])).toEqual([
      ["src/index.d.ts", "typescript-declaration"]
    ]);
  });

  it("excludes auto-generated files from the scan result", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-scanner-gen-"));
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
