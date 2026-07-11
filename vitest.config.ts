import { defineConfig } from "vitest/config";
import { realpathSync } from "node:fs";

const root = realpathSync(process.cwd()).replace(/^[a-z]:/, (match) => match.toUpperCase());

export default defineConfig({
  root,
  resolve: {
    alias: [
      { find: "@logiclens/plugin-sdk/utils", replacement: pathAlias("packages/plugin-sdk/src/utils.ts") },
      { find: "@logiclens/plugin-sdk", replacement: pathAlias("packages/plugin-sdk/src/index.ts") },
      { find: "@logiclens/plugin-runtime", replacement: pathAlias("packages/plugin-runtime/src/index.ts") }
    ]
  },
  test: {
    include: ["tests/**/*.test.ts", "packages/*/tests/**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**"]
  }
});

function pathAlias(relativePath: string): string {
  return `${root}/${relativePath}`.replace(/\\/g, "/");
}
