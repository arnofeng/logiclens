import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config/loadConfig.js";
import { buildGraphFactsBatch } from "../src/core/graph-model/facts.js";
import { parseSourceFile } from "../src/core/parsing/parserRegistry.js";
import { getLoadedLanguageGrammar } from "../src/core/parsing/languages/registry.js";
import { autoDetectAndRegisterPlugins } from "../src/core/plugins/register.js";
import { parserRegistry } from "../src/core/registries/registry.js";
import { repoId } from "../src/shared/path.js";

describe("lazy Vue parser delegates", () => {
  it("loads only the actual JSX or TSX grammar through parsing and extraction", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-lazy-vue-"));
    const jsPath = path.join(dir, "App.vue");
    const tsPath = path.join(dir, "Counter.vue");
    await fs.writeFile(jsPath, `<script>\nexport function publish() { eventBus.publish("app.ready"); }\n</script>\n`, "utf8");
    await fs.writeFile(tsPath, `<script setup lang="ts">\nconst count: number = 1;\n</script>\n`, "utf8");
    const config = { ...defaultConfig(), repos: [{ name: "vue", path: dir }] };

    try {
      await autoDetectAndRegisterPlugins({ config, cwd: dir, repoConfigs: config.repos });

      for (const language of ["vue", "javascript", "jsx", "typescript", "tsx"]) {
        expect(parserRegistry.resolve({ language })).toBeDefined();
      }
      for (const language of ["javascript", "jsx", "typescript", "tsx"]) {
        expect(getLoadedLanguageGrammar(language)).toBeUndefined();
      }

      const id = repoId("vue");
      const parsedJs = await parseSourceFile({
        repoId: id,
        absolutePath: jsPath,
        relativePath: "App.vue",
        language: "vue"
      });
      expect(parsedJs.language).toBe("vue");
      expect("parseLanguage" in parsedJs ? parsedJs.parseLanguage : undefined).toBe("jsx");
      expect(getLoadedLanguageGrammar("jsx")).toBeDefined();
      expect(getLoadedLanguageGrammar("tsx")).toBeUndefined();

      const repo = {
        id,
        name: "vue",
        path: dir,
        remoteUrl: "",
        branch: "",
        commitSha: "",
        language: "vue",
        indexedAt: "now"
      };
      const facts = await buildGraphFactsBatch({
        batchId: "batch:lazy-vue-js",
        repos: [repo],
        parsedFiles: [parsedJs],
        semantic: false
      });
      expect(facts.files).toHaveLength(1);
      expect(getLoadedLanguageGrammar("tsx")).toBeUndefined();

      const parsedTs = await parseSourceFile({
        repoId: id,
        absolutePath: tsPath,
        relativePath: "Counter.vue",
        language: "vue"
      });
      expect(parsedTs.language).toBe("vue");
      expect("parseLanguage" in parsedTs ? parsedTs.parseLanguage : undefined).toBe("tsx");
      expect(getLoadedLanguageGrammar("tsx")).toBeDefined();
      expect(getLoadedLanguageGrammar("javascript")).toBeUndefined();
      expect(getLoadedLanguageGrammar("typescript")).toBeUndefined();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
