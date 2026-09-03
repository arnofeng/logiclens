import { describe, expect, expectTypeOf, it } from "vitest";
import { configSchema, type AppConfig } from "../src/config/schema.js";
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

describe("config schema - removed search configuration", () => {
  it("strips legacy retrieval, embedding, and vector semantic fields", () => {
    const result = configSchema.parse({
      retrieval: { lexical: { provider: "auto" } },
      embedding: { provider: "off" },
      semantic: { provider: "json", jsonPath: "semantic-index.json" }
    });

    expect(result).not.toHaveProperty("retrieval");
    expect(result).not.toHaveProperty("embedding");
    expect(result).not.toHaveProperty("semantic");
  });
});
