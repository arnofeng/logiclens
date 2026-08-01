import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, expectTypeOf, it } from "vitest";
import { configSchema, type AppConfig } from "../src/config/schema.js";
import { defaultConfig, loadConfig, pruneConfig, writeConfig } from "../src/config/loadConfig.js";
import { BRAND_PATHS } from "../src/shared/branding.js";

describe("config schema - graph provider", () => {
  it("defaults to kuzu provider", () => {
    const result = configSchema.parse({});
    expect(result.graph.provider).toBe("kuzu");
    expect(result.graph.path).toBe(BRAND_PATHS.graph);
  });

  it("accepts kuzu provider", () => {
    const result = configSchema.parse({ graph: { provider: "kuzu", path: "/tmp/graph" } });
    expect(result.graph.provider).toBe("kuzu");
    expect(result.graph.path).toBe("/tmp/graph");
  });

  it("accepts neo4j provider", () => {
    const result = configSchema.parse({ graph: { provider: "neo4j" } });
    expect(result.graph.provider).toBe("neo4j");
  });

  it("accepts neo4j provider with url", () => {
    const result = configSchema.parse({
      graph: { provider: "neo4j", url: "bolt://localhost:7687" }
    });
    expect(result.graph.provider).toBe("neo4j");
    expect(result.graph.url).toBe("bolt://localhost:7687");
  });

  it("accepts neo4j provider with username and password", () => {
    const result = configSchema.parse({
      graph: { provider: "neo4j", url: "bolt://localhost:7687", username: "neo4j", password: "secret" }
    });
    expect(result.graph.provider).toBe("neo4j");
    expect(result.graph.username).toBe("neo4j");
    expect(result.graph.password).toBe("secret");
  });

  it("treats empty string username/password as undefined", () => {
    const result = configSchema.parse({
      graph: { provider: "neo4j", username: "", password: "" }
    });
    expect(result.graph.username).toBeUndefined();
    expect(result.graph.password).toBeUndefined();
  });

  it("url is optional and defaults to undefined", () => {
    const result = configSchema.parse({ graph: { provider: "neo4j" } });
    expect(result.graph.url).toBeUndefined();
  });

  it("username and password are optional and default to undefined", () => {
    const result = configSchema.parse({ graph: { provider: "kuzu" } });
    expect(result.graph.username).toBeUndefined();
    expect(result.graph.password).toBeUndefined();
  });

  it("accepts a custom provider ID without renaming it", () => {
    const result = configSchema.parse({ graph: { provider: "custom/provider:v1" } });
    expect(result.graph.provider).toBe("custom/provider:v1");
  });

  it("accepts a trimmed dedicated Neo4j database and rejects an empty name", () => {
    const result = configSchema.parse({
      graph: { provider: "neo4j", database: "  repohelix-test  " }
    });
    expect(result.graph.database).toBe("repohelix-test");
    expect(() => configSchema.parse({ graph: { provider: "neo4j", database: "   " } })).toThrow();
  });

  it.each(["", " ", "\t\r\n"])("rejects an empty or whitespace graph provider ID", (provider) => {
    expect(() => configSchema.parse({ graph: { provider } })).toThrow(
      "Provider ID must contain at least one non-whitespace character"
    );
  });

  it("infers graph.provider as string", () => {
    expectTypeOf<AppConfig["graph"]["provider"]>().toEqualTypeOf<string>();
  });

  it("graph defaults include provider and path when omitted", () => {
    const result = configSchema.parse({});
    expect(result.graph).toEqual({
      provider: "kuzu",
      path: BRAND_PATHS.graph,
      url: undefined,
      username: undefined,
      password: undefined,
      database: undefined
    });
  });
});

describe("config schema - lexical retrieval", () => {
  it("defaults retrieval when it is omitted", () => {
    expect(configSchema.parse({}).retrieval).toEqual({
      lexical: { provider: "auto", scope: "workspace" }
    });
  });

  it.each([
    [{ retrieval: {} }, { provider: "auto", scope: "workspace" }],
    [{ retrieval: { lexical: {} } }, { provider: "auto", scope: "workspace" }],
    [{ retrieval: { lexical: { provider: "companion" } } }, { provider: "companion", scope: "workspace" }],
    [{ retrieval: { lexical: { scope: "workspace" } } }, { provider: "auto", scope: "workspace" }]
  ])("fills lexical defaults for partial configuration", (input, expected) => {
    expect(configSchema.parse(input).retrieval.lexical).toEqual(expected);
  });

  it("preserves an explicit lexical provider ID", () => {
    const result = configSchema.parse({
      retrieval: { lexical: { provider: "custom/lexical:v1" } }
    });
    expect(result.retrieval.lexical.provider).toBe("custom/lexical:v1");
  });

  it.each(["", " ", "\t\r\n"])("rejects an empty or whitespace lexical provider ID", (provider) => {
    expect(() => configSchema.parse({ retrieval: { lexical: { provider } } })).toThrow(
      "Provider ID must contain at least one non-whitespace character"
    );
  });

  it("rejects a non-workspace lexical scope", () => {
    expect(() => configSchema.parse({
      retrieval: { lexical: { scope: "repo" } }
    })).toThrow();
  });

  it("prunes the default retrieval configuration", () => {
    expect(pruneConfig(defaultConfig())).not.toHaveProperty("retrieval");
  });

  it("round-trips a custom lexical provider through a temporary config", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "repohelix-config-schema-"));
    const config = {
      ...defaultConfig(),
      retrieval: {
        lexical: { provider: "custom/lexical:v1", scope: "workspace" as const }
      }
    };

    await writeConfig(config, cwd);

    expect((await loadConfig(cwd)).retrieval).toEqual(config.retrieval);
  });
});
