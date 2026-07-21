import { describe, expect, it } from "vitest";
import {
  NEO4J_INTEGRATION_ENV,
  isSharedNeo4jDatabase,
  runNeo4jCleanupSteps,
  resolveNeo4jTestEnvironment,
} from "./helpers/neo4jTestEnvironment.js";

function configured(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    [NEO4J_INTEGRATION_ENV.enabled]: "1",
    [NEO4J_INTEGRATION_ENV.url]: "neo4j+s://example.invalid",
    [NEO4J_INTEGRATION_ENV.username]: "test-user",
    [NEO4J_INTEGRATION_ENV.password]: "secret-value",
    [NEO4J_INTEGRATION_ENV.database]: "logiclens-test",
    ...overrides,
  };
}

describe("Neo4j integration test environment", () => {
  it("reports an explicit disabled reason without exposing configuration values", () => {
    const environment = resolveNeo4jTestEnvironment({});
    expect(environment.enabled).toBe(false);
    expect(environment.runnable).toBe(false);
    expect(environment.testName).toContain(`${NEO4J_INTEGRATION_ENV.enabled}=1 required`);
  });

  it("fails after explicit enablement when required configuration is incomplete", () => {
    const environment = resolveNeo4jTestEnvironment({
      [NEO4J_INTEGRATION_ENV.enabled]: "1",
      [NEO4J_INTEGRATION_ENV.url]: "neo4j+s://must-not-appear.invalid",
    });
    expect(environment.runnable).toBe(false);
    expect(environment.testName).toContain(NEO4J_INTEGRATION_ENV.password);
    expect(environment.testName).not.toContain("must-not-appear");
    expect(() => environment.requireConfiguration()).toThrow(/incomplete/u);
  });

  it.each(["neo4j", "system", " NEO4J "])("protects shared database %s", (database) => {
    const environment = resolveNeo4jTestEnvironment(configured({
      [NEO4J_INTEGRATION_ENV.database]: database,
    }));
    expect(environment.runnable).toBe(false);
    expect(() => environment.requireConfiguration()).toThrow(/Unsafe/u);
    expect(isSharedNeo4jDatabase(database)).toBe(true);
  });

  it("requires an extra explicit flag before allowing an ephemeral default database", () => {
    const withoutPermission = resolveNeo4jTestEnvironment(configured({
      [NEO4J_INTEGRATION_ENV.database]: "neo4j",
    }));
    expect(withoutPermission.testName).toContain(NEO4J_INTEGRATION_ENV.ephemeral);

    const permitted = resolveNeo4jTestEnvironment(configured({
      [NEO4J_INTEGRATION_ENV.database]: "neo4j",
      [NEO4J_INTEGRATION_ENV.ephemeral]: "1",
    }));
    expect(permitted.runnable).toBe(true);
    expect(permitted.requireConfiguration()).toMatchObject({ database: "neo4j", ephemeral: true });
  });

  it("accepts a dedicated database and never includes secrets in its summary", () => {
    const environment = resolveNeo4jTestEnvironment(configured());
    expect(environment.runnable).toBe(true);
    expect(environment.testName).not.toContain("secret-value");
    expect(environment.requireConfiguration().database).toBe("logiclens-test");
  });

  it("runs every cleanup step and aggregates failures after close", async () => {
    const calls: string[] = [];
    await expect(runNeo4jCleanupSteps([
      { name: "data", run: () => { calls.push("data"); throw new Error("data failed"); } },
      { name: "index", run: () => { calls.push("index"); throw new Error("index failed"); } },
      { name: "close", run: () => { calls.push("close"); } },
    ])).rejects.toMatchObject({
      name: "AggregateError",
      errors: [
        expect.objectContaining({ message: "Neo4j cleanup step failed: data" }),
        expect.objectContaining({ message: "Neo4j cleanup step failed: index" }),
      ],
    });
    expect(calls).toEqual(["data", "index", "close"]);
  });
});
