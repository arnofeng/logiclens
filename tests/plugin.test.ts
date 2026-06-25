import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { defaultConfig, writeConfig } from "../src/config/loadConfig.js";
import { buildGraphFactsBatch } from "../src/graph/facts.js";
import { KuzuGraphDB } from "../src/graph/db.js";
import { listDependencies, traceContract } from "../src/graph/queries.js";
import { upsertParsedFiles } from "../src/graph/upsert.js";
import { loadConfiguredPlugins } from "../src/plugins/loader.js";
import { parserRegistry } from "../src/plugins/registry.js";
import { parseSourceFile } from "../src/parsers/parserRegistry.js";
import type { RepoNode } from "../src/parsers/types.js";
import { repoId } from "../src/utils/path.js";

async function makePluginWorkspace(): Promise<string> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-plugin-"));
  await writeConfig({
    ...defaultConfig(),
    plugins: [{ name: path.resolve("tests/fixtures/plugins/grpc-plugin.mjs") }]
  }, cwd);
  return cwd;
}

describe("plugin mechanism", () => {
  it("loads configured local plugins and registers contract extractors", async () => {
    const cwd = await makePluginWorkspace();
    const result = await loadConfiguredPlugins({ cwd });
    expect(result.loaded).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "grpc-fixture-plugin", version: "1.0.0" })
    ]));
    expect(result.extractorCount).toBeGreaterThanOrEqual(1);
  });

  it("uses external contract extractor facts in graph queries", async () => {
    const cwd = await makePluginWorkspace();
    await loadConfiguredPlugins({ cwd });
    const servicePath = path.join(cwd, "grpc-service");
    const clientPath = path.join(cwd, "grpc-client");
    await fs.mkdir(path.join(servicePath, "src"), { recursive: true });
    await fs.mkdir(path.join(clientPath, "src"), { recursive: true });
    await fs.writeFile(path.join(servicePath, "package.json"), JSON.stringify({ name: "grpc-service" }), "utf8");
    await fs.writeFile(path.join(clientPath, "package.json"), JSON.stringify({ name: "grpc-client" }), "utf8");
    await fs.writeFile(path.join(servicePath, "src", "server.ts"), "export function serve() { grpc.registerService(\"user.UserService\"); }\n", "utf8");
    await fs.writeFile(path.join(clientPath, "src", "client.ts"), "export function call() { grpc.client(\"user.UserService\"); }\n", "utf8");

    const service: RepoNode = { id: repoId("grpc-service"), name: "grpc-service", path: servicePath, remoteUrl: "", branch: "", commitSha: "", language: "typescript", indexedAt: "now" };
    const client: RepoNode = { id: repoId("grpc-client"), name: "grpc-client", path: clientPath, remoteUrl: "", branch: "", commitSha: "", language: "typescript", indexedAt: "now" };
    const parsed = await Promise.all([
      parseSourceFile({ repoId: service.id, absolutePath: path.join(servicePath, "src", "server.ts"), relativePath: "src/server.ts", language: "typescript" }),
      parseSourceFile({ repoId: client.id, absolutePath: path.join(clientPath, "src", "client.ts"), relativePath: "src/client.ts", language: "typescript" })
    ]);
    const facts = await buildGraphFactsBatch({ batchId: "batch:grpc-plugin", indexedAt: "indexed", repos: [service, client], parsedFiles: parsed, semantic: true });
    expect(facts.contracts).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "api", key: "grpc:user.userservice" })
    ]));
    expect(facts.repoDependencies).toEqual(expect.arrayContaining([
      expect.objectContaining({ fromRepoId: client.id, toRepoId: service.id, dependencyType: "api" })
    ]));

    const db = await KuzuGraphDB.open(path.join(cwd, "graph"));
    try {
      await db.initSchema("plugin-test");
      await db.upsertRepo(service);
      await db.upsertRepo(client);
      await upsertParsedFiles(db, parsed, { semantic: true, batchId: "batch:grpc-plugin" }, [service, client]);
      const trace = await traceContract(db, "api", "grpc:user.UserService");
      expect(trace).toEqual(expect.arrayContaining([
        expect.objectContaining({ repoName: "grpc-service", role: "producer", rule: "grpc-fixture-plugin/grpc-service-producer" }),
        expect.objectContaining({ repoName: "grpc-client", role: "consumer", rule: "grpc-fixture-plugin/grpc-service-consumer" })
      ]));
      expect(await listDependencies(db)).toEqual(expect.arrayContaining([
        expect.objectContaining({ fromRepo: "grpc-client", toRepo: "grpc-service", dependencyType: "api", contractKey: "grpc:user.userservice" })
      ]));
    } finally {
      await db.close();
    }
  }, 20000);

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

  it("allows plugins to register CLI commands", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-cli-plugin-"));
    const pluginPath = path.join(cwd, "cli-plugin.mjs");
    await fs.writeFile(pluginPath, `export default {
      name: "cli-fixture-plugin",
      version: "1.0.0",
      pluginApiVersion: "1",
      setup(context) {
        context.registerCliCommand((program) => {
          program.command("fixture-audit").description("fixture audit command").action(() => {});
        });
      }
    };`, "utf8");
    await writeConfig({
      ...defaultConfig(),
      plugins: [{ name: pluginPath }]
    }, cwd);
    const program = new Command();
    const result = await loadConfiguredPlugins({ cwd, program });
    expect(result.cliCommandCount).toBe(1);
    expect(program.commands.map((command) => command.name())).toContain("fixture-audit");
  });

  it("does not let plugins override a system CLI command", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-cli-override-"));
    const pluginPath = path.join(cwd, "override-plugin.mjs");
    await fs.writeFile(pluginPath, `export default {
      name: "cli-override-plugin",
      version: "1.0.0",
      pluginApiVersion: "1",
      setup(context) {
        context.registerCliCommand((program) => {
          program.command("init").description("hijacked init").action(() => {});
        });
      }
    };`, "utf8");
    await writeConfig({
      ...defaultConfig(),
      plugins: [{ name: pluginPath }]
    }, cwd);
    const program = new Command();
    let systemInitRan = false;
    program.command("init").description("system init").action(() => { systemInitRan = true; });
    await loadConfiguredPlugins({ cwd, program });

    const initCommands = program.commands.filter((command) => command.name() === "init");
    expect(initCommands).toHaveLength(1);
    await program.parseAsync(["node", "logiclens", "init"]);
    expect(systemInitRan).toBe(true);
  });
});
