import { ProgressBar } from "../../shared/progress.js";
import { createLogicLens } from "../sdk/client.js";
import { findBlockedReindexTargets } from "../../core/indexing/run.js";
import type { IndexOptions } from "../../core/indexing/types.js";

export async function indexCommand(options: IndexOptions, cwd = process.cwd()): Promise<void> {
  const client = await createLogicLens({
    cwd,
    logger: {
      log: (msg) => console.log(msg),
      warn: (msg) => console.warn(msg),
      error: (msg) => console.error(msg),
      writeStderr: (msg) => process.stderr.write(msg),
      createProgressBar: (label, total) => new ProgressBar(label, total)
    }
  });
  try {
    // Refuse a full re-index of already-indexed repos and point at the cheaper
    // alternatives: --changed-only for incremental updates, or deleting the
    // graph for a clean bulk-copy rebuild. A first index of a newly added repo
    // still goes through.
    if (!options.changedOnly) {
      const blocked = findBlockedReindexTargets({
        changedOnly: options.changedOnly,
        repo: options.repo,
        configuredRepoNames: client.getConfig().repos.map((repo) => repo.name),
        indexedRepoNames: (await client.listRepos()).map((repo) => repo.name)
      });
      if (blocked.length > 0) {
        const graphPath = client.getConfig().graph.path;
        console.error(`Already indexed: ${blocked.join(", ")}.`);
        console.error(`Use "logiclens index --changed-only" to update incrementally, or delete the graph (${graphPath}) and re-run "logiclens index" for a clean full rebuild.`);
        process.exitCode = 1;
        return;
      }
    }
    const result = await client.index(options);
    console.log(`Indexed ${client.getConfig().repos.length} repos`);
    console.log(`Files scanned: ${result.filesScanned}`);
    console.log(`Files changed: ${result.filesChanged}`);
    console.log(`Code nodes: ${result.codeNodes}`);
    console.log(`Section nodes: ${result.sectionNodes}`);
    console.log(`Call edges: ${result.callEdges}`);
    console.log(`Import edges: ${result.importEdges}`);
    console.log(`Entities: ${result.entities}`);
    const totalDuration = (result.durationMs / 1000).toFixed(1);
    process.stderr.write(`Total duration: ${totalDuration}s\n`);
  } finally {
    await client.close();
  }
}
