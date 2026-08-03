import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("legacy schema source/artifact scan contract", () => {
  it("keeps the scanner explicit, production-scoped, and free of baseline mutation", async () => {
    const source = await fs.readFile(path.resolve("scripts/legacy-schema-scan.ts"), "utf8");
    expect(source).toContain("schema-ref-protocol");
    expect(source).toContain("suffix-only-discovery");
    expect(source).toContain("pending-schema-relation");
    expect(source).toContain("deprecated-extractor-types");
    expect(source).toContain("legacy-lexical-backfill");
    expect(source).toContain("Production artifact scan requires a completed build");
    expect(source).not.toMatch(/writeFile|appendFile/u);
  });
});
