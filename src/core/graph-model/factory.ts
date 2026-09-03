import type { GraphDB } from "./db.js";

export type GraphProviderId = string;

export interface GraphDBFactory {
  open(config: { path?: string; url?: string; username?: string; password?: string; database?: string }): Promise<GraphDB>;
}

export interface GraphProviderRegistration {
  factory: GraphDBFactory;
}

const registrations = new Map<GraphProviderId, GraphProviderRegistration>();

export class GraphProviderNotRegisteredError extends Error {
  readonly provider: GraphProviderId;

  constructor(provider: GraphProviderId, registered: readonly GraphProviderId[]) {
    super(`Unknown graph provider: ${provider}. Registered: ${registered.join(", ")}`);
    this.name = "GraphProviderNotRegisteredError";
    this.provider = provider;
  }
}

export function registerGraphProvider(
  provider: GraphProviderId,
  registration: GraphProviderRegistration
): void {
  assertValidProviderId(provider);
  if (registrations.has(provider)) {
    throw new Error(`Graph provider already registered: ${provider}`);
  }

  registrations.set(provider, registration);
}

/**
 * Lazily ensures the requested provider is registered.
 * Only imports the module for the given provider, avoiding unnecessary
 * startup cost (e.g. loading neo4j-driver when only kuzu is needed).
 */
async function ensureProvider(provider: GraphProviderId): Promise<void> {
  if (registrations.has(provider)) return;
  if (provider === "kuzu") await import("../../adapters/graph-db/kuzu/register.js");
  else if (provider === "neo4j") await import("../../adapters/graph-db/neo4j/register.js");

  if ((provider === "kuzu" || provider === "neo4j") && !registrations.has(provider)) {
    throw new Error(`Built-in graph provider failed to register: ${provider}`);
  }
}

/** Resolves a registration, lazily loading a built-in provider when requested. */
export async function getGraphProviderRegistration(
  provider: GraphProviderId
): Promise<GraphProviderRegistration> {
  assertValidProviderId(provider);
  await ensureProvider(provider);
  const registration = registrations.get(provider);
  if (!registration) {
    const registered = [...registrations.keys()].sort();
    throw new GraphProviderNotRegisteredError(provider, registered);
  }
  return registration;
}

export async function createGraphDB(
  provider: GraphProviderId,
  config: { path?: string; url?: string; username?: string; password?: string; database?: string }
): Promise<GraphDB> {
  const registration = await getGraphProviderRegistration(provider);
  return registration.factory.open(config);
}

function assertValidProviderId(provider: GraphProviderId): void {
  if (provider.trim().length === 0) {
    throw new Error("Graph provider ID must contain at least one non-whitespace character");
  }
}
