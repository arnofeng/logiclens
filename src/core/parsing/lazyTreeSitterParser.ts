import type { LanguageParser, ParseInput } from "../registries/types.js";
import type { LanguageExtractorConfig, ParsedFile } from "./types.js";
import { GenericTreeSitterParser } from "./genericTreeSitterParser.js";
import { loadLanguageGrammar, type LanguageDefinition } from "./languages/registry.js";

export class LazyTreeSitterParser implements LanguageParser {
  private parser?: GenericTreeSitterParser;
  private loading?: Promise<GenericTreeSitterParser>;

  constructor(
    private readonly definition: LanguageDefinition,
    private readonly helpers: LanguageExtractorConfig["helpers"]
  ) {}

  get name(): string {
    return `builtin:${this.definition.id}`;
  }

  get language(): string {
    return this.definition.id;
  }

  get extensions(): string[] {
    return this.definition.extensions;
  }

  async parse(input: ParseInput): Promise<ParsedFile> {
    const parser = await this.getParser();
    return parser.parse(input);
  }

  private async getParser(): Promise<GenericTreeSitterParser> {
    if (this.parser) return this.parser;
    if (!this.loading) this.loading = this.createParser();

    try {
      return await this.loading;
    } finally {
      this.loading = undefined;
    }
  }

  private async createParser(): Promise<GenericTreeSitterParser> {
    const grammar = await loadLanguageGrammar(this.definition);
    const parser = new GenericTreeSitterParser({
      language: this.definition.id,
      extensions: this.definition.extensions,
      grammar,
      queries: this.definition.queries,
      helpers: this.helpers
    });
    this.parser = parser;
    return parser;
  }
}
