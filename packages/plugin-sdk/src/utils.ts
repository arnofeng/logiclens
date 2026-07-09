export type SourceRange = {
  startOffset: number;
  endOffset?: number;
};

export function lineOfOffset(source: string, offset: number, startLine = 1): number {
  const boundedOffset = Math.max(0, Math.min(offset, source.length));
  return startLine + source.slice(0, boundedOffset).split(/\r?\n/).length - 1;
}

export function sourceLine(source: string, range: SourceRange, startLine = 1): number {
  return lineOfOffset(source, range.startOffset, startLine);
}

export function normalizeHttpPath(path: string): string {
  const normalized = path.trim().replace(/\\/g, "/").replace(/\/+/g, "/");
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

export function joinHttpPaths(...parts: Array<string | undefined>): string {
  const joined = parts
    .filter((part): part is string => Boolean(part && part.trim()))
    .map((part) => part.trim().replace(/^\/+|\/+$/g, ""))
    .filter(Boolean)
    .join("/");
  return normalizeHttpPath(joined);
}

export function normalizeRouteParam(param: string): string {
  const trimmed = param.trim();
  const catchAll = trimmed.startsWith("*") ? "*" : "";
  const withoutCatchAll = trimmed.replace(/^\*+/, "");
  const name = withoutCatchAll.split(":")[0]?.replace(/\?$/, "").trim();
  return name ? `{${catchAll}${name}}` : `{${trimmed}}`;
}

export function normalizeRouteTemplate(template: string): string {
  return normalizeHttpPath(template.replace(/\{([^}]+)\}/g, (_match, param: string) => normalizeRouteParam(param)));
}

export function safeJsonParse<T = unknown>(raw: string): T | undefined {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}
