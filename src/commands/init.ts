import fs from "node:fs/promises";
import path from "node:path";

/**
 * Scaffolds a `.logiclens` workspace: creates the graph and cache directories
 * and writes a default `config.yaml` if one does not already exist.
 *
 * Workspace scaffolding lives in the CLI layer (not the SDK) so that embedding
 * the SDK never touches the filesystem implicitly.
 */
export async function initCommand(cwd = process.cwd()): Promise<void> {
  await fs.mkdir(path.join(cwd, ".logiclens", "graph"), { recursive: true });
  await fs.mkdir(path.join(cwd, ".logiclens", "cache"), { recursive: true });

  const configFile = path.join(cwd, ".logiclens", "config.yaml");
  const exists = await fs.stat(configFile).then(() => true).catch(() => false);
  if (!exists) {
    const template = `# LogicLens Configuration File

systemName: default-system

repos: []
`;
    await fs.writeFile(configFile, template, "utf8");
  }

  console.log("Initialized .logiclens/config.yaml");
}
