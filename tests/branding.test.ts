import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { configPath, defaultConfig } from "../src/config/loadConfig.js";
import {
  allInstallerSectionMarkers,
  BRAND,
  BRAND_PATHS,
  brandedInstallerSectionMarkers,
  brandedTempDirPrefix,
  getBrandedEnv
} from "../src/shared/branding.js";
import { removeBrandedMarkedSection } from "../src/interfaces/installer/targets/shared.js";

describe("branding", () => {
  const envName = `${BRAND.envPrefix}TEST_BRANDING`;
  const originalEnv = process.env[envName];

  afterEach(() => {
    if (originalEnv === undefined) delete process.env[envName];
    else process.env[envName] = originalEnv;
  });

  it("uses the branded config path", () => {
    expect(configPath("/workspace")).toBe(path.join("/workspace", BRAND.configDirName, BRAND.configFileName));
  });

  it("uses branded default storage names", () => {
    const config = defaultConfig();
    expect(config.graph.path).toBe(BRAND_PATHS.graph);
  });

  it("reads current branded environment variables", () => {
    process.env[envName] = "enabled";
    expect(getBrandedEnv("TEST_BRANDING")).toBe("enabled");
  });

  it("generates and removes branded installer markers", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), brandedTempDirPrefix("branding-marker")));
    const file = path.join(cwd, "AGENTS.md");
    const markers = allInstallerSectionMarkers().at(0) ?? brandedInstallerSectionMarkers();
    await fs.writeFile(file, `before\n${markers.start}\nold body\n${markers.end}\nafter\n`, "utf8");

    expect(brandedInstallerSectionMarkers()).toEqual({ start: `<!-- ${BRAND.installerSectionName}_START -->`, end: `<!-- ${BRAND.installerSectionName}_END -->` });
    expect(removeBrandedMarkedSection(file)).toBe("removed");
    await expect(fs.readFile(file, "utf8")).resolves.toBe("before\n\nafter\n");
  });
});
