import { BUILTIN_PARSER_EXTENSION_METADATA } from "../../core/parsing/extensionMetadata.js";
import type { LanguageParser } from "../../core/registries/types.js";

export type QueryPlanningContext = Readonly<{
  fileExtensions: readonly string[];
}>;

export type QueryPlanningContextInput = Readonly<{
  activePluginManifests?: readonly Readonly<{
    languages?: readonly Readonly<{ id?: string; extensions: readonly string[] }>[];
  }>[];
  activeParsers?: readonly Pick<LanguageParser, "extensions" | "scopeRepoId">[];
  repoIds?: readonly string[];
}>;

const VALID_EXTENSION = /^\.[\p{L}\p{N}][\p{L}\p{N}._+-]{0,31}$/u;

export function normalizeQueryFileExtension(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed || /[\\/\s?#]/u.test(trimmed)) return undefined;
  const normalized = trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
  return VALID_EXTENSION.test(normalized) ? normalized : undefined;
}

function normalizedExtensions(values: readonly unknown[]): readonly string[] {
  return Object.freeze([...new Set(values.flatMap((value) => {
    const normalized = normalizeQueryFileExtension(value);
    return normalized ? [normalized] : [];
  }))].sort());
}

export function createQueryPlanningContext(input: QueryPlanningContextInput = {}): QueryPlanningContext {
  const visibleRepoIds = input.repoIds ? new Set(input.repoIds) : undefined;
  const parserExtensions = (input.activeParsers ?? [])
    .filter((parser) => !parser.scopeRepoId || !visibleRepoIds || visibleRepoIds.has(parser.scopeRepoId))
    .flatMap((parser) => [...parser.extensions]);
  const manifestExtensions = (input.activePluginManifests ?? [])
    .flatMap((manifest) => manifest.languages ?? [])
    .flatMap((language) => [...language.extensions]);
  const fileExtensions = normalizedExtensions([
    ...BUILTIN_PARSER_EXTENSION_METADATA.flatMap((entry) => entry.extensions),
    ...manifestExtensions,
    ...parserExtensions
  ]);
  return Object.freeze({ fileExtensions });
}

export const DEFAULT_QUERY_PLANNING_CONTEXT = createQueryPlanningContext();
