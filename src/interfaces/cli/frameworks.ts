import { loadConfig } from "../../config/loadConfig.js";
import { toRepoNode } from "../../core/workspace/repoRegistry.js";
import { detectFrameworks, isExtractorEnabled } from "../../core/frameworks/detect.js";
import { registeredContractExtractors } from "../../core/contracts/extraction/builtin/index.js";
import { autoDetectAndRegisterPlugins } from "../../core/plugins/register.js";
import { parseSourceFile, registerCommonParsers } from "../../core/parsing/parserRegistry.js";
import { scanRepoFiles } from "../../core/workspace/fileScanner.js";
import type { AppConfig } from "../../config/schema.js";
import type { ParsedGraphFile, RepoNode } from "../../core/parsing/types.js";

export async function parseFrameworkDetectionFiles(repo: RepoNode, config: AppConfig): Promise<ParsedGraphFile[]> {
  registerCommonParsers();
  const xmlFiles = (await scanRepoFiles(repo.path, config)).filter((file) => file.language === "xml");
  return Promise.all(xmlFiles.map((file) => parseSourceFile({
    repoId: repo.id,
    absolutePath: file.absolutePath,
    relativePath: file.relativePath,
    language: file.language
  })));
}

export async function frameworksCommand(cwd = process.cwd()): Promise<void> {
  const config = await loadConfig(cwd);
  await autoDetectAndRegisterPlugins({
    config,
    cwd,
    repoConfigs: config.repos,
    warn: (message) => console.warn(message)
  });

  const repos = config.repos.map((r) => toRepoNode(r, cwd));
  console.log(`Detected frameworks & enabled extractors for ${repos.length} repositories:\n`);

  for (const repo of repos) {
    console.log(`Repository: ${repo.name}`);
    console.log(`- Path: ${repo.path}`);
    
    const parsedFiles = await parseFrameworkDetectionFiles(repo, config);
    const detected = await detectFrameworks(repo, parsedFiles);
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
    const enabledExtractors = registeredContractExtractors().filter((ext) => isExtractorEnabled(ext, detected, config));
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
