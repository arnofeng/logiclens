import type { ContractExtractor, EmbeddingProvider, FrameworkDetector, LanguageParser, ReferenceResolver } from "./types.js";

export class ParserRegistry {
  private byLanguage = new Map<string, LanguageParser>();
  private byExtension = new Map<string, LanguageParser>();
  private extensionOverridesByLanguage = new Map<string, Map<string, LanguageParser | undefined>>();

  register(parser: LanguageParser): void {
    this.byLanguage.set(parser.language, parser);
    for (const extension of parser.extensions) {
      const normalized = normalizeExtension(extension);
      const previous = this.byExtension.get(normalized);
      if (previous?.language !== parser.language) {
        const overrides = this.extensionOverridesByLanguage.get(parser.language) ?? new Map<string, LanguageParser | undefined>();
        if (!overrides.has(normalized)) {
          overrides.set(normalized, previous);
          this.extensionOverridesByLanguage.set(parser.language, overrides);
        }
      }
      this.byExtension.set(normalized, parser);
    }
  }

  resolve(input: { language?: string; relativePath?: string }): LanguageParser | undefined {
    if (input.language) {
      const parser = this.byLanguage.get(input.language);
      if (parser) return parser;
    }
    if (!input.relativePath) return undefined;
    const candidates = [...this.byExtension.entries()].sort((a, b) => b[0].length - a[0].length);
    for (const [extension, parser] of candidates) {
      if (input.relativePath.endsWith(extension)) return parser;
    }
    return undefined;
  }

  languages(): string[] {
    return [...this.byLanguage.keys()].sort();
  }

  parsers(): LanguageParser[] {
    return [...new Map(this.byLanguage.entries()).values()];
  }

  unregisterLanguage(language: string): void {
    const parser = this.byLanguage.get(language);
    const overrides = this.extensionOverridesByLanguage.get(language);
    if (!parser && !overrides) return;
    this.byLanguage.delete(language);
    const extensions = new Set([
      ...(parser?.extensions ?? []).map(normalizeExtension),
      ...(overrides?.keys() ?? [])
    ]);
    for (const normalized of extensions) {
      if (this.byExtension.get(normalized)?.language !== language) continue;
      const previous = overrides?.get(normalized);
      if (previous && this.byLanguage.get(previous.language) === previous) {
        this.byExtension.set(normalized, previous);
      } else {
        this.byExtension.delete(normalized);
      }
    }
    this.extensionOverridesByLanguage.delete(language);
  }
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
