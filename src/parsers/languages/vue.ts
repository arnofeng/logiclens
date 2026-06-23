import type { LanguageParser, ParseInput } from "../../plugins/types.js";
import type { ParsedFile } from "../types.js";
import { parserRegistry } from "../../plugins/registry.js";
import Parser from "tree-sitter";
// @ts-ignore
import VueGrammar from "@fel1x-developer/tree-sitter-vue";

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
  const parser = new Parser();
  parser.setLanguage(VueGrammar);
  const tree = parser.parse((index) => index < source.length ? source.slice(index, index + 8192) : null);

  let isTypeScript = false;
  const scriptRanges: Array<{ start: number; end: number }> = [];

  function walk(node: Parser.SyntaxNode) {
    if (node.type === "script_element") {
      const startTag = node.childForFieldName("start_tag") ?? node.child(0);
      if (startTag) {
        for (let i = 0; i < startTag.childCount; i++) {
          const attr = startTag.child(i)!;
          if (attr.type === "attribute") {
            let isLang = false;
            let valNode: Parser.SyntaxNode | null = null;
            for (let j = 0; j < attr.childCount; j++) {
              const c = attr.child(j)!;
              if (c.type === "attribute_name" && c.text === "lang") {
                isLang = true;
              } else if (c.type === "quoted_attribute_value" || c.type === "attribute_value") {
                valNode = c;
              }
            }
            if (isLang && valNode) {
              let val = valNode.text;
              if (valNode.type === "quoted_attribute_value") {
                for (let k = 0; k < valNode.childCount; k++) {
                  const sub = valNode.child(k)!;
                  if (sub.type === "attribute_value") {
                    val = sub.text;
                    break;
                  }
                }
              }
              val = val.replace(/['"]/g, "").trim();
              if (val === "ts" || val === "tsx" || val === "typescript") {
                isTypeScript = true;
              }
            }
          }
        }
      }

      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i)!;
        if (child.type === "raw_text") {
          scriptRanges.push({ start: child.startIndex, end: child.endIndex });
        }
      }
    }

    for (let i = 0; i < node.childCount; i++) {
      walk(node.child(i)!);
    }
  }

  walk(tree.rootNode);

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
