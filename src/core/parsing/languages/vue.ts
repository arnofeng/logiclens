import type { LanguageParser, ParseInput } from "../../registries/types.js";
import type { ParsedFile } from "../types.js";
import { parserRegistry } from "../../registries/registry.js";
import { parse as parseSFC } from "@vue/compiler-sfc";

export function createVueParser(): LanguageParser {
  return {
    name: "builtin:vue",
    language: "vue",
    extensions: [".vue"],
    async parse(input: ParseInput): Promise<ParsedFile> {
      const source = input.source;

      // Extract and pad script content to preserve line/col numbers
      const { scriptSource, isTypeScript } = extractAndPadVueScripts(source);

      // Use either "tsx" or "jsx" parser from the registry
      const delegateLanguage = isTypeScript ? "tsx" : "jsx";
      const delegateParser = parserRegistry.resolve({ language: delegateLanguage });
      if (!delegateParser) {
        throw new Error(`Underlying parser for '${delegateLanguage}' (needed by Vue) not found.`);
      }

      // Delegate parsing of the padded script source
      const parsed = (await delegateParser.parse({
        ...input,
        source: scriptSource,
        language: delegateLanguage
      })) as ParsedFile;

      // Override the language of the parsed file back to "vue"
      parsed.language = "vue";
      return parsed;
    }
  };
}

/**
 * Extracts all script blocks (e.g. <script> or <script setup>) from Vue SFC,
 * replacing all non-script block characters with spaces (except newlines, to preserve lines).
 */
export function extractAndPadVueScripts(source: string): { scriptSource: string; isTypeScript: boolean } {
  let isTypeScript = false;
  const scriptRanges: Array<{ start: number; end: number }> = [];

  const parsed = parseSFC(source);
  const descriptor = parsed.descriptor;

  const blocks = [descriptor.script, descriptor.scriptSetup].filter(Boolean);

  for (const block of blocks) {
    if (block) {
      const lang = (block.attrs.lang || "").toString().toLowerCase().trim();
      if (lang === "ts" || lang === "tsx" || lang === "typescript") {
        isTypeScript = true;
      }
      scriptRanges.push({ start: block.loc.start.offset, end: block.loc.end.offset });
    }
  }

  scriptRanges.sort((a, b) => a.start - b.start);

  let scriptSource = "";
  let lastIdx = 0;
  for (const range of scriptRanges) {
    const preBlock = source.substring(lastIdx, range.start);
    scriptSource += preBlock.replace(/[^\r\n]/g, " ");
    scriptSource += source.substring(range.start, range.end);
    lastIdx = range.end;
  }
  const postBlock = source.substring(lastIdx);
  scriptSource += postBlock.replace(/[^\r\n]/g, " ");

  return {
    scriptSource,
    isTypeScript
  };
}
