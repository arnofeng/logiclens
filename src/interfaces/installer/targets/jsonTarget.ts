import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';
import {
  AgentTarget,
  DetectionResult,
  InstallOptions,
  Location,
  WriteResult,
  TargetId,
} from './types.js';
import {
  getLogicLensPermissions,
  getMcpServerConfig,
  jsonDeepEqual,
  readJsonFile,
  removeMarkedSection,
  writeJsonFile,
  upsertInstructionsEntry,
} from './shared.js';
import {
  LOGICLENS_SECTION_END,
  LOGICLENS_SECTION_START,
} from '../instructions-template.js';

export interface JsonTargetOptions {
  id: TargetId;
  displayName: string;
  docsUrl: string;
  configPathFn: (loc: Location) => string;
  detectInstallDirFn?: (loc: Location) => string;
  buildEntryFn?: (loc: Location) => any;
  instructionsPathFn?: (loc: Location) => string;
  permissionsPathFn?: (loc: Location) => string;
  permissionsItems?: string[];
  supportsLocationFn?: (loc: Location) => boolean;
  extraInstallFn?: (loc: Location) => WriteResult['files'];
  extraUninstallFn?: (loc: Location) => WriteResult['files'];
  notes?: string[];
}

export class BaseJsonTarget implements AgentTarget {
  readonly id: TargetId;
  readonly displayName: string;
  readonly docsUrl: string;
  private readonly configPathFn: (loc: Location) => string;
  private readonly detectInstallDirFn?: (loc: Location) => string;
  private readonly buildEntryFn?: (loc: Location) => any;
  private readonly instructionsPathFn?: (loc: Location) => string;
  private readonly permissionsPathFn?: (loc: Location) => string;
  private readonly permissionsItems?: string[];
  private readonly supportsLocationFn?: (loc: Location) => boolean;
  private readonly extraInstallFn?: (loc: Location) => WriteResult['files'];
  private readonly extraUninstallFn?: (loc: Location) => WriteResult['files'];
  private readonly targetNotes?: string[];

  constructor(opts: JsonTargetOptions) {
    this.id = opts.id;
    this.displayName = opts.displayName;
    this.docsUrl = opts.docsUrl;
    this.configPathFn = opts.configPathFn;
    this.detectInstallDirFn = opts.detectInstallDirFn;
    this.buildEntryFn = opts.buildEntryFn;
    this.instructionsPathFn = opts.instructionsPathFn;
    this.permissionsPathFn = opts.permissionsPathFn;
    this.permissionsItems = opts.permissionsItems;
    this.supportsLocationFn = opts.supportsLocationFn;
    this.extraInstallFn = opts.extraInstallFn;
    this.extraUninstallFn = opts.extraUninstallFn;
    this.targetNotes = opts.notes;
  }

  supportsLocation(loc: Location): boolean {
    if (this.supportsLocationFn) return this.supportsLocationFn(loc);
    return true;
  }

  detect(loc: Location): DetectionResult {
    if (!this.supportsLocation(loc)) {
      return { installed: false, alreadyConfigured: false };
    }
    const mcpPath = this.configPathFn(loc);
    const config = readJsonFile(mcpPath);
    const alreadyConfigured = !!config.mcpServers?.logiclens;

    const dir = this.detectInstallDirFn ? this.detectInstallDirFn(loc) : path.dirname(mcpPath);
    const installed = fs.existsSync(dir) || fs.existsSync(mcpPath);

    return { installed, alreadyConfigured, configPath: mcpPath };
  }

  install(loc: Location, opts: InstallOptions): WriteResult {
    if (!this.supportsLocation(loc)) {
      return {
        files: [],
        notes: [`${this.displayName} has no ${loc} config concept.`],
      };
    }
    const files: WriteResult['files'] = [];

    // 1. MCP config write
    files.push(this.writeMcpEntry(loc));

    // 2. Permissions write
    if (opts.autoAllow && this.permissionsPathFn && this.permissionsItems) {
      files.push(this.writePermissionsEntry(loc));
    }

    // 3. Instructions write
    if (this.instructionsPathFn) {
      files.push(upsertInstructionsEntry(this.instructionsPathFn(loc)));
    }

    // 4. Extra actions
    if (this.extraInstallFn) {
      files.push(...this.extraInstallFn(loc));
    }

    return {
      files,
      notes: this.targetNotes,
    };
  }

  uninstall(loc: Location): WriteResult {
    if (!this.supportsLocation(loc)) return { files: [] };
    const files: WriteResult['files'] = [];

    // 1. MCP config removal
    const mcpPath = this.configPathFn(loc);
    if (fs.existsSync(mcpPath)) {
      const config = readJsonFile(mcpPath);
      if (config.mcpServers?.logiclens) {
        delete config.mcpServers.logiclens;
        if (Object.keys(config.mcpServers).length === 0) {
          delete config.mcpServers;
        }
        writeJsonFile(mcpPath, config);
        files.push({ path: mcpPath, action: 'removed' });
      } else {
        files.push({ path: mcpPath, action: 'not-found' });
      }
    } else {
      files.push({ path: mcpPath, action: 'not-found' });
    }

    // 2. Permissions removal
    if (this.permissionsPathFn && this.permissionsItems) {
      files.push(this.removePermissionsEntry(loc));
    }

    // 3. Instructions removal
    if (this.instructionsPathFn) {
      const file = this.instructionsPathFn(loc);
      const action = removeMarkedSection(file, LOGICLENS_SECTION_START, LOGICLENS_SECTION_END);
      files.push({ path: file, action });
    }

    // 4. Extra actions
    if (this.extraUninstallFn) {
      files.push(...this.extraUninstallFn(loc));
    }

    return { files };
  }

  printConfig(loc: Location): string {
    if (!this.supportsLocation(loc)) {
      return `# ${this.displayName} has no ${loc} config concept.\n`;
    }
    const target = this.configPathFn(loc);
    const after = this.buildEntryFn ? this.buildEntryFn(loc) : getMcpServerConfig();
    const snippet = JSON.stringify({ mcpServers: { logiclens: after } }, null, 2);
    return `# Add to ${target}\n\n${snippet}\n`;
  }

  describePaths(loc: Location): string[] {
    if (!this.supportsLocation(loc)) return [];
    const paths = [this.configPathFn(loc)];
    if (this.permissionsPathFn) paths.push(this.permissionsPathFn(loc));
    if (this.instructionsPathFn) paths.push(this.instructionsPathFn(loc));
    return paths;
  }

  private writeMcpEntry(loc: Location): WriteResult['files'][number] {
    const file = this.configPathFn(loc);
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const existing = readJsonFile(file);
    const before = existing.mcpServers?.logiclens;
    const after = this.buildEntryFn ? this.buildEntryFn(loc) : getMcpServerConfig();

    if (jsonDeepEqual(before, after)) {
      return { path: file, action: 'unchanged' };
    }
    const action: 'created' | 'updated' =
      before ? 'updated' : (fs.existsSync(file) ? 'updated' : 'created');
    if (!existing.mcpServers) existing.mcpServers = {};
    existing.mcpServers.logiclens = after;
    writeJsonFile(file, existing);
    return { path: file, action };
  }

  private writePermissionsEntry(loc: Location): WriteResult['files'][number] {
    const file = this.permissionsPathFn!(loc);
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const existing = readJsonFile(file);
    const before = existing.permissions?.allow;
    const afterItems = this.permissionsItems!;

    const currentAllow: string[] = Array.isArray(before) ? before : [];
    const merged = Array.from(new Set([...currentAllow, ...afterItems])).sort();

    if (jsonDeepEqual(before, merged)) {
      return { path: file, action: 'unchanged' };
    }
    const action: 'created' | 'updated' =
      before ? 'updated' : (fs.existsSync(file) ? 'updated' : 'created');
    if (!existing.permissions) existing.permissions = {};
    existing.permissions.allow = merged;
    writeJsonFile(file, existing);
    return { path: file, action };
  }

  private removePermissionsEntry(loc: Location): WriteResult['files'][number] {
    const file = this.permissionsPathFn!(loc);
    if (!fs.existsSync(file)) return { path: file, action: 'not-found' };

    const config = readJsonFile(file);
    const before = config.permissions?.allow;
    if (!Array.isArray(before)) return { path: file, action: 'not-found' };

    const targets = this.permissionsItems!;
    const nextAllow = before.filter((p: string) => !targets.includes(p));

    if (jsonDeepEqual(before, nextAllow)) {
      return { path: file, action: 'not-found' };
    }

    if (nextAllow.length === 0) {
      delete config.permissions.allow;
      if (Object.keys(config.permissions).length === 0) {
        delete config.permissions;
      }
    } else {
      config.permissions.allow = nextAllow;
    }

    writeJsonFile(file, config);
    return { path: file, action: 'removed' };
  }
}

// 1. Claude Target
export const claudeTarget = new BaseJsonTarget({
  id: 'claude',
  displayName: 'Claude Code',
  docsUrl: 'https://docs.claude.com/en/docs/claude-code',
  configPathFn: (loc) => loc === 'global'
    ? path.join(os.homedir(), '.claude.json')
    : path.join(process.cwd(), '.mcp.json'),
  detectInstallDirFn: (loc) => loc === 'global'
    ? path.join(os.homedir(), '.claude')
    : path.join(process.cwd(), '.claude'),
  instructionsPathFn: (loc) => path.join(loc === 'global' ? path.join(os.homedir(), '.claude') : path.join(process.cwd(), '.claude'), 'CLAUDE.md'),
  permissionsPathFn: (loc) => path.join(loc === 'global' ? path.join(os.homedir(), '.claude') : path.join(process.cwd(), '.claude'), 'settings.json'),
  permissionsItems: getLogicLensPermissions(),
});

// 2. Cursor Target
export const cursorTarget = new BaseJsonTarget({
  id: 'cursor',
  displayName: 'Cursor',
  docsUrl: 'https://docs.cursor.com/context/model-context-protocol',
  configPathFn: (loc) => loc === 'global'
    ? path.join(os.homedir(), '.cursor', 'mcp.json')
    : path.join(process.cwd(), '.cursor', 'mcp.json'),
  detectInstallDirFn: (loc) => loc === 'global'
    ? path.join(os.homedir(), '.cursor')
    : path.join(process.cwd(), '.cursor'),
  buildEntryFn: (loc) => {
    const base = getMcpServerConfig();
    const pathArg = loc === 'local' ? process.cwd() : '${workspaceFolder}';
    return { ...base, args: [...base.args, '--path', pathArg] };
  },
  notes: ['Restart Cursor for MCP changes to take effect.'],
});

// 3. Gemini Target
export const geminiTarget = new BaseJsonTarget({
  id: 'gemini',
  displayName: 'Gemini CLI',
  docsUrl: 'https://geminicli.com/docs/tools/mcp-server/',
  configPathFn: (loc) => path.join(loc === 'global' ? path.join(os.homedir(), '.gemini') : path.join(process.cwd(), '.gemini'), 'settings.json'),
  detectInstallDirFn: (loc) => loc === 'global'
    ? path.join(os.homedir(), '.gemini')
    : path.join(process.cwd(), '.gemini'),
  instructionsPathFn: (loc) => loc === 'global'
    ? path.join(os.homedir(), '.gemini', 'GEMINI.md')
    : path.join(process.cwd(), 'GEMINI.md'),
});

// 4. Antigravity Target Helper Functions
function unifiedConfigDir(): string { return path.join(os.homedir(), '.gemini', 'config'); }
function unifiedMcpConfigPath(): string { return path.join(unifiedConfigDir(), 'mcp_config.json'); }
function legacyConfigDir(): string { return path.join(os.homedir(), '.gemini', 'antigravity'); }
function legacyMcpConfigPath(): string { return path.join(legacyConfigDir(), 'mcp_config.json'); }
function migratedMarkerPath(): string { return path.join(unifiedConfigDir(), '.migrated'); }

function preferredMcpConfigPath(): string {
  if (fs.existsSync(migratedMarkerPath())) return unifiedMcpConfigPath();
  if (fs.existsSync(unifiedMcpConfigPath())) return unifiedMcpConfigPath();
  return legacyMcpConfigPath();
}

function resolveLogicLensCommand(): string {
  if (process.platform !== 'darwin') return 'logiclens';
  try {
    const resolved = execSync('command -v logiclens || which logiclens', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: '/bin/bash',
      windowsHide: true,
    }).trim();
    if (resolved && fs.existsSync(resolved)) return resolved;
  } catch { /* ignore */ }
  return 'logiclens';
}

function cleanupLegacyAntigravityEntry(): WriteResult['files'][number] | null {
  if (preferredMcpConfigPath() !== unifiedMcpConfigPath()) return null;
  const legacy = legacyMcpConfigPath();
  if (!fs.existsSync(legacy)) return null;
  const config = readJsonFile(legacy);
  if (!config.mcpServers?.logiclens) return null;
  delete config.mcpServers.logiclens;
  if (Object.keys(config.mcpServers).length === 0) {
    delete config.mcpServers;
  }
  writeJsonFile(legacy, config);
  return { path: legacy, action: 'removed' };
}

function removeLegacyAntigravityFromFile(file: string): WriteResult['files'][number] {
  if (!fs.existsSync(file)) return { path: file, action: 'not-found' };
  const config = readJsonFile(file);
  if (!config.mcpServers?.logiclens) return { path: file, action: 'not-found' };
  delete config.mcpServers.logiclens;
  if (Object.keys(config.mcpServers).length === 0) {
    delete config.mcpServers;
  }
  writeJsonFile(file, config);
  return { path: file, action: 'removed' };
}

export const antigravityTarget = new BaseJsonTarget({
  id: 'antigravity',
  displayName: 'Antigravity IDE',
  docsUrl: 'https://antigravity.google',
  supportsLocationFn: (loc) => loc === 'global',
  configPathFn: () => preferredMcpConfigPath(),
  detectInstallDirFn: () => unifiedConfigDir(),
  buildEntryFn: () => ({
    command: resolveLogicLensCommand(),
    args: ['mcp'],
  }),
  extraInstallFn: () => {
    const legacyCleanup = cleanupLegacyAntigravityEntry();
    return legacyCleanup ? [legacyCleanup] : [];
  },
  extraUninstallFn: () => {
    const files: WriteResult['files'] = [];
    const preferred = preferredMcpConfigPath();
    const other = preferred === unifiedMcpConfigPath() ? legacyMcpConfigPath() : unifiedMcpConfigPath();
    const otherResult = removeLegacyAntigravityFromFile(other);
    if (otherResult.action === 'removed') files.push(otherResult);
    return files;
  },
  notes: ['Restart Antigravity for MCP changes to take effect.'],
});

// 5. Kiro Target Helper Functions
function kiroSteeringPath(loc: Location): string {
  const base = loc === 'global' ? path.join(os.homedir(), '.kiro') : path.join(process.cwd(), '.kiro');
  return path.join(base, 'steering', 'logiclens.md');
}

export const kiroTarget = new BaseJsonTarget({
  id: 'kiro',
  displayName: 'Kiro',
  docsUrl: 'https://kiro.dev/docs/cli/mcp/',
  configPathFn: (loc) => path.join(loc === 'global' ? path.join(os.homedir(), '.kiro') : path.join(process.cwd(), '.kiro'), 'settings', 'mcp.json'),
  detectInstallDirFn: (loc) => loc === 'global' ? path.join(os.homedir(), '.kiro') : path.join(process.cwd(), '.kiro'),
  extraInstallFn: (loc) => {
    const file = kiroSteeringPath(loc);
    if (fs.existsSync(file)) {
      try { fs.unlinkSync(file); } catch { /* ignore */ }
      return [{ path: file, action: 'removed' as const }];
    }
    return [];
  },
  extraUninstallFn: (loc) => {
    const file = kiroSteeringPath(loc);
    if (fs.existsSync(file)) {
      try { fs.unlinkSync(file); } catch { /* ignore */ }
      return [{ path: file, action: 'removed' as const }];
    }
    return [];
  },
  notes: [
    'Restart Kiro for MCP changes to take effect.',
    'Kiro IDE: also enable MCP in Settings (search "MCP" → "Enabled"). Kiro CLI users can skip this step.',
  ],
});
