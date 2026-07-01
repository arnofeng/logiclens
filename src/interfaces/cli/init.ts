import fs from "node:fs/promises";
import path from "node:path";
import { BRAND, BRAND_PATHS, configFilePath } from "../../shared/branding.js";

/**
 * Scaffolds a branded workspace: creates the graph directory and writes a
 * default `config.yaml` if one does not already exist.
 *
 * Workspace scaffolding lives in the CLI layer (not the SDK) so that embedding
 * the SDK never touches the filesystem implicitly.
 */
export async function initCommand(cwd = process.cwd()): Promise<void> {
  await fs.mkdir(path.join(cwd, BRAND_PATHS.graph), { recursive: true });

  const configFile = configFilePath(cwd);
  const exists = await fs.stat(configFile).then(() => true).catch(() => false);
  if (!exists) {
    const template = `# ${BRAND.displayName} Configuration File

systemName: default-system

repos: []
`;
    await fs.writeFile(configFile, template, "utf8");
  }

  console.log(`Initialized ${BRAND.configDirName}/${BRAND.configFileName}`);
}
