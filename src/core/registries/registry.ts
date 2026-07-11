import type { ContractExtractor, EmbeddingProvider, FrameworkDetector, LanguageParser, ReferenceResolver } from "./types.js";

export class ParserRegistry {
  private languageStacks = new Map<string, LanguageParser[]>();
  private scopedLanguageStacks = new Map<string, LanguageParser[]>();
  private extensionStacks = new Map<string, LanguageParser[]>();

  register(parser: LanguageParser): void {
    const languageMap = parser.scopeRepoId ? this.scopedLanguageStacks : this.languageStacks;
    const languageKey = parser.scopeRepoId
      ? scopedLanguageKey(parser.scopeRepoId, parser.language)
      : parser.language;
    pushParser(languageMap, languageKey, parser);
    for (const extension of parser.extensions) {
      const normalized = normalizeExtension(extension);
      pushParser(this.extensionStacks, normalized, parser);
    }
  }

  resolve(input: { language?: string; relativePath?: string; repoId?: string }): LanguageParser | undefined {
    if (input.language) {
      if (input.repoId) {
        const scoped = topParser(this.scopedLanguageStacks.get(scopedLanguageKey(input.repoId, input.language)));
        if (scoped) return scoped;
      }
      const parser = topParser(this.languageStacks.get(input.language));
      if (parser) return parser;
    }
    if (!input.relativePath) return undefined;
    const candidates = [...this.extensionStacks.entries()].sort((a, b) => b[0].length - a[0].length);
    for (const [extension, stack] of candidates) {
      if (!input.relativePath.endsWith(extension)) continue;
      const parser = [...stack].reverse().find((candidate) =>
        candidate.scopeRepoId ? candidate.scopeRepoId === input.repoId : true
      );
      if (parser) return parser;
    }
    return undefined;
  }

  languages(): string[] {
    return [...new Set([
      ...[...this.languageStacks.values()].flat().map((parser) => parser.language),
      ...[...this.scopedLanguageStacks.values()].flat().map((parser) => parser.language)
    ])].sort();
  }

  parsers(): LanguageParser[] {
    return [...new Set([
      ...[...this.languageStacks.values()].flat(),
      ...[...this.scopedLanguageStacks.values()].flat()
    ])];
  }

  unregister(parser: LanguageParser): void {
    const languageMap = parser.scopeRepoId ? this.scopedLanguageStacks : this.languageStacks;
    const languageKey = parser.scopeRepoId
      ? scopedLanguageKey(parser.scopeRepoId, parser.language)
      : parser.language;
    removeParser(languageMap, languageKey, parser);
    for (const extension of parser.extensions.map(normalizeExtension)) {
      removeParser(this.extensionStacks, extension, parser);
    }
  }

  unregisterLanguage(language: string, expected?: LanguageParser): void {
    const parser = expected ?? topParser(this.languageStacks.get(language));
    if (parser) this.unregister(parser);
  }
}

function scopedLanguageKey(repoId: string, language: string): string {
  return `${repoId}\0${language}`;
}

function pushParser(map: Map<string, LanguageParser[]>, key: string, parser: LanguageParser): void {
  const stack = (map.get(key) ?? []).filter((candidate) => candidate !== parser);
  stack.push(parser);
  map.set(key, stack);
}

function removeParser(map: Map<string, LanguageParser[]>, key: string, parser: LanguageParser): void {
  const stack = map.get(key)?.filter((candidate) => candidate !== parser) ?? [];
  if (stack.length > 0) map.set(key, stack);
  else map.delete(key);
}

function topParser(stack: readonly LanguageParser[] | undefined): LanguageParser | undefined {
  return stack?.[stack.length - 1];
}

export class EmbeddingProviderRegistry {
  private byName = new Map<string, EmbeddingProvider>();

  register(provider: EmbeddingProvider): void {
    if (this.byName.has(provider.name)) {
      console.warn(`Embedding provider "${provider.name}" is already registered and will be overwritten.`);
    }
    this.byName.set(provider.name, provider);
  }

  resolve(name: string): EmbeddingProvider | undefined {
    return this.byName.get(name);
  }

  providers(): EmbeddingProvider[] {
    return [...this.byName.values()];
  }

  names(): string[] {
    return [...this.byName.keys()];
  }
}

export class ContractExtractorRegistry {
  private byName = new Map<string, ContractExtractor>();

  register(extractor: ContractExtractor): void {
    this.byName.set(extractor.name, extractor);
  }

  registerMany(extractors: readonly ContractExtractor[]): void {
    for (const extractor of extractors) this.register(extractor);
  }

  resolve(name: string): ContractExtractor | undefined {
    return this.byName.get(name);
  }

  extractors(): ContractExtractor[] {
    return [...this.byName.values()];
  }

  names(): string[] {
    return [...this.byName.keys()].sort();
  }

  clear(): void {
    this.byName.clear();
  }

  unregister(name: string): void {
    this.byName.delete(name);
  }
}

export class FrameworkDetectorRegistry {
  private byName = new Map<string, FrameworkDetector>();

  register(detector: FrameworkDetector): void {
    this.byName.set(detector.name, detector);
  }

  registerMany(detectors: readonly FrameworkDetector[]): void {
    for (const detector of detectors) this.register(detector);
  }

  resolve(name: string): FrameworkDetector | undefined {
    return this.byName.get(name);
  }

  detectors(): FrameworkDetector[] {
    return [...this.byName.values()];
  }

  names(): string[] {
    return [...this.byName.keys()].sort();
  }

  clear(): void {
    this.byName.clear();
  }

  unregister(name: string): void {
    this.byName.delete(name);
  }
}

export class ReferenceResolverRegistry {
  private byName = new Map<string, ReferenceResolver>();

  register(resolver: ReferenceResolver): void {
    this.byName.set(resolver.name, resolver);
  }

  resolvers(): ReferenceResolver[] {
    return [...this.byName.values()];
  }

  clear(): void {
    this.byName.clear();
  }

  unregister(name: string): void {
    this.byName.delete(name);
  }
}

export const parserRegistry = new ParserRegistry();
export const embeddingProviderRegistry = new EmbeddingProviderRegistry();
export const contractExtractorRegistry = new ContractExtractorRegistry();
export const frameworkDetectorRegistry = new FrameworkDetectorRegistry();
export const referenceResolverRegistry = new ReferenceResolverRegistry();

export function normalizeExtension(extension: string): string {
  const trimmed = extension.trim();
  return trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
}
