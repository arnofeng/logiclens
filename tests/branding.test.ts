import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { configPath, defaultConfig } from "../src/config/loadConfig.js";
import { getBrandedEnv } from "../src/shared/branding.js";

describe("branding compatibility", () => {
  const originalEnv = process.env.LOGICLENS_TEST_BRANDING;

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.LOGICLENS_TEST_BRANDING;
    else process.env.LOGICLENS_TEST_BRANDING = originalEnv;
  });

  it("keeps the existing config path", () => {
    expect(configPath("/workspace")).toBe(path.join("/workspace", ".logiclens", "config.yaml"));
  });

  it("keeps existing default storage names", () => {
    const config = defaultConfig();
    expect(config.graph.path).toBe(".logiclens/graph");
    expect(config.semantic.jsonPath).toBe(".logiclens/semantic-index.json");
    expect(config.semantic.chroma.collection).toBe("logiclens");
  });

  it("reads current LOGICLENS-prefixed environment variables", () => {
    process.env.LOGICLENS_TEST_BRANDING = "enabled";
    expect(getBrandedEnv("TEST_BRANDING")).toBe("enabled");
  });
});
