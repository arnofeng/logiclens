import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createClient } from "../../src/index.js";
import { defaultConfig, writeConfig } from "../../src/config/loadConfig.js";
import { FileWatcher } from "../../src/features/watch/watcher.js";
import type { WorkspaceLexicalStore } from "../../src/core/retrieval/provider.js";
import { deriveWorkspaceId } from "../../src/core/workspace/identity.js";
import { parseRenderRef } from "../../src/core/retrieval/renderRef.js";

async function waitUntil(predicate: () => boolean, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out after ${timeoutMs}ms waiting for watcher state.`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const cwd = process.argv[2];
if (!cwd) throw new Error("Expected a temporary workspace path.");
const repoA = path.join(cwd, "repo-a");
const repoB = path.join(cwd, "repo-b");
await fs.mkdir(path.join(repoA, "src"), { recursive: true });
await fs.mkdir(path.join(repoB, "src"), { recursive: true });
await fs.writeFile(path.join(repoA, "src", "base.ts"), "export class AlphaBase {}", "utf8");
await fs.writeFile(path.join(repoB, "src", "base.ts"), "export class BetaBase {}", "utf8");
const base = defaultConfig();
const systemName = `watch-lexical-${path.basename(cwd)}`;
await writeConfig({
  ...base,
  systemName,
  indexing: { ...base.indexing, concurrency: 1 },
  repos: [{ name: "repo-a", path: "./repo-a" }, { name: "repo-b", path: "./repo-b" }]
}, cwd);
const client = await createClient({ cwd, logger: { log() {}, warn() {}, error() {} } });
const watcher = new FileWatcher(client, { debounceMs: 20, syncConcurrency: 1 });
try {
  await client.index({ writeMode: "auto" });
  const store = await (client as unknown as { resolveLexicalStore(): Promise<WorkspaceLexicalStore> }).resolveLexicalStore();
  const workspaceId = deriveWorkspaceId(systemName);
  assert.equal(await watcher.start(), true);

  const createdPath = path.join(repoA, "src", "watched.ts");
  await fs.writeFile(createdPath, "export class WatchCreatedMarker {}", "utf8");
  await watcher.ingestEventForTests("repo-a", "src/watched.ts");
  await waitUntil(() => watcher.getPendingFiles().length === 0);
  const createdHits = await store.search({ workspaceId, text: "WatchCreatedMarker" }, { topK: 20 });
  assert.equal(createdHits.some((hit) => hit.repoId.endsWith("repo-a")), true);
  const createdDocument = (await store.loadDocuments({ workspaceId, documentIds: createdHits.map((hit) => hit.documentId) }))
    .find((document) => document.kind === "code")!;

  await fs.writeFile(createdPath, "export class WatchCreatedMarker { value() { return 2; } }", "utf8");
  await watcher.ingestEventForTests("repo-a", "src/watched.ts");
  await waitUntil(() => watcher.getPendingFiles().length === 0);
  const modifiedHits = await store.search({ workspaceId, text: "WatchCreatedMarker" }, { topK: 20 });
  const modifiedDocument = (await store.loadDocuments({ workspaceId, documentIds: modifiedHits.map((hit) => hit.documentId) }))
    .find((document) => document.kind === "code")!;
  assert.notEqual(modifiedDocument.sourceHash, createdDocument.sourceHash);

  const renamedPath = path.join(repoA, "src", "renamed.ts");
  await fs.rename(createdPath, renamedPath);
  await watcher.ingestEventForTests("repo-a", "src/watched.ts");
  await watcher.ingestEventForTests("repo-a", "src/renamed.ts");
  await waitUntil(() => watcher.getPendingFiles().length === 0);
  const renamedHits = await store.search({ workspaceId, text: "WatchCreatedMarker" }, { topK: 20 });
  assert.ok(renamedHits.length > 0);
  assert.equal(renamedHits.every((hit) => parseRenderRef(hit.renderRef, workspaceId).path !== "src/watched.ts"), true);

  await fs.rm(renamedPath);
  await watcher.ingestEventForTests("repo-a", "src/renamed.ts");
  await waitUntil(() => watcher.getPendingFiles().length === 0);
  assert.equal((await store.search({ workspaceId, text: "WatchCreatedMarker" }, { topK: 20 })).length, 0);

  const originalIndex = client.index.bind(client);
  client.index = (async (options) => {
    if (options?.repo === "repo-a") throw new Error("injected paused-repo failure");
    return originalIndex(options);
  }) as typeof client.index;
  await fs.writeFile(path.join(repoA, "src", "paused.ts"), "export class PausedRepoMarker {}", "utf8");
  await fs.writeFile(path.join(repoB, "src", "healthy.ts"), "export class HealthyRepoMarker {}", "utf8");
  await watcher.ingestEventForTests("repo-a", "src/paused.ts");
  await watcher.ingestEventForTests("repo-b", "src/healthy.ts");
  await waitUntil(() => watcher.getStatus().pausedRepos.includes("repo-a") && !watcher.getPendingFiles().some((file) => file.repoName === "repo-b"));
  const pausedHits = await store.search({ workspaceId, text: "PausedRepoMarker" }, { topK: 20 });
  const pausedDocuments = await store.loadDocuments({ workspaceId, documentIds: pausedHits.map((hit) => hit.documentId) });
  assert.equal(pausedDocuments.some((document) => document.qualifiedName === "PausedRepoMarker"), false);
  const healthyHits = await store.search({ workspaceId, text: "HealthyRepoMarker" }, { topK: 20 });
  const healthyDocuments = await store.loadDocuments({ workspaceId, documentIds: healthyHits.map((hit) => hit.documentId) });
  assert.equal(healthyDocuments.some((document) => document.repoId.endsWith("repo-b") && document.qualifiedName === "HealthyRepoMarker"), true);
  await waitUntil(() => !(watcher as unknown as { syncPromise?: Promise<void> }).syncPromise && !client.getWatchStatus().indexQueue.running);
  process.stdout.write("watch lexical scenario passed\n");
} finally {
  watcher.stop();
  await client.close();
}
