import path from "node:path";

export const BRAND = {
  displayName: "RepoHelix",
  cliName: "repohelix",
  packageName: "repohelix",
  docsCommandName: "repohelix",
  tempDirPrefix: "repohelix",
  configDirName: ".repohelix",
  configFileName: "config.yaml",
  envPrefix: "REPOHELIX_",
  mcpServerName: "repohelix",
  mcpToolPrefix: "repohelix",
  installerSectionName: "REPOHELIX"
} as const;

export const BRAND_PATHS = {
  graph: `${BRAND.configDirName}/graph`,
  logs: `${BRAND.configDirName}/logs`,
  mcpPid: `${BRAND.configDirName}/mcp.pid`,
  batchStaging: `${BRAND.configDirName}/tmp/batches`
} as const;

export const BRAND_DEFAULTS = {
  mcpProcessName: `${BRAND.cliName}-mcp-server`
} as const;

export const BRAND_PLUGIN_PACKAGES = {
  sdk: "@repohelix/plugin-sdk",
  sdkUtils: "@repohelix/plugin-sdk/utils"
} as const;

export function brandedPath(cwd: string, relativePath: string): string {
  return path.resolve(cwd, relativePath);
}

export function configFilePath(cwd: string): string {
  return path.join(cwd, BRAND.configDirName, BRAND.configFileName);
}

export function configFileCandidates(cwd: string): string[] {
  return [configFilePath(cwd)];
}

export function brandedConfigDirPaths(cwd: string): string[] {
  return [path.join(cwd, BRAND.configDirName)];
}

export function brandedTempDirPrefix(name: string): string {
  return `${BRAND.tempDirPrefix}-${name}-`;
}

export function getBrandedEnv(key: string): string | undefined {
  return process.env[`${BRAND.envPrefix}${key}`];
}

export function brandedMcpToolName(name: string): string {
  return `${BRAND.mcpToolPrefix}_${name}`;
}

export function brandedMcpPermission(toolName: string): string {
  return `mcp__${BRAND.mcpServerName}__${toolName}`;
}

export function brandedInstallerSectionMarkers(sectionName = BRAND.installerSectionName): { start: string; end: string } {
  return {
    start: `<!-- ${sectionName}_START -->`,
    end: `<!-- ${sectionName}_END -->`
  };
}

export function allInstallerSectionMarkers(): Array<{ start: string; end: string }> {
  return [brandedInstallerSectionMarkers()];
}

export function brandedWorkspaceDirNames(): string[] {
  return [BRAND.configDirName];
}

export function generatedDatabaseRecoveryInstruction(): string {
  return `remove the configured Kuzu graph directory or clear/use a fresh ${BRAND.displayName} Neo4j database, then run a full reindex`;
}
