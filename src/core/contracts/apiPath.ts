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

export function canonicalHttpContractKey(input: { method?: string; path: string }): string {
  const trimmed = input.path.trim();
  let normalizedPath: string;
  if (trimmed.startsWith("/") || /^https?:\/\//i.test(trimmed)) {
    normalizedPath = normalizeApiPath(trimmed).toLowerCase();
  } else {
    normalizedPath = trimmed
      .replace(/\?.*$/, "")
      .replace(/\/+/g, "/")
      .replace(/\/:([A-Za-z_][A-Za-z0-9_]*)/g, "/{$1}")
      .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, "{$1}")
      .replace(/\$\{[^}]+\}/g, "{param}")
      .replace(/\/$/, "")
      .toLowerCase();
  }
  if (input.method) return `${input.method.trim().toUpperCase()}:${normalizedPath}`;
  return normalizedPath;
}

export function canonicalGrpcContractKey(fullName: string): string {
  const cleaned = fullName.replace(/\s+/g, "");
  const slashIndex = cleaned.lastIndexOf("/");
  const packageService = slashIndex === -1 ? cleaned : cleaned.slice(0, slashIndex);
  const method = slashIndex === -1 ? "" : cleaned.slice(slashIndex + 1);

  const dots = packageService.split(".");
  const service = dots.pop() || "";
  const pkg = dots.join(".");

  const normalizedPkg = pkg.toLowerCase();
  const normalizedPackageService = normalizedPkg ? `${normalizedPkg}.${service}` : service;

  return method ? `${normalizedPackageService}/${method}` : normalizedPackageService;
}

export function canonicalDubboContractKey(interfaceName: string, method?: string): string {
  const normalizedInterface = interfaceName.replace(/\s+/g, "").toLowerCase();
  const normalizedMethod = method?.trim();
  return normalizedMethod ? `${normalizedInterface}#${normalizedMethod}` : normalizedInterface;
}
