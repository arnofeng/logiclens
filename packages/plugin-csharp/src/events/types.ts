import type { PluginEventFact, PluginFileView } from "@logiclens/plugin-sdk";

export type EventCandidate = Omit<PluginEventFact, "kind" | "repoId" | "filePath" | "sourceSymbolId" | "evidence"> & {
  index: number;
  raw: string;
  rule: string;
};

export type EventRule = (file: PluginFileView) => EventCandidate[];

export function literal(raw: string): string | undefined {
  const value = raw.trim();
  if (!value.startsWith("\"") || !value.endsWith("\"")) return undefined;
  try { return JSON.parse(value) as string; } catch { return undefined; }
}

export function typedVariables(source: string, typePattern: string): Map<string, RegExpMatchArray> {
  const values = new Map<string, RegExpMatchArray>();
  for (const match of source.matchAll(new RegExp(`\\b(${typePattern})\\s+(\\w+)\\b`, "g"))) values.set(match[2]!, match);
  return values;
}

export function lexicalType(source: string, variable: string, index: number): string | undefined {
  const escaped = variable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const useScope = scopeAt(source, index);
  let found: { type: string; index: number } | undefined;
  for (const match of source.slice(0, index).matchAll(new RegExp(`\\b([\\w.]+(?:\\s*<[^;=()]+>)?)\\s+${escaped}\\b`, "g"))) {
    const declarationIndex = match.index!;
    const declarationScope = declarationScopeAt(source, declarationIndex);
    if (!isScopePrefix(declarationScope, useScope)) continue;
    if (!found || declarationIndex > found.index) found = { type: match[1]!, index: declarationIndex };
  }
  return found?.type;
}

export function hasLexicalType(source: string, variable: string, index: number, pattern: RegExp): boolean {
  const value = lexicalType(source, variable, index);
  return value !== undefined && pattern.test(value);
}

export function isLexicallyVisible(source: string, declarationIndex: number, useIndex: number): boolean {
  return declarationIndex < useIndex && isScopePrefix(declarationScopeAt(source, declarationIndex), scopeAt(source, useIndex));
}

function scopeAt(source: string, index: number): number[] {
  const stack: number[] = [];
  let braceId = 0;
  let quote: string | undefined;
  let lineComment = false;
  let blockComment = false;
  for (let position = 0; position < index; position++) {
    const char = source[position]!;
    const next = source[position + 1];
    if (lineComment) { if (char === "\n") lineComment = false; continue; }
    if (blockComment) { if (char === "*" && next === "/") { blockComment = false; position++; } continue; }
    if (quote) { if (char === "\\") position++; else if (char === quote) quote = undefined; continue; }
    if (char === "/" && next === "/") { lineComment = true; position++; continue; }
    if (char === "/" && next === "*") { blockComment = true; position++; continue; }
    if (char === "\"" || char === "'") { quote = char; continue; }
    if (char === "{") stack.push(++braceId);
    else if (char === "}") stack.pop();
  }
  return stack;
}

function declarationScopeAt(source: string, index: number): number[] {
  const scope = scopeAt(source, index);
  const open = source.lastIndexOf("(", index);
  const close = open >= 0 ? source.indexOf(")", open) : -1;
  if (open >= 0 && close >= index) {
    const block = source.indexOf("{", close);
    const terminator = source.indexOf(";", close);
    if (block >= 0 && (terminator < 0 || block < terminator)) return scopeAt(source, block + 1);
  }
  return scope;
}

function isScopePrefix(candidate: readonly number[], use: readonly number[]): boolean {
  return candidate.length <= use.length && candidate.every((value, index) => use[index] === value);
}

export function genericArguments(value: string): string[] {
  const body = value.slice(value.indexOf("<") + 1, value.lastIndexOf(">"));
  return body.split(",").map((item) => item.trim().replace(/^.*\./, ""));
}
