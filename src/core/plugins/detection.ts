import path from "node:path";
import fs from "node:fs/promises";
import fg from "fast-glob";
import ignore from "ignore";
import type { AppConfig } from "../../config/schema.js";
import { BRAND } from "../../shared/branding.js";
import { toPosixPath } from "../../shared/path.js";
import { isGeneratedFile } from "../../shared/generatedFile.js";

export type DetectLanguageRule = {
  id: string;
  extensions: string[];
  requiresLanguages?: string[];
  detect?: {
    extensions?: string[];
    markers?: string[];
    globs?: string[];
  };
};

export type DetectPluginManifest = {
  name: string;
  version: string;
  capabilities: string[];
  entry?: string;
  languages?: DetectLanguageRule[];
  [key: string]: unknown;
};

export type PluginSourceKind = "project" | "global" | "bundled" | "legacy";

export type AvailablePlugin = {
  manifest: DetectPluginManifest;
  source: string;
  sourceKind: PluginSourceKind;
  baseDir?: string;
  entryPath?: string;
  ownerRepoPath?: string;
};

export type RepoPathSnapshot = {
  repoPath: string;
  paths: string[];
};

export type LanguageDetection = {
  language: string;
  hasSourceFiles: boolean;
  hasBuildMarkers: boolean;
  hasDubboXml: boolean;
  dubboXmlFiles: Array<{ repoPath: string; relativePath: string }>;
};

const DUBBO_XML_MAX_BYTES = 512 * 1024;

export const builtinLanguagePluginManifests: AvailablePlugin[] = [
  languageManifest("typescript", [".ts"], ["tsconfig.json"]),
  languageManifest("tsx", [".tsx"], ["tsconfig.json"]),
  languageManifest("javascript", [".js"], ["package.json"]),
  languageManifest("jsx", [".jsx"], ["package.json"]),
  languageManifest("java", [".java"], ["pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts", "gradlew"]),
  languageManifest("go", [".go"], ["go.mod"]),
  languageManifest("python", [".py"], ["pyproject.toml", "requirements.txt", "setup.py"]),
  languageManifest("vue", [".vue"], ["package.json"], ["javascript", "jsx", "typescript", "tsx"])
];

function languageManifest(id: string, extensions: string[], markers: string[], requiresLanguages: string[] = []): AvailablePlugin {
  const language: DetectLanguageRule = {
    id,
    extensions,
    requiresLanguages,
    detect: { extensions, markers }
  };
  return {
    manifest: {
      name: id,
      version: "0.0.0-bundled",
      ["logic" + "lensPluginApiVersion"]: "0.1.0",
      capabilities: ["language"],
      languages: [language]
    } as DetectPluginManifest,
    source: `bundled:${id}`,
    sourceKind: "bundled"
  };
}

export async function scanRepoPathSnapshot(
  repoPath: string,
  config: AppConfig,
  detectionGlobs: readonly string[] = config.include
): Promise<RepoPathSnapshot> {
  const ig = ignore();
  ig.add(config.exclude.map((entry) => entry.replace(/^\*\*\//, "")));
  const gitignore = path.join(repoPath, ".gitignore");
  try {
    ig.add(await fs.readFile(gitignore, "utf8"));
  } catch {
    // Missing .gitignore is fine.
  }

  const entries = await fg([...detectionGlobs], {
    cwd: repoPath,
    absolute: false,
    onlyFiles: true,
    dot: true,
    ignore: config.exclude
  });
  const paths = entries
    .map(toPosixPath)
    .sort()
    .filter((relativePath) => !ig.ignores(relativePath))
    .filter((relativePath) => !isGeneratedFile(relativePath));
  return { repoPath, paths };
}

export function detectActiveLanguages(input: {
  plugins: readonly AvailablePlugin[];
  snapshots: readonly RepoPathSnapshot[];
}): Set<string> {
  const active = new Set<string>();
  const languageById = new Map<string, DetectLanguageRule>();
  for (const plugin of input.plugins) {
    for (const language of plugin.manifest.languages ?? []) {
      languageById.set(language.id, language);
      if (matchesLanguage(language, input.snapshots)) {
        active.add(language.id);
      }
    }
  }

  const queue = [...active];
  while (queue.length > 0) {
    const id = queue.shift()!;
    const language = languageById.get(id);
    for (const required of language?.requiresLanguages ?? []) {
      if (!active.has(required)) {
        active.add(required);
        queue.push(required);
      }
    }
  }
  return active;
}

export function pluginsForActiveLanguages(
  plugins: readonly AvailablePlugin[],
  activeLanguages: ReadonlySet<string>
): AvailablePlugin[] {
  return plugins.filter((plugin) =>
    (plugin.manifest.languages ?? []).some((language) => activeLanguages.has(language.id))
  );
}

export function detectionGlobsForPlugins(
  plugins: readonly AvailablePlugin[],
  baseGlobs: readonly string[] = []
): string[] {
  const globs = new Set(baseGlobs);
  for (const plugin of plugins) {
    for (const language of plugin.manifest.languages ?? []) {
      const detect = language.detect ?? { extensions: language.extensions };
      for (const extension of detect.extensions ?? []) {
        globs.add(`**/*${normalizeExtension(extension)}`);
      }
      for (const marker of detect.markers ?? []) {
        globs.add(marker);
        globs.add(`*/${marker}`);
        globs.add(`*/*/${marker}`);
        globs.add(`*/*/*/${marker}`);
      }
      for (const glob of detect.globs ?? []) globs.add(glob);
    }
  }
  return [...globs].sort();
}

export function pluginsAvailableToRepo(
  plugins: readonly AvailablePlugin[],
  repoPath: string
): AvailablePlugin[] {
  const resolvedRepoPath = path.resolve(repoPath);
  return plugins.filter((plugin) =>
    plugin.sourceKind !== "project" ||
    (plugin.ownerRepoPath !== undefined && path.resolve(plugin.ownerRepoPath) === resolvedRepoPath)
  );
}

export function sourceGlobsForActiveLanguages(
  plugins: readonly AvailablePlugin[],
  activeLanguages: ReadonlySet<string>
): string[] {
  const globs = new Set<string>();
  for (const plugin of plugins) {
    if (plugin.sourceKind === "bundled") continue;
    for (const language of plugin.manifest.languages ?? []) {
      if (!activeLanguages.has(language.id)) continue;
      const extensions = new Set(language.extensions.map(normalizeExtension));
      for (const extension of extensions) globs.add(`**/*${extension}`);
      for (const glob of language.detect?.globs ?? []) {
        if (isSafeSourceGlob(glob) && [...extensions].some((extension) => globTargetsExtension(glob, extension))) {
          globs.add(glob);
        }
      }
    }
  }
  return [...globs].sort();
}

export async function detectJavaSignals(snapshots: readonly RepoPathSnapshot[]): Promise<LanguageDetection> {
  let hasSourceFiles = false;
  let hasBuildMarkers = false;
  let hasDubboXml = false;
  const dubboXmlFiles: Array<{ repoPath: string; relativePath: string }> = [];
  const buildMarkers = new Set(["pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts", "gradlew"]);

  for (const snapshot of snapshots) {
    for (const relativePath of snapshot.paths) {
      const extension = normalizeExtension(path.posix.extname(relativePath));
      if (extension === ".java") {
        hasSourceFiles = true;
      }
      if (isMarkerMatch(relativePath, buildMarkers)) {
        hasBuildMarkers = true;
      }
      if (extension === ".xml" && await fileHasDubboXml(snapshot.repoPath, relativePath)) {
        hasDubboXml = true;
        dubboXmlFiles.push({ repoPath: snapshot.repoPath, relativePath });
      }
    }
  }

  return { language: "java", hasSourceFiles, hasBuildMarkers, hasDubboXml, dubboXmlFiles };
}

function matchesLanguage(language: DetectLanguageRule, snapshots: readonly RepoPathSnapshot[]): boolean {
  const detect = language.detect ?? { extensions: language.extensions };
  const extensions = new Set((detect.extensions ?? []).map(normalizeExtension));
  const markers = new Set(detect.markers ?? []);
  const globs = detect.globs ?? [];

  for (const snapshot of snapshots) {
    for (const relativePath of snapshot.paths) {
      if (extensions.size > 0 && extensions.has(normalizeExtension(path.posix.extname(relativePath)))) {
        return true;
      }
      if (markers.size > 0 && isMarkerMatch(relativePath, markers)) {
        return true;
      }
    }
    if (globs.length > 0 && snapshot.paths.some((relativePath) => globs.some((glob) => globMatches(relativePath, glob)))) {
      return true;
    }
  }
  return false;
}

function isMarkerMatch(relativePath: string, markers: ReadonlySet<string>): boolean {
  const parts = relativePath.split("/");
  if (parts.length > 4) return false;
  return markers.has(parts[parts.length - 1] ?? "");
}

function normalizeExtension(extension: string): string {
  const trimmed = extension.trim();
  return trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
}

function globTargetsExtension(glob: string, extension: string): boolean {
  const normalized = glob.trim().toLowerCase();
  return normalized.endsWith(extension.toLowerCase()) ||
    normalized.endsWith(`${extension.toLowerCase()}` + "}");
}

function isSafeSourceGlob(glob: string): boolean {
  const normalized = toPosixPath(glob.trim());
  return normalized.length > 0 && !path.posix.isAbsolute(normalized) && !normalized.split("/").includes("..");
}

async function fileHasDubboXml(repoPath: string, relativePath: string): Promise<boolean> {
  const absolutePath = path.join(repoPath, relativePath);
  const stat = await fs.stat(absolutePath).catch(() => undefined);
  if (!stat || !stat.isFile() || stat.size > DUBBO_XML_MAX_BYTES) return false;
  const source = await fs.readFile(absolutePath, "utf8").catch(() => "");
  return /<dubbo:(?:service|reference)\b/i.test(source) ||
    /xmlns:dubbo\s*=\s*["'][^"']*dubbo[^"']*["']/i.test(source);
}

function globMatches(relativePath: string, glob: string): boolean {
  let escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  escaped = escaped.replace(/\*\*/g, "___DOUBLE_STAR___");
  escaped = escaped.replace(/\*/g, "___STAR___");
  escaped = escaped.replace(/\?/g, "___QUESTION___");
  escaped = escaped.replace(/___DOUBLE_STAR___\//g, "(?:.*/)?");
  escaped = escaped.replace(/___DOUBLE_STAR___/g, ".*");
  escaped = escaped.replace(/___STAR___/g, "[^/]*");
  escaped = escaped.replace(/___QUESTION___/g, "[^/]");
  return new RegExp(`^${escaped}$`).test(relativePath);
}

export function projectPluginDir(repoPath: string): string {
  return path.join(repoPath, BRAND.configDirName, "plugins");
}
