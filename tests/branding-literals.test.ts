import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BRAND } from "../src/shared/branding.js";

const root = process.cwd();
const checkedRoots = ["src", "scripts", "bin"];
const allowedFiles = new Set([
  "src/shared/branding.ts",
  "src/config/schema.ts",
  "src/index.ts",
  "src/interfaces/sdk/client.ts",
  "src/core/plugins/adapter.ts",
  "src/core/plugins/register.ts"
]);
const blockedPattern = new RegExp([
  BRAND.displayName,
  BRAND.cliName,
  BRAND.envPrefix
].map(escapeRegExp).join("|"));

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function collectFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return collectFiles(full);
    if (!/\.(ts|tsx|js|md)$/.test(entry.name)) return [];
    return [full];
  });
}

describe("branding literals", () => {
  it("keeps runtime brand literals behind the branding layer or compatibility exports", () => {
    const offenders: string[] = [];
    for (const checkedRoot of checkedRoots) {
      for (const file of collectFiles(path.join(root, checkedRoot))) {
        const relative = path.relative(root, file).replace(/\\/g, "/");
        if (allowedFiles.has(relative)) continue;
        const content = fs.readFileSync(file, "utf8");
        if (blockedPattern.test(content)) offenders.push(relative);
      }
    }

    expect(offenders).toEqual([]);
  });
});
