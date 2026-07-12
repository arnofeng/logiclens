import fs from "node:fs/promises";
import path from "node:path";
import { BRAND, BRAND_PATHS, configFileCandidates, configFilePath } from "../../shared/branding.js";

/**
 * Scaffolds a branded workspace: creates the graph directory and writes a
 * default `config.yaml` if one does not already exist.
 *
 * Workspace scaffolding lives in the CLI layer (not the SDK) so that embedding
 * the SDK never touches the filesystem implicitly.
 */
export async function initCommand(cwd = process.cwd()): Promise<void> {
  const configFile = configFilePath(cwd);
  const existingConfig = await Promise.all(
    configFileCandidates(cwd).map(async (file) => await fs.stat(file).then(() => file).catch(() => undefined))
  ).then((files) => files.find(Boolean));

  if (existingConfig && existingConfig !== configFile) {
    console.log(`Workspace already initialized at ${path.relative(cwd, existingConfig) || existingConfig}`);
    return;
  }

  await fs.mkdir(path.join(cwd, BRAND_PATHS.graph), { recursive: true });
  const workspaceGitignore = path.join(cwd, BRAND.configDirName, ".gitignore");
  const gitignoreTemplate = `graph/
tmp/
plugins/
logs/
semantic-index.json
mcp.pid
`;
  await fs.writeFile(workspaceGitignore, gitignoreTemplate, { encoding: "utf8", flag: "wx" }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });

  if (!existingConfig) {
    const template = `# ${BRAND.displayName} Configuration File

systemName: default-system

repos: []
`;
    await fs.writeFile(configFile, template, "utf8");
  }

  console.log(`Initialized ${BRAND.configDirName}/${BRAND.configFileName}`);
}
