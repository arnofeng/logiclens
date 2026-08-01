import { describe, expect, it } from "vitest";
import {
  MCP_IMPACT_ANALYSIS_DESCRIPTION,
  MCP_IMPACT_CHANGE_DESCRIPTION,
  MCP_IMPACT_TARGET_DESCRIPTION,
} from "../src/interfaces/mcp/server.js";

describe("MCP impact analysis descriptions", () => {
  it("separates structured ContractSpec analysis from the legacy symbol survey", () => {
    expect(MCP_IMPACT_ANALYSIS_DESCRIPTION).toContain("two distinct modes");
    expect(MCP_IMPACT_ANALYSIS_DESCRIPTION).toContain("must resolve to an indexed ContractSpec");
    expect(MCP_IMPACT_ANALYSIS_DESCRIPTION).toContain("does not analyze arbitrary code symbols");
    expect(MCP_IMPACT_ANALYSIS_DESCRIPTION).toContain("legacy broad symbol/entity impact survey");
  });

  it("explains how bare class names and exact contract identifiers are handled", () => {
    expect(MCP_IMPACT_TARGET_DESCRIPTION).toContain("exact indexed contract identifier");
    expect(MCP_IMPACT_TARGET_DESCRIPTION).toContain("bare class name is treated as a schema name");
    expect(MCP_IMPACT_TARGET_DESCRIPTION).toContain("indexed as a schema ContractSpec");
  });

  it("documents supported structured target and change combinations", () => {
    expect(MCP_IMPACT_CHANGE_DESCRIPTION).toContain("schema with field-added/field-removed/field-type-changed");
    expect(MCP_IMPACT_CHANGE_DESCRIPTION).toContain("HTTP endpoint with endpoint-removed");
    expect(MCP_IMPACT_CHANGE_DESCRIPTION).toContain("event with topic-removed");
    expect(MCP_IMPACT_CHANGE_DESCRIPTION).toContain("gRPC, Dubbo, or GraphQL operation with rpc-removed");
  });
});
