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

      parsed.parseLanguage = delegateLanguage;
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
export function extractAndPadVueScripts(sourceInput: string): { scriptSource: string; isTypeScript: boolean } {
  const source = sourceInput.replace(/\r\n/g, "\n");
  let isTypeScript = false;
  const scriptRanges: Array<{ start: number; end: number }> = [];

  try {
    const parsed = parseSFC(source);
    if (parsed.errors.length > 0) {
      process.emitWarning(
        `Vue SFC parser reported ${parsed.errors.length} error(s); script extraction will continue where possible.`,
        { code: "VUE_SFC_PARSE" }
      );
    }
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
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.emitWarning(`Vue SFC parser failed; falling back to raw script-block extraction: ${message}`, { code: "VUE_SFC_PARSE" });
    const scriptPattern = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
    for (const match of source.matchAll(scriptPattern)) {
      const attrs = match[1] ?? "";
      if (/\blang\s*=\s*["']?(ts|tsx|typescript)["']?/i.test(attrs)) isTypeScript = true;
      const full = match[0] ?? "";
      const content = match[2] ?? "";
      const start = (match.index ?? 0) + full.indexOf(content);
      scriptRanges.push({ start, end: start + content.length });
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
