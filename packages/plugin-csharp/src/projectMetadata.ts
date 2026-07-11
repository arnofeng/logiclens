import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";

export const PROJECT_SCAN_LIMITS = {
  maxFiles: 2_048,
  maxFileSize: 1_048_576,
  maxDepth: 32,
  maxDirectories: 4_096
} as const;

const EXCLUDED_DIRECTORIES = new Set([
  ".git", ".hg", ".svn", ".idea", ".vs", ".vscode",
  "bin", "obj", "node_modules", "packages", "testresults"
]);
const MARKER_NAMES = new Set(["directory.build.props", "directory.packages.props"]);

type XmlNode = {
  name: string;
  attributes: Readonly<Record<string, string>>;
  children: XmlNode[];
  text: string;
  line: number;
  raw: string;
  openingRaw: string;
  start: number;
};

export type ProjectDeclarationKind =
  | "sdk"
  | "targetFramework"
  | "frameworkReference"
  | "packageReference"
  | "packageVersion";

export type ProjectDeclaration = {
  kind: ProjectDeclarationKind;
  name: string;
  version?: string;
  filePath: string;
  line: number;
  raw: string;
};

export type ProjectMetadataFile = {
  filePath: string;
  source: string;
  declarations: readonly ProjectDeclaration[];
};

function newlineOffsets(source: string): number[] {
  const offsets: number[] = [];
  for (let index = source.indexOf("\n"); index >= 0; index = source.indexOf("\n", index + 1)) offsets.push(index);
  return offsets;
}

function lineAt(offsets: readonly number[], offset: number): number {
  let low = 0;
  let high = offsets.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (offsets[middle]! < offset) low = middle + 1;
    else high = middle;
  }
  return low + 1;
}

function decodeXml(value: string): string | undefined {
  if (/&(?!lt;|gt;|amp;|quot;|apos;|#\d+;|#x[\da-fA-F]+;)/.test(value)) return undefined;
  let valid = true;
  const decoded = value.replace(/&(?:lt|gt|amp|quot|apos|#\d+|#x[\da-fA-F]+);/g, (entity) => {
    const named: Record<string, string> = { "&lt;": "<", "&gt;": ">", "&amp;": "&", "&quot;": "\"", "&apos;": "'" };
    if (named[entity]) return named[entity];
    const hex = entity.startsWith("&#x");
    const parsed = Number.parseInt(entity.slice(hex ? 3 : 2, -1), hex ? 16 : 10);
    if (!Number.isFinite(parsed) || parsed > 0x10ffff || (parsed >= 0xd800 && parsed <= 0xdfff)) {
      valid = false;
      return entity;
    }
    return String.fromCodePoint(parsed);
  });
  return valid ? decoded : undefined;
}

function tagEnd(source: string, start: number): number {
  let quote = "";
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index]!;
    if (quote) {
      if (character === quote) quote = "";
    } else if (character === "\"" || character === "'") quote = character;
    else if (character === ">") return index;
  }
  return -1;
}

function parseOpeningTag(raw: string): { name: string; attributes: Record<string, string>; selfClosing: boolean } | undefined {
  const body = raw.slice(1, -1).trim();
  const selfClosing = body.endsWith("/");
  const content = (selfClosing ? body.slice(0, -1) : body).trim();
  let index = 0;
  while (index < content.length && !/\s/.test(content[index]!)) index += 1;
  const name = content.slice(0, index);
  if (!/^[A-Za-z_][\w.:-]*$/.test(name)) return undefined;
  const attributes: Record<string, string> = {};
  while (index < content.length) {
    while (/\s/.test(content[index] ?? "")) index += 1;
    if (index >= content.length) break;
    const nameStart = index;
    while (index < content.length && !/[\s=]/.test(content[index]!)) index += 1;
    const attributeName = content.slice(nameStart, index);
    if (!/^[A-Za-z_][\w.:-]*$/.test(attributeName)) return undefined;
    while (/\s/.test(content[index] ?? "")) index += 1;
    if (content[index] !== "=") return undefined;
    index += 1;
    while (/\s/.test(content[index] ?? "")) index += 1;
    const quote = content[index];
    if (quote !== "\"" && quote !== "'") return undefined;
    const valueStart = ++index;
    while (index < content.length && content[index] !== quote) index += 1;
    if (index >= content.length) return undefined;
    if (attributeName in attributes) return undefined;
    const decoded = decodeXml(content.slice(valueStart, index));
    if (decoded === undefined) return undefined;
    attributes[attributeName] = decoded;
    index += 1;
  }
  return { name, attributes, selfClosing };
}

function parseXml(source: string): XmlNode | undefined {
  const lines = newlineOffsets(source);
  const roots: XmlNode[] = [];
  const stack: XmlNode[] = [];
  const appendText = (value: string): boolean => {
    if (!value) return true;
    if (!stack.length) return value.replace(/^\uFEFF/, "").trim() === "";
    const decoded = decodeXml(value);
    if (decoded === undefined) return false;
    stack.at(-1)!.text += decoded;
    return true;
  };
  let cursor = 0;
  while (cursor < source.length) {
    const open = source.indexOf("<", cursor);
    if (open < 0) {
      if (!appendText(source.slice(cursor))) return undefined;
      break;
    }
    if (!appendText(source.slice(cursor, open))) return undefined;
    if (source.startsWith("<!--", open)) {
      const end = source.indexOf("-->", open + 4);
      if (end < 0) return undefined;
      cursor = end + 3;
      continue;
    }
    if (source.startsWith("<![CDATA[", open)) {
      const end = source.indexOf("]]>", open + 9);
      if (end < 0 || !stack.length) return undefined;
      stack.at(-1)!.text += source.slice(open + 9, end);
      cursor = end + 3;
      continue;
    }
    if (source.startsWith("<?", open)) {
      const end = source.indexOf("?>", open + 2);
      if (end < 0) return undefined;
      cursor = end + 2;
      continue;
    }
    if (source.startsWith("<!", open)) return undefined;
    const end = tagEnd(source, open);
    if (end < 0) return undefined;
    const rawTag = source.slice(open, end + 1);
    if (rawTag.startsWith("</")) {
      const closingName = rawTag.slice(2, -1).trim();
      const node = stack.pop();
      if (!node || node.name !== closingName) return undefined;
      node.raw = source.slice(node.start, end + 1);
      cursor = end + 1;
      continue;
    }
    const parsed = parseOpeningTag(rawTag);
    if (!parsed) return undefined;
    const node: XmlNode = { name: parsed.name, attributes: parsed.attributes, children: [], text: "", line: lineAt(lines, open), raw: rawTag, openingRaw: rawTag, start: open };
    const parent = stack.at(-1);
    if (parent) parent.children.push(node); else roots.push(node);
    if (!parsed.selfClosing) stack.push(node);
    cursor = end + 1;
  }
  return stack.length === 0 && roots.length === 1 ? roots[0] : undefined;
}

function attribute(node: XmlNode, name: string): string | undefined {
  const key = Object.keys(node.attributes).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? node.attributes[key] : undefined;
}

function localName(name: string): string {
  return name.slice(name.lastIndexOf(":") + 1);
}

export function parseProjectMetadata(filePath: string, source: string): ProjectMetadataFile | undefined {
  const root = parseXml(source);
  if (!root || localName(root.name) !== "Project") return undefined;
  const declarations: ProjectDeclaration[] = [];
  const add = (kind: ProjectDeclarationKind, name: string | undefined, node: XmlNode, version?: string): void => {
    const trimmed = name?.trim();
    if (!trimmed || trimmed.includes("$(")) return;
    const trimmedVersion = version?.trim();
    const directVersion = trimmedVersion && !trimmedVersion.includes("$(") ? trimmedVersion : undefined;
    declarations.push({ kind, name: trimmed, ...(directVersion ? { version: directVersion } : {}), filePath, line: node.line, raw: node.raw });
  };
  const rootSdk = attribute(root, "Sdk");
  if (rootSdk && !attribute(root, "Condition")) {
    for (const sdk of rootSdk.split(";")) add("sdk", sdk, { ...root, raw: root.openingRaw });
  }
  const visit = (node: XmlNode, ancestorConditional: boolean): void => {
    const name = localName(node.name);
    const conditional = ancestorConditional || Boolean(attribute(node, "Condition"));
    if (!conditional) {
      if (name === "Sdk") add("sdk", attribute(node, "Name") ?? node.text, node, attribute(node, "Version"));
      if (name === "TargetFramework") add("targetFramework", node.text, node);
      if (name === "TargetFrameworks") for (const framework of node.text.split(";")) add("targetFramework", framework, node);
      if (name === "FrameworkReference") add("frameworkReference", attribute(node, "Include") ?? attribute(node, "Update"), node);
      if (name === "PackageReference") add("packageReference", attribute(node, "Include") ?? attribute(node, "Update"), node, attribute(node, "Version") ?? node.children.find((child) => localName(child.name) === "Version" && !attribute(child, "Condition"))?.text);
      if (name === "PackageVersion") add("packageVersion", attribute(node, "Include") ?? attribute(node, "Update"), node, attribute(node, "Version") ?? node.children.find((child) => localName(child.name) === "Version" && !attribute(child, "Condition"))?.text);
    }
    for (const child of node.children) visit(child, conditional);
  };
  visit(root, false);
  return { filePath, source, declarations };
}

function isMetadataFile(name: string): boolean {
  const normalized = name.toLowerCase();
  return normalized.endsWith(".csproj") || MARKER_NAMES.has(normalized);
}

export async function collectProjectMetadata(repoPath: string): Promise<ProjectMetadataFile[]> {
  const root = path.resolve(repoPath);
  let realRoot: string;
  try { realRoot = await fs.realpath(root); } catch { return []; }
  const candidates: string[] = [];
  let visitedDirectories = 0;
  const staysWithinRoot = (candidate: string): boolean => {
    const relative = path.relative(realRoot, candidate);
    return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
  };
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > PROJECT_SCAN_LIMITS.maxDepth || candidates.length >= PROJECT_SCAN_LIMITS.maxFiles || visitedDirectories >= PROJECT_SCAN_LIMITS.maxDirectories) return;
    try {
      const [directoryStats, realDirectory] = await Promise.all([depth === 0 ? fs.stat(directory) : fs.lstat(directory), fs.realpath(directory)]);
      if (!directoryStats.isDirectory() || (depth > 0 && directoryStats.isSymbolicLink()) || !staysWithinRoot(realDirectory)) return;
    } catch { return; }
    visitedDirectories += 1;
    let entries: Dirent[];
    try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch { return; }
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      if (candidates.length >= PROJECT_SCAN_LIMITS.maxFiles) break;
      if (entry.isSymbolicLink()) continue;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRECTORIES.has(entry.name.toLowerCase())) await walk(absolutePath, depth + 1);
      } else if (entry.isFile() && isMetadataFile(entry.name)) candidates.push(absolutePath);
    }
  };
  await walk(root, 0);
  const files: ProjectMetadataFile[] = [];
  for (const absolutePath of candidates) {
    try {
      const [stats, realFile] = await Promise.all([fs.lstat(absolutePath), fs.realpath(absolutePath)]);
      if (!stats.isFile() || stats.isSymbolicLink() || stats.size > PROJECT_SCAN_LIMITS.maxFileSize || !staysWithinRoot(realFile)) continue;
      const source = await fs.readFile(absolutePath, "utf8");
      const relativePath = path.relative(root, absolutePath).split(path.sep).join("/");
      if (relativePath.startsWith("../") || path.isAbsolute(relativePath)) continue;
      const parsed = parseProjectMetadata(relativePath, source);
      if (parsed) files.push(parsed);
    } catch { /* Permission races and unreadable files are safely ignored. */ }
  }
  files.sort((left, right) => left.filePath.localeCompare(right.filePath, "en"));
  const centralFiles = files.filter((file) => file.filePath.toLowerCase().endsWith("directory.packages.props"));
  return files.map((file) => ({
    ...file,
    declarations: file.declarations.map((declaration) => {
      if (declaration.kind !== "packageReference" || declaration.version) return declaration;
      const projectDirectory = path.posix.dirname(file.filePath);
      const nearestCentralFile = centralFiles
        .filter((candidate) => {
          const propsDirectory = path.posix.dirname(candidate.filePath);
          return propsDirectory === "." || projectDirectory === propsDirectory || projectDirectory.startsWith(`${propsDirectory}/`);
        })
        .sort((left, right) => path.posix.dirname(right.filePath).length - path.posix.dirname(left.filePath).length || left.filePath.localeCompare(right.filePath, "en"))[0];
      const match = nearestCentralFile?.declarations.find((candidate) => candidate.kind === "packageVersion" && candidate.version && candidate.name.toLowerCase() === declaration.name.toLowerCase());
      return match?.version ? { ...declaration, version: match.version } : declaration;
    })
  }));
}
