import { Command } from "commander";
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

  /**
   * Applies all plugin-registered CLI command hooks to the program.
   *
   * System (built-in) commands have the highest priority and cannot be
   * overridden: any command name or alias already present on the program when
   * `apply` runs is reserved. A plugin attempt to register a colliding command
   * is rejected (warned and skipped) so the built-in always wins. Names claimed
   * by earlier plugins are reserved too, giving deterministic first-wins order.
   */
  apply(program: Command): void {
    const reserved = collectReservedCommandNames(program);
    for (const registerFn of this.registerFns) {
      registerFn(guardProgram(program, reserved));
    }
  }

  count(): number {
    return this.registerFns.length;
  }
}

/** Collects the names and aliases of every command currently on the program. */
function collectReservedCommandNames(program: Command): Set<string> {
  const reserved = new Set<string>(["help"]);
  for (const command of program.commands) {
    reserved.add(command.name());
    for (const alias of command.aliases()) reserved.add(alias);
  }
  return reserved;
}

/** Extracts the bare command name from a commander `nameAndArgs` string. */
function commandName(nameAndArgs: string): string {
  return nameAndArgs.trim().split(/\s+/)[0] ?? "";
}

/**
 * Wraps the program so plugin `.command()` / `.addCommand()` calls cannot
 * register a command whose name collides with a reserved (system or
 * already-registered) command. Colliding registrations are warned and dropped;
 * everything else is forwarded to the real program.
 */
function guardProgram(program: Command, reserved: Set<string>): Command {
  return new Proxy(program, {
    get(target, prop, receiver) {
      if (prop === "command") {
        return (nameAndArgs: string, ...rest: unknown[]) => {
          const name = commandName(nameAndArgs);
          if (reserved.has(name)) {
            console.warn(`Plugin attempted to register reserved CLI command "${name}"; the built-in command takes precedence and the plugin command was skipped.`);
            // Return a detached Command so the plugin's chained calls still work.
            return new Command(name);
          }
          reserved.add(name);
          return (target.command as (...args: unknown[]) => Command)(nameAndArgs, ...rest);
        };
      }
      if (prop === "addCommand") {
        return (cmd: Command, ...rest: unknown[]) => {
          const name = cmd?.name?.();
          if (name && reserved.has(name)) {
            console.warn(`Plugin attempted to register reserved CLI command "${name}"; the built-in command takes precedence and the plugin command was skipped.`);
            return target;
          }
          if (name) reserved.add(name);
          return (target.addCommand as (...args: unknown[]) => Command)(cmd, ...rest);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
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
