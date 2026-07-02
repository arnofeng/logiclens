import path from "node:path";

export const BRAND = {
  displayName: "LogicLens",
  cliName: "logiclens",
  packageName: "logiclens",
  docsCommandName: "logiclens",
  tempDirPrefix: "logiclens",
  configDirName: ".logiclens",
  configFileName: "config.yaml",
  envPrefix: "LOGICLENS_",
  mcpServerName: "logiclens",
  mcpToolPrefix: "logiclens",
  installerSectionName: "LOGICLENS",
  legacy: {
    configDirNames: [".logiclens"],
    envPrefixes: ["LOGICLENS_"],
    cliNames: ["logiclens"],
    mcpServerNames: ["logiclens"],
    mcpToolPrefixes: ["logiclens"],
    installerSectionNames: ["LOGICLENS"]
  }
} as const;

export const BRAND_PATHS = {
  graph: `${BRAND.configDirName}/graph`,
  semanticIndex: `${BRAND.configDirName}/semantic-index.json`,
  logs: `${BRAND.configDirName}/logs`,
  mcpPid: `${BRAND.configDirName}/mcp.pid`,
  batchStaging: `${BRAND.configDirName}/tmp/batches`
} as const;

export const BRAND_DEFAULTS = {
  chromaCollection: BRAND.cliName,
  mcpProcessName: `${BRAND.cliName}-mcp-server`
} as const;

export function brandedPath(cwd: string, relativePath: string): string {
  return path.resolve(cwd, relativePath);
}

export function configFilePath(cwd: string): string {
  return path.join(cwd, BRAND.configDirName, BRAND.configFileName);
}

export function legacyConfigFilePaths(cwd: string): string[] {
  return BRAND.legacy.configDirNames
    .filter((dir) => dir !== BRAND.configDirName)
    .map((dir) => path.join(cwd, dir, BRAND.configFileName));
}

export function configFileCandidates(cwd: string): string[] {
  return [configFilePath(cwd), ...legacyConfigFilePaths(cwd)];
}

export function brandedConfigDirPaths(cwd: string): string[] {
  return [...new Set([BRAND.configDirName, ...BRAND.legacy.configDirNames])]
    .map((dir) => path.join(cwd, dir));
}

export function brandedTempDirPrefix(name: string): string {
  return `${BRAND.tempDirPrefix}-${name}-`;
}

export function getBrandedEnv(key: string): string | undefined {
  const brandedKey = `${BRAND.envPrefix}${key}`;
  const value = process.env[brandedKey];
  if (value !== undefined) return value;

  for (const prefix of BRAND.legacy.envPrefixes) {
    if (prefix === BRAND.envPrefix) continue;
    const legacyValue = process.env[`${prefix}${key}`];
    if (legacyValue !== undefined) return legacyValue;
  }

  return undefined;
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

export function legacyInstallerSectionMarkers(): Array<{ start: string; end: string }> {
  return BRAND.legacy.installerSectionNames
    .filter((sectionName) => sectionName !== BRAND.installerSectionName)
    .map((sectionName) => brandedInstallerSectionMarkers(sectionName));
}

export function allInstallerSectionMarkers(): Array<{ start: string; end: string }> {
  return [
    brandedInstallerSectionMarkers(),
    ...legacyInstallerSectionMarkers()
  ];
}

export function brandedWorkspaceDirNames(): string[] {
  return [...new Set([BRAND.configDirName, ...BRAND.legacy.configDirNames])];
}
