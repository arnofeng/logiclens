import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseSourceFile } from "../src/parsers/parserRegistry.js";
import { envConfigExtractor } from "../src/extractors/builtin/envConfigExtractor.js";
import { repoId } from "../src/utils/path.js";

describe("Env Config Extractor", () => {
  it("extracts config references via process.env and config.get using AST", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-config-test-"));
    const sourcePath = path.join(dir, "config.ts");
    await fs.writeFile(
      sourcePath,
      `
      // process.env references
      const port = process.env.PORT || 3000;
      const dbUrl = process.env.DATABASE_URL;
      const bracketDbUrl = process.env["DATABASE_URL"];
      const invalidEnv = process.env.x; // too short/lowercase, ignored
      const validLowerEnv = process.env.database.host; // dot separated, valid key pattern

      // config.get references
      const appName = config.get('app.name');
      const appPort = config.get("APP_PORT");
      const dynamicVal = config.get(dynamicVar); // dynamic, ignored
      const invalidGet = config.get('a'); // too short/invalid format, ignored
      `,
      "utf8"
    );

    const parsed = await parseSourceFile({
      repoId: repoId("config-test"),
      absolutePath: sourcePath,
      relativePath: "config.ts",
      language: "typescript"
    });

    const context = {
      repos: [{ id: "config-test", name: "config-test", path: dir } as any],
      parsedFiles: [parsed],
      repoResolver: () => null as any
    };

    const extracted = await envConfigExtractor.extract(context);

    // Verify Contracts
    const contractNames = extracted.contracts.map((c) => c.name);
    expect(contractNames).toContain("PORT");
    expect(contractNames).toContain("DATABASE_URL");
    expect(contractNames).toContain("app.name");
    expect(contractNames).toContain("APP_PORT");

    expect(contractNames).not.toContain("x");
    expect(contractNames).not.toContain("a");

    // Verify Evidence rules and line numbers
    const portEvidence = extracted.evidence.find((e) => e.raw.includes("PORT"));
    expect(portEvidence).toBeDefined();
    expect(portEvidence?.line).toBe(3);
    expect(portEvidence?.rule).toBe("config-key-reference");

    const bracketEvidence = extracted.evidence.find((e) => e.raw.includes('["DATABASE_URL"]'));
    expect(bracketEvidence).toBeDefined();
    expect(bracketEvidence?.line).toBe(5);
    expect(bracketEvidence?.rule).toBe("config-key-reference");

    const appNameEvidence = extracted.evidence.find((e) => e.raw.includes("app.name"));
    expect(appNameEvidence).toBeDefined();
    expect(appNameEvidence?.line).toBe(10);
    expect(appNameEvidence?.rule).toBe("config-key-reference");

    await fs.rm(dir, { recursive: true, force: true });
  });
});
