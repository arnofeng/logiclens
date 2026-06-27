import { loadConfig } from "../../config/loadConfig.js";
import { toRepoNode } from "../../core/workspace/repoRegistry.js";
import { detectFrameworks, isExtractorEnabled } from "../../core/frameworks/detect.js";
import { builtinContractExtractors } from "../../core/contracts/extraction/builtin/index.js";
import { loadConfiguredPlugins } from "../plugins/loader.js";

export async function frameworksCommand(cwd = process.cwd()): Promise<void> {
  const config = await loadConfig(cwd);
  // Ensure plugins are loaded
  await loadConfiguredPlugins({ cwd, config });

  const repos = config.repos.map((r) => toRepoNode(r, cwd));
  console.log(`Detected frameworks & enabled extractors for ${repos.length} repositories:\n`);

  for (const repo of repos) {
    console.log(`Repository: ${repo.name}`);
    console.log(`- Path: ${repo.path}`);
    
    const detected = await detectFrameworks(repo, []);
    console.log(`- Detected frameworks:`);
    if (detected.length === 0) {
      console.log(`  * (none)`);
    } else {
      for (const f of detected) {
        const evidenceSummary = f.evidence.map((ev) => {
          if (ev.filePath) {
            return `${ev.filePath}:${ev.line} [${ev.rule}]`;
          }
          return `[${ev.rule}]`;
        }).join(", ");
        console.log(`  * ${f.name} (language: ${f.language}, confidence: ${f.confidence}, evidence: ${evidenceSummary})`);
      }
    }

    console.log(`- Enabled contract extractors:`);
    const enabledExtractors = builtinContractExtractors.filter((ext) => isExtractorEnabled(ext, detected, config));
    if (enabledExtractors.length === 0) {
      console.log(`  * (none)`);
    } else {
      for (const ext of enabledExtractors) {
        console.log(`  * ${ext.name}`);
      }
    }
    console.log("");
  }
}
