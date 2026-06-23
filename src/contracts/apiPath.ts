export function normalizeApiPath(pathValue: string): string {
  const withoutOrigin = pathValue.trim().replace(/^https?:\/\/[^/]+/i, "");
  const withoutQuery = withoutOrigin.replace(/\?.*$/, "");
  const withParameters = withoutQuery
    .replace(/\/:([A-Za-z_][A-Za-z0-9_]*)/g, "/{$1}")
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, "{$1}")
    .replace(/\$\{[^}]+\}/g, "{param}");
  const prefixed = withParameters.startsWith("/") ? withParameters : `/${withParameters}`;
  return prefixed.replace(/\/+/g, "/").replace(/\/$/, "") || "/";
}

export function joinApiPaths(basePath: string, routePath: string): string {
  if (!basePath) return normalizeApiPath(routePath);
  if (!routePath) return normalizeApiPath(basePath);
  return normalizeApiPath(`${basePath}/${routePath}`);
}
