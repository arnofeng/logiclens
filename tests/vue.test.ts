import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { eventExtractor } from "../src/core/contracts/extraction/builtin/eventExtractor.js";
import { resolveImports } from "../src/core/extraction/resolveReferences.js";
import { parseSourceFile } from "../src/core/parsing/parserRegistry.js";
import { repoId } from "../src/shared/path.js";

describe("vue parser", () => {
  it("extracts JS/TS symbols, imports, and calls from Vue SFC files", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "test-vue-"));
    
    // 1. Vue file with JS
    const jsVuePath = path.join(dir, "App.vue");
    await fs.writeFile(jsVuePath, `<template>
  <div class="container">
    <h1>Hello World</h1>
    <button @click="handleClick">Click me</button>
  </div>
</template>

<script>
import { someHelper } from './utils.js';

export default {
  name: 'App',
  methods: {
    handleClick() {
      someHelper();
      console.log('clicked');
    }
  }
}
</script>

<style scoped>
h1 {
  color: red;
}
</style>
`, "utf8");

    // 2. Vue file with TS and <script setup>
    const tsVuePath = path.join(dir, "Counter.vue");
    await fs.writeFile(tsVuePath, `<template>
  <button @click="increment">{{ count }}</button>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { apiCall } from '../api/service';

const count = ref(0);
function increment() {
  count.value++;
  eventBus.publish('counter.incremented');
  apiCall('/api/increment');
}
</script>
`, "utf8");

    const entryPath = path.join(dir, "main.ts");
    await fs.writeFile(entryPath, "import Counter from './Counter.vue';\nCounter;\n", "utf8");

    // Parse JS Vue
    const parsedJs = (await parseSourceFile({
      repoId: repoId("vue-repo"),
      absolutePath: jsVuePath,
      relativePath: "src/App.vue",
      language: "vue"
    })) as any;

    expect(parsedJs.language).toBe("vue");
    expect(parsedJs.imports.map((i: any) => i.module)).toContain("./utils.js");
    expect(parsedJs.symbols.map((s: any) => s.name)).toContain("handleClick");
    expect(parsedJs.calls.map((c: any) => c.calleeName)).toContain("someHelper");

    // Parse TS Vue
    const parsedTs = (await parseSourceFile({
      repoId: repoId("vue-repo"),
      absolutePath: tsVuePath,
      relativePath: "src/Counter.vue",
      language: "vue"
    })) as any;

    expect(parsedTs.language).toBe("vue");
    expect(parsedTs.imports.map((i: any) => i.module)).toContain("vue");
    expect(parsedTs.imports.map((i: any) => i.module)).toContain("../api/service");
    expect(parsedTs.symbols.map((s: any) => s.name)).toContain("increment");
    expect(parsedTs.calls.map((c: any) => c.calleeName)).toContain("apiCall");

    // Check line offsets in TS Vue
    const incrementSymbol = parsedTs.symbols.find((s: any) => s.name === "increment");
    expect(incrementSymbol).toBeDefined();
    expect(incrementSymbol?.startLine).toBe(10);

    const parsedEntry = (await parseSourceFile({
      repoId: repoId("vue-repo"),
      absolutePath: entryPath,
      relativePath: "src/main.ts",
      language: "typescript"
    })) as any;

    expect(resolveImports([parsedEntry, parsedTs])).toEqual([expect.objectContaining({
      fromFileId: parsedEntry.fileId,
      toFileId: parsedTs.fileId,
      module: "./Counter.vue"
    })]);

    const eventFacts = await eventExtractor.extract({
      repos: [{ id: repoId("vue-repo"), name: "vue-repo", path: dir } as any],
      parsedFiles: [parsedTs],
      repoResolver: () => null as any
    });
    expect(eventFacts.contracts.map((contract) => contract.key)).toContain("counter.incremented");

    // Clean up
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("handles Vue files larger than 32 KB without throwing Invalid argument", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "test-vue-large-"));
    const largeVuePath = path.join(dir, "LargeFile.vue");
    
    // Construct a Vue file larger than 32 KB (e.g. 40 KB)
    const padding = " ".repeat(40 * 1024);
    await fs.writeFile(largeVuePath, `<template>
  <div>
    <!-- ${padding} -->
    <h1>Large File</h1>
  </div>
</template>

<script>
export default {
  name: 'LargeFile',
  methods: {
    hello() {
      console.log('hello');
    }
  }
}
</script>
`, "utf8");

    const parsed = (await parseSourceFile({
      repoId: repoId("vue-repo"),
      absolutePath: largeVuePath,
      relativePath: "src/LargeFile.vue",
      language: "vue"
    })) as any;

    expect(parsed.language).toBe("vue");
    expect(parsed.symbols.map((s: any) => s.name)).toContain("hello");

    await fs.rm(dir, { recursive: true, force: true });
  });
});
