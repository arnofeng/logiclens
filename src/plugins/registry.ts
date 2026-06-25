import type { Command } from "commander";
import type { ContractExtractor, EmbeddingProvider, LanguageParser, FrameworkDetector } from "./types.js";

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

export class ContractExtractorRegistry {
  private extractorsByName = new Map<string, ContractExtractor>();

  register(extractor: ContractExtractor): void {
    this.extractorsByName.set(extractor.name, extractor);
  }

  extractors(): ContractExtractor[] {
    return [...this.extractorsByName.values()];
  }
}

export class FrameworkDetectorRegistry {
  private detectorsByName = new Map<string, FrameworkDetector>();

  register(detector: FrameworkDetector): void {
    this.detectorsByName.set(detector.name, detector);
  }

  detectors(): FrameworkDetector[] {
    return [...this.detectorsByName.values()];
  }
}

export class CliCommandRegistry {
  private registerFns: Array<(program: Command) => void> = [];

  register(registerFn: (program: Command) => void): void {
    this.registerFns.push(registerFn);
  }

  apply(program: Command): void {
    for (const registerFn of this.registerFns) registerFn(program);
  }

  count(): number {
    return this.registerFns.length;
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
export const contractExtractorRegistry = new ContractExtractorRegistry();
export const frameworkDetectorRegistry = new FrameworkDetectorRegistry();
export const cliCommandRegistry = new CliCommandRegistry();
export const embeddingProviderRegistry = new EmbeddingProviderRegistry();

export function normalizeExtension(extension: string): string {
  const trimmed = extension.trim();
  return trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
}
