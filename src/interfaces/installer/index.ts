/**
 * LogicLens MCP Installer & Uninstaller
 *
 * Interactive / non-interactive installer that configures LogicLens as an MCP server
 * across multiple AI agents (Claude Code, Cursor, Codex, Gemini, Antigravity, etc.).
 *
 * Inspired by / adapted from the Colby McHenry CodeGraph target configuration installer.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  ALL_TARGETS,
  detectAll,
  getTarget,
  resolveTargetFlag,
} from './targets/registry.js';
import type { AgentTarget, Location, TargetId } from './targets/types.js';

function getVersion(): string {
  try {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const packageJsonPath = path.join(__dirname, '..', '..', 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
    return packageJson.version;
  } catch {
    return '0.0.0';
  }
}

export interface RunInstallerOptions {
  target?: string;
  location?: Location;
  autoAllow?: boolean;
  yes?: boolean;
}

export async function runInstaller(): Promise<void> {
  return runInstallerWithOptions({});
}

export async function runInstallerWithOptions(opts: RunInstallerOptions): Promise<void> {
  const clack = await import('@clack/prompts');

  clack.intro(`LogicLens MCP Installer v${getVersion()}`);

  const useDefaults = opts.yes === true;

  const detectionLocation: Location = opts.location ?? 'global';
  const targets = await resolveTargets(clack, opts, detectionLocation, useDefaults);
  if (targets.length === 0) {
    clack.outro('No agent targets selected — nothing to do.');
    return;
  }

  let location: Location;
  if (opts.location) {
    location = opts.location;
  } else if (useDefaults) {
    location = 'global';
  } else {
    const allGlobalOnly = targets.every((t) => !t.supportsLocation('local'));
    if (allGlobalOnly) {
      location = 'global';
      clack.log.info('Writing user-wide configs (selected agents have no project-local config).');
    } else {
      const sel = await clack.select({
        message: 'Apply agent configs to all your projects, or just this one?',
        options: [
          { value: 'global' as const, label: 'All projects (global)', hint: '~/.claude.json, ~/.cursor/mcp.json, etc.' },
          { value: 'local'  as const, label: 'Just this project (local)', hint: './.mcp.json, ./.cursor/mcp.json, etc.' },
        ],
        initialValue: 'global' as const,
      });
      if (clack.isCancel(sel)) {
        clack.cancel('Installation cancelled.');
        process.exit(0);
      }
      location = sel as Location;
    }
  }

  let autoAllow: boolean;
  if (opts.autoAllow !== undefined) {
    autoAllow = opts.autoAllow;
  } else if (useDefaults) {
    autoAllow = true;
  } else if (targets.some((t) => t.id === 'claude')) {
    const ans = await clack.confirm({
      message: 'Auto-allow LogicLens commands? (Skips permission prompts in Claude Code)',
      initialValue: true,
    });
    if (clack.isCancel(ans)) {
      clack.cancel('Installation cancelled.');
      process.exit(0);
    }
    autoAllow = ans;
  } else {
    autoAllow = false;
  }

  const installedIds: TargetId[] = [];
  for (const target of targets) {
    if (!target.supportsLocation(location)) {
      clack.log.warn(
        `${target.displayName}: skipped — does not support --location=${location}.`,
      );
      continue;
    }
    const result = target.install(location, { autoAllow });
    installedIds.push(target.id);
    for (const file of result.files) {
      const verb = file.action === 'unchanged'
        ? 'Unchanged'
        : file.action === 'created' ? 'Created'
          : file.action === 'removed' ? 'Removed'
            : 'Updated';
      clack.log.success(`${target.displayName}: ${verb} ${tildify(file.path)}`);
    }
    for (const note of result.notes ?? []) {
      clack.log.info(`${target.displayName}: ${note}`);
    }
  }

  if (location === 'local') {
    const configExists = fs.existsSync(path.join(process.cwd(), '.logiclens', 'config.yaml'));
    if (!configExists) {
      clack.log.info('This project is not yet initialized with LogicLens.');
      const shouldInit = await clack.confirm({
        message: 'Initialize LogicLens config in this project now?',
        initialValue: true,
      });
      if (clack.isCancel(shouldInit)) {
        clack.cancel('Installation cancelled.');
        process.exit(0);
      }
      if (shouldInit) {
        const { initCommand } = await import('../cli/init.js');
        await initCommand();
        clack.log.success('Initialized .logiclens/config.yaml');
      }
    }
    clack.note('To index your project repositories, run:\nlogiclens index', 'Next Step');
  }

  const finalNote = targets.length > 0
    ? `Done! Restart your agent${targets.length > 1 ? 's' : ''} to use LogicLens.`
    : 'Done!';
  clack.outro(finalNote);
}

export interface RunUninstallerOptions {
  target?: string;
  location?: Location;
  yes?: boolean;
}

export type UninstallStatus = 'removed' | 'not-configured' | 'unsupported';

export interface UninstallReport {
  id: TargetId;
  displayName: string;
  status: UninstallStatus;
  removedPaths: string[];
  notes: string[];
}

export function uninstallTargets(
  targets: readonly AgentTarget[],
  location: Location,
): UninstallReport[] {
  return targets.map((target) => {
    if (!target.supportsLocation(location)) {
      const only: Location = location === 'local' ? 'global' : 'local';
      return {
        id: target.id,
        displayName: target.displayName,
        status: 'unsupported' as const,
        removedPaths: [],
        notes: [`no ${location} config — this agent is ${only}-only`],
      };
    }
    const result = target.uninstall(location);
    const removedPaths = result.files
      .filter((f) => f.action === 'removed')
      .map((f) => f.path);
    return {
      id: target.id,
      displayName: target.displayName,
      status: removedPaths.length > 0 ? ('removed' as const) : ('not-configured' as const),
      removedPaths,
      notes: result.notes ?? [],
    };
  });
}

export async function runUninstaller(opts: RunUninstallerOptions): Promise<void> {
  const clack = await import('@clack/prompts');

  clack.intro(`LogicLens MCP Uninstaller v${getVersion()}`);

  const useDefaults = opts.yes === true;

  let location: Location;
  if (opts.location) {
    location = opts.location;
  } else if (useDefaults) {
    location = 'global';
  } else {
    const sel = await clack.select({
      message: 'Remove LogicLens from all your projects, or just this one?',
      options: [
        { value: 'global' as const, label: 'All projects (global)', hint: '~/.claude.json, ~/.cursor/mcp.json, etc.' },
        { value: 'local'  as const, label: 'Just this project (local)', hint: './.mcp.json, ./.cursor/mcp.json, etc.' },
      ],
      initialValue: 'global' as const,
    });
    if (clack.isCancel(sel)) {
      clack.cancel('Uninstall cancelled.');
      process.exit(0);
    }
    location = sel as Location;
  }

  let targets: AgentTarget[];
  if (opts.target !== undefined) {
    targets = resolveTargetFlag(opts.target, location);
  } else {
    targets = [...ALL_TARGETS];
  }
  if (targets.length === 0) {
    clack.outro('No agent targets selected — nothing to do.');
    return;
  }

  const reports = uninstallTargets(targets, location);
  const removed = reports.filter((r) => r.status === 'removed');

  for (const r of reports) {
    if (r.status === 'removed') {
      for (const p of r.removedPaths) {
        clack.log.success(`${r.displayName}: removed ${tildify(p)}`);
      }
    } else if (r.status === 'not-configured') {
      clack.log.info(`${r.displayName}: not configured — nothing to remove`);
    } else {
      clack.log.info(`${r.displayName}: skipped — ${r.notes[0] ?? 'unsupported location'}`);
    }
  }

  if (location === 'local' && fs.existsSync(path.join(process.cwd(), '.logiclens'))) {
    clack.log.info(`The .logiclens/ index for this project is still here. Run \`logiclens uninit\` to delete it.`);
  }

  if (removed.length > 0) {
    const names = removed.map((r) => r.displayName).join(', ');
    clack.outro(
      `Removed LogicLens from ${removed.length} agent${removed.length > 1 ? 's' : ''}: ${names}. ` +
      `Restart ${removed.length > 1 ? 'them' : 'it'} to apply.`,
    );
  } else {
    clack.outro(`LogicLens was not configured in any ${location} agent — nothing to remove.`);
  }
}

function tildify(p: string): string {
  const home = os.homedir();
  if (p.startsWith(home + path.sep)) return '~' + p.substring(home.length);
  return p;
}

async function resolveTargets(
  clack: any,
  opts: RunInstallerOptions,
  location: Location,
  useDefaults: boolean,
): Promise<AgentTarget[]> {
  if (opts.target !== undefined) {
    return resolveTargetFlag(opts.target, location);
  }

  if (useDefaults) {
    return resolveTargetFlag('auto', location);
  }

  const detected = detectAll(location);
  const initialValues = detected
    .filter(({ detection }) => detection.installed)
    .map(({ target }) => target.id);
  const initial = initialValues.length > 0 ? initialValues : ['claude'];

  const choice = await clack.multiselect({
    message: 'Which agents should LogicLens configure?',
    options: ALL_TARGETS.map((t) => {
      const det = detected.find(({ target }) => target.id === t.id)!.detection;
      const flag = det.installed ? '(detected)' : '(not found)';
      const globalOnly = !t.supportsLocation('local') ? ' — global only' : '';
      return {
        value: t.id,
        label: `${t.displayName} ${flag}${globalOnly}`,
      };
    }),
    initialValues: initial,
    required: false,
  });

  if (clack.isCancel(choice)) {
    clack.cancel('Installation cancelled.');
    process.exit(0);
  }

  return (choice as string[])
    .map((id) => getTarget(id))
    .filter((t): t is AgentTarget => t !== undefined);
}
