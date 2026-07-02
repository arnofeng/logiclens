import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { configPath, defaultConfig, loadConfig } from "../src/config/loadConfig.js";
import {
  allInstallerSectionMarkers,
  BRAND,
  BRAND_DEFAULTS,
  BRAND_PATHS,
  brandedInstallerSectionMarkers,
  brandedTempDirPrefix,
  getBrandedEnv
} from "../src/shared/branding.js";
import { removeBrandedMarkedSection } from "../src/interfaces/installer/targets/shared.js";

describe("branding compatibility", () => {
  const envName = `${BRAND.envPrefix}TEST_BRANDING`;
  const originalEnv = process.env[envName];

  afterEach(() => {
    if (originalEnv === undefined) delete process.env[envName];
    else process.env[envName] = originalEnv;
  });

  it("keeps the existing config path", () => {
    expect(configPath("/workspace")).toBe(path.join("/workspace", BRAND.configDirName, BRAND.configFileName));
  });

  it("keeps existing default storage names", () => {
    const config = defaultConfig();
    expect(config.graph.path).toBe(BRAND_PATHS.graph);
    expect(config.semantic.jsonPath).toBe(BRAND_PATHS.semanticIndex);
    expect(config.semantic.chroma.collection).toBe(BRAND_DEFAULTS.chromaCollection);
  });

  it("reads current branded environment variables", () => {
    process.env[envName] = "enabled";
    expect(getBrandedEnv("TEST_BRANDING")).toBe("enabled");
  });

  it("loads config from legacy config directories", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), brandedTempDirPrefix("branding-legacy")));
    const legacyDir = BRAND.legacy.configDirNames[0];
    await fs.mkdir(path.join(cwd, legacyDir), { recursive: true });
    await fs.writeFile(path.join(cwd, legacyDir, BRAND.configFileName), "systemName: legacy-system\nrepos: []\n", "utf8");

    await expect(loadConfig(cwd)).resolves.toMatchObject({ systemName: "legacy-system" });
  });

  it("generates branded installer markers and removes legacy marked sections", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), brandedTempDirPrefix("branding-marker")));
    const file = path.join(cwd, "AGENTS.md");
    const legacyMarkers = allInstallerSectionMarkers().at(-1) ?? brandedInstallerSectionMarkers();
    await fs.writeFile(file, `before\n${legacyMarkers.start}\nold body\n${legacyMarkers.end}\nafter\n`, "utf8");

    expect(brandedInstallerSectionMarkers()).toEqual({ start: `<!-- ${BRAND.installerSectionName}_START -->`, end: `<!-- ${BRAND.installerSectionName}_END -->` });
    expect(removeBrandedMarkedSection(file)).toBe("removed");
    await expect(fs.readFile(file, "utf8")).resolves.toBe("before\n\nafter\n");
  });
});
