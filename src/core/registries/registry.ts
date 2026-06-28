import type { EmbeddingProvider, LanguageParser } from "./types.js";

export class ParserRegistry {
  private byLanguage = new Map<string, LanguageParser>();
  private byExtension = new Map<string, LanguageParser>();

  register(parser: LanguageParser): void {
    this.byLanguage.set(parser.language, parser);
    for (const extension of parser.extensions) {
      this.byExtension.set(normalizeExtension(extension), parser);
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

export const parserRegistry = new ParserRegistry();
export const embeddingProviderRegistry = new EmbeddingProviderRegistry();

export function normalizeExtension(extension: string): string {
  const trimmed = extension.trim();
  return trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
}
