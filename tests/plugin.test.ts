import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultConfig, writeConfig } from "../src/config/loadConfig.js";
import { loadConfiguredPlugins } from "../src/plugins/loader.js";
import { parserRegistry } from "../src/plugins/registry.js";
import { parseSourceFile } from "../src/core/parsing/parserRegistry.js";
import { repoId } from "../src/shared/path.js";

async function makePluginWorkspace(): Promise<string> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-plugin-"));
  await writeConfig({
    ...defaultConfig(),
    plugins: [{ name: path.resolve("tests/fixtures/plugins/grpc-plugin.mjs") }]
  }, cwd);
  return cwd;
}

describe("plugin mechanism", () => {
  it("loads configured local plugins and registers parsers", async () => {
    const cwd = await makePluginWorkspace();
    const result = await loadConfiguredPlugins({ cwd });
    expect(result.loaded).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "grpc-fixture-plugin", version: "1.0.0" })
    ]));
    expect(result.parserCount).toBeGreaterThanOrEqual(1);
  });

  it("uses external parser from plugin to parse source files", async () => {
    const cwd = await makePluginWorkspace();
    await loadConfiguredPlugins({ cwd });
    const protoPath = path.join(cwd, "service.proto");
    await fs.writeFile(protoPath, "service UserService {}\n", "utf8");
    const parsed = await parseSourceFile({ repoId: repoId("proto-service"), absolutePath: protoPath, relativePath: "service.proto", language: "proto" });
    expect(parsed).toMatchObject({ language: "proto", path: "service.proto" });
  });

  it("allows external parsers to be registered by extension", async () => {
    parserRegistry.register({
      name: "test:proto-parser",
      language: "proto",
      extensions: [".proto"],
      parse(input) {
        return {
          repoId: input.repoId,
          fileId: input.fileId,
          path: input.relativePath,
          language: "proto",
          hash: input.hash,
          loc: input.source.split(/\r?\n/).length,
          imports: [],
          symbols: [],
          calls: []
        };
      }
    });
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-parser-plugin-"));
    const protoPath = path.join(cwd, "service.proto");
    await fs.writeFile(protoPath, "service UserService {}\n", "utf8");
    const parsed = await parseSourceFile({ repoId: repoId("proto-service"), absolutePath: protoPath, relativePath: "service.proto", language: "proto" });
    expect(parsed).toMatchObject({ language: "proto", path: "service.proto" });
  });

  it("reports missing plugin modules with plugin context", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-missing-plugin-"));
    await writeConfig({
      ...defaultConfig(),
      plugins: [{ name: "./missing-plugin.mjs" }]
    }, cwd);
    await expect(loadConfiguredPlugins({ cwd })).rejects.toThrow(/Failed to load plugin "\.\/missing-plugin\.mjs"/);
  });
});
