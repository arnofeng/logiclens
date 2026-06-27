import type { GraphDB } from "./db.js";

export type GraphProvider = "kuzu" | "neo4j";

export interface GraphDBFactory {
  open(config: { path?: string; url?: string; username?: string; password?: string }): Promise<GraphDB>;
}

const factories = new Map<string, GraphDBFactory>();

export function registerGraphProvider(provider: string, factory: GraphDBFactory): void {
  factories.set(provider, factory);
}

/**
 * Lazily ensures the requested provider is registered.
 * Only imports the module for the given provider, avoiding unnecessary
 * startup cost (e.g. loading neo4j-driver when only kuzu is needed).
 */
async function ensureProvider(provider: string): Promise<void> {
  if (factories.has(provider)) return;
  if (provider === "kuzu") await import("../adapters/graph-db/kuzu/register.js");
  else if (provider === "neo4j") await import("../adapters/graph-db/neo4j/register.js");
}

export async function createGraphDB(
  provider: string,
  config: { path?: string; url?: string; username?: string; password?: string }
): Promise<GraphDB> {
  await ensureProvider(provider);
  const factory = factories.get(provider);
  if (!factory) {
    throw new Error(`Unknown graph provider: ${provider}. Registered: ${[...factories.keys()]}`);
  }
  return factory.open(config);
}
