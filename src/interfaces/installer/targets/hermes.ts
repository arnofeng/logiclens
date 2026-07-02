import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  AgentTarget,
  DetectionResult,
  InstallOptions,
  Location,
  WriteResult,
} from './types.js';
import { atomicWriteFileSync } from './shared.js';
import { BRAND } from '../../../shared/branding.js';

const MCP_SERVER_KEY = BRAND.mcpServerName;
const MCP_TOOLSET_NAME = `mcp-${BRAND.mcpServerName}`;
const MCP_SERVER_KEYS = [...new Set([BRAND.mcpServerName, ...BRAND.legacy.mcpServerNames])];
const MCP_TOOLSET_NAMES = [...new Set(MCP_SERVER_KEYS.map((name) => `mcp-${name}`))];

type LineRange = { start: number; end: number };

class HermesTarget implements AgentTarget {
  readonly id = 'hermes' as const;
  readonly displayName = 'Hermes Agent';
  readonly docsUrl = 'https://hermes-agent.nousresearch.com';

  supportsLocation(loc: Location): boolean {
    return loc === 'global';
  }

  detect(loc: Location): DetectionResult {
    if (loc !== 'global') {
      return { installed: false, alreadyConfigured: false };
    }
    const file = configPath();
    const content = readText(file);
    const installed = fs.existsSync(hermesHome()) || fs.existsSync(file);
    return {
      installed,
      alreadyConfigured: hasBrandedMcpServer(content),
      configPath: file,
    };
  }

  install(loc: Location, _opts: InstallOptions): WriteResult {
    if (loc !== 'global') {
      return {
        files: [],
        notes: ['Hermes Agent uses $HERMES_HOME/config.yaml; re-run with --location=global.'],
      };
    }
    return {
      files: [writeHermesConfig()],
      notes: ['Start a new Hermes session for MCP changes to take effect.'],
    };
  }

  uninstall(loc: Location): WriteResult {
    if (loc !== 'global') return { files: [] };
    const file = configPath();
    if (!fs.existsSync(file)) {
      return { files: [{ path: file, action: 'not-found' }] };
    }

    const before = readText(file);
    const after = removeBrandedToolset(removeBrandedMcpServer(before));
    if (after === before) {
      return { files: [{ path: file, action: 'not-found' }] };
    }
    atomicWriteFileSync(file, ensureTrailingNewline(after));
    return { files: [{ path: file, action: 'removed' }] };
  }

  printConfig(loc: Location): string {
    if (loc !== 'global') {
      return '# Hermes Agent uses $HERMES_HOME/config.yaml; use --location=global.\n';
    }
    return [
      `# Add to ${configPath()}`,
      '',
      renderBrandedMcpBlock().join('\n'),
      '',
      'platform_toolsets:',
      '  cli:',
      '    - hermes-cli',
      `    - ${MCP_TOOLSET_NAME}`,
      '',
    ].join('\n');
  }

  describePaths(loc: Location): string[] {
    return loc === 'global' ? [configPath()] : [];
  }
}

function hermesHome(): string {
  return process.env.HERMES_HOME
    ? path.resolve(process.env.HERMES_HOME)
    : path.join(os.homedir(), '.hermes');
}

function configPath(): string {
  return path.join(hermesHome(), 'config.yaml');
}

function readText(file: string): string {
  try {
    return fs.readFileSync(file, 'utf-8');
  } catch {
    return '';
  }
}

function writeHermesConfig(): WriteResult['files'][number] {
  const file = configPath();
  const existed = fs.existsSync(file);
  const before = readText(file);
  const afterMcp = upsertBrandedMcpServer(before);
  const after = upsertBrandedToolset(afterMcp);

  if (after === before) {
    return { path: file, action: 'unchanged' };
  }
  atomicWriteFileSync(file, ensureTrailingNewline(after));
  return { path: file, action: existed ? 'updated' : 'created' };
}

function ensureTrailingNewline(text: string): string {
  return text.endsWith('\n') ? text : text + '\n';
}

function splitLines(content: string): string[] {
  return content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
}

function joinLines(lines: string[]): string {
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n') + '\n';
}

function topLevelRange(lines: string[], key: string): LineRange | null {
  const start = lines.findIndex((line) => line.trim() === `${key}:`);
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.trim() === '') continue;
    if (/^[A-Za-z_][A-Za-z0-9_-]*:\s*(?:#.*)?$/.test(line)) {
      end = i;
      break;
    }
  }
  return { start, end };
}

function childRange(lines: string[], parent: LineRange, child: string): LineRange | null {
  const startPattern = new RegExp(`^  ${escapeRegExp(child)}:\\s*(?:#.*)?$`);
  let start = -1;
  for (let i = parent.start + 1; i < parent.end; i++) {
    if (startPattern.test(lines[i] ?? '')) {
      start = i;
      break;
    }
  }
  if (start === -1) return null;

  let end = parent.end;
  for (let i = start + 1; i < parent.end; i++) {
    const line = lines[i] ?? '';
    if (line.trim() === '') continue;
    if (/^  \S/.test(line)) {
      end = i;
      break;
    }
  }
  while (end > start + 1 && (lines[end - 1] ?? '').trim() === '') {
    end--;
  }
  return { start, end };
}

function listChildBlock(
  lines: string[],
  parent: LineRange,
  child: string,
): (LineRange & { itemIndent: string }) | null {
  const startPattern = new RegExp(`^  ${escapeRegExp(child)}:\\s*(?:#.*)?$`);
  let start = -1;
  for (let i = parent.start + 1; i < parent.end; i++) {
    if (startPattern.test(lines[i] ?? '')) {
      start = i;
      break;
    }
  }
  if (start === -1) return null;

  let end = parent.end;
  for (let i = start + 1; i < parent.end; i++) {
    const line = lines[i] ?? '';
    if (line.trim() === '') continue;
    const indentMatch = line.match(/^( *)/);
    const indent = indentMatch?.[1]?.length ?? 0;
    if (indent >= 4) continue;
    if (indent === 2 && /^  - /.test(line)) continue;
    end = i;
    break;
  }
  while (end > start + 1 && (lines[end - 1] ?? '').trim() === '') {
    end--;
  }

  let itemIndent = '    ';
  for (let i = start + 1; i < end; i++) {
    const m = (lines[i] ?? '').match(/^( +)- /);
    if (m && m[1]) {
      itemIndent = m[1];
      break;
    }
  }
  return { start, end, itemIndent };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function renderBrandedMcpChild(): string[] {
  return [
    `  ${MCP_SERVER_KEY}:`,
    `    command: ${BRAND.cliName}`,
    '    args:',
    '      - mcp',
    '    timeout: 120',
    '    connect_timeout: 60',
    '    enabled: true',
  ];
}

function renderBrandedMcpBlock(): string[] {
  return ['mcp_servers:', ...renderBrandedMcpChild()];
}

function hasBrandedMcpServer(content: string): boolean {
  const lines = splitLines(content);
  const parent = topLevelRange(lines, 'mcp_servers');
  return !!parent && MCP_SERVER_KEYS.some((key) => !!childRange(lines, parent, key));
}

function upsertBrandedMcpServer(content: string): string {
  const lines = splitLines(content);
  const parent = topLevelRange(lines, 'mcp_servers');
  const child = parent ? findMcpServerChild(lines, parent) : null;
  const replacement = renderBrandedMcpChild();

  if (!parent) {
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    if (lines.length > 0) lines.push('');
    lines.push(...renderBrandedMcpBlock());
    return joinLines(lines);
  }

  if (child) {
    const existing = lines.slice(child.start, child.end);
    if (arrayEqual(existing, replacement)) return joinLines(lines);
    lines.splice(child.start, child.end - child.start, ...replacement);
    return joinLines(lines);
  }

  lines.splice(parent.end, 0, ...replacement);
  return joinLines(lines);
}

function removeBrandedMcpServer(content: string): string {
  const lines = splitLines(content);
  const parent = topLevelRange(lines, 'mcp_servers');
  if (!parent) return content;
  for (const key of [...MCP_SERVER_KEYS].reverse()) {
    const child = childRange(lines, parent, key);
    if (child) lines.splice(child.start, child.end - child.start);
  }
  return joinLines(lines);
}

function upsertBrandedToolset(content: string): string {
  const lines = splitLines(content);
  const parent = topLevelRange(lines, 'platform_toolsets');
  const cli = parent ? listChildBlock(lines, parent, 'cli') : null;

  if (!parent) {
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    if (lines.length > 0) lines.push('');
    lines.push('platform_toolsets:', '  cli:', '    - hermes-cli', `    - ${MCP_TOOLSET_NAME}`);
    return joinLines(lines);
  }

  if (!cli) {
    lines.splice(parent.end, 0, '  cli:', '    - hermes-cli', `    - ${MCP_TOOLSET_NAME}`);
    return joinLines(lines);
  }

  const hasEntry = lines
    .slice(cli.start + 1, cli.end)
    .some((line) => MCP_TOOLSET_NAMES.some((name) => line.trim() === `- ${name}`));
  if (hasEntry) return joinLines(lines);

  lines.splice(cli.end, 0, `${cli.itemIndent}- ${MCP_TOOLSET_NAME}`);
  return joinLines(lines);
}

function removeBrandedToolset(content: string): string {
  const lines = splitLines(content);
  const parent = topLevelRange(lines, 'platform_toolsets');
  const cli = parent ? listChildBlock(lines, parent, 'cli') : null;
  if (!cli) return content;

  const hasEntry = lines
    .slice(cli.start + 1, cli.end)
    .some((line) => MCP_TOOLSET_NAMES.some((name) => line.trim() === `- ${name}`));
  if (!hasEntry) return content;

  const next = lines.filter((line, idx) => {
    if (idx <= cli.start || idx >= cli.end) return true;
    return !MCP_TOOLSET_NAMES.some((name) => line.trim() === `- ${name}`);
  });
  return joinLines(next);
}

function findMcpServerChild(lines: string[], parent: LineRange): LineRange | null {
  for (const key of MCP_SERVER_KEYS) {
    const child = childRange(lines, parent, key);
    if (child) return child;
  }
  return null;
}

function arrayEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, idx) => value === b[idx]);
}

export const hermesTarget: AgentTarget = new HermesTarget();
