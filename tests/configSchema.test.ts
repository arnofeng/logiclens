import { describe, expect, it } from "vitest";
import { configSchema } from "../src/config/schema.js";

describe("config schema - graph provider", () => {
  it("defaults to kuzu provider", () => {
    const result = configSchema.parse({});
    expect(result.graph.provider).toBe("kuzu");
    expect(result.graph.path).toBe(".logiclens/graph");
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

  it("rejects invalid provider value", () => {
    expect(() => configSchema.parse({ graph: { provider: "invalid" } })).toThrow();
  });

  it("graph defaults include provider and path when omitted", () => {
    const result = configSchema.parse({});
    expect(result.graph).toEqual({
      provider: "kuzu",
      path: ".logiclens/graph",
      url: undefined,
      username: undefined,
      password: undefined
    });
  });
});
