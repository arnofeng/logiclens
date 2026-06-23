import type { GraphDB } from "./db.js";

export type GraphProvider = "kuzu" | "neo4j";

export interface GraphDBFactory {
  open(config: { path?: string; url?: string }): Promise<GraphDB>;
}

const factories = new Map<string, GraphDBFactory>();

export function registerGraphProvider(provider: string, factory: GraphDBFactory): void {
  factories.set(provider, factory);
}

/**
 * Lazily ensures built-in providers are registered.
 * This avoids requiring callers to manage import ordering for the
 * KuzuDB registration side-effect module.
 */
async function ensureBuiltinProviders(): Promise<void> {
  if (!factories.has("kuzu")) {
    await import("./kuzu/register.js");
  }
}

export async function createGraphDB(
  provider: string,
  config: { path?: string; url?: string }
): Promise<GraphDB> {
  await ensureBuiltinProviders();
  const factory = factories.get(provider);
  if (!factory) {
    throw new Error(`Unknown graph provider: ${provider}. Registered: ${[...factories.keys()]}`);
  }
  return factory.open(config);
}
