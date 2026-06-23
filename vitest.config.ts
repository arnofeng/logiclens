import { defineConfig } from "vitest/config";
import { realpathSync } from "node:fs";

const root = realpathSync(process.cwd()).replace(/^[a-z]:/, (match) => match.toUpperCase());

export default defineConfig({
  root,
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**"]
  }
});

