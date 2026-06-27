import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import type Parser from "tree-sitter";
import { confidenceFor } from "../../../../shared/confidence.js";
import type { ParsedFile } from "../../../parsing/types.js";
import type { ContractExtractor } from "../../../../plugins/types.js";
import {
  contract,
  createCrossRepoExtraction,
  evidence,
  isParsedCodeFile,
  pushContractEvidence,
  sourceLine,
  toFactBundle
} from "./shared.js";

import {
  parseJsAst,
  walkAst,
  callArguments,
  resolveAstExpression,
  stringLiteralValue
} from "./jsAstUtils.js";

const FILE_CONFIG_LANGUAGES = new Set(["yaml", "toml", "properties"]);
const KEY_PATTERN = /^[A-Z][A-Z0-9_]{2,}$|^[a-z][A-Za-z0-9_.-]+\.[A-Za-z0-9_.-]+$/;

type FileConfigKey = {
  key: string;
  line: number;
  raw: string;
};

function flattenYamlKeys(value: unknown, prefix = ""): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return prefix ? [prefix] : [];
  const result: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    const next = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === "object" && !Array.isArray(child)) {
      result.push(...flattenYamlKeys(child, next));
    } else {
      result.push(next);
    }
  }
  return result;
}

function lineForKey(source: string, key: string): { line: number; raw: string } {
  const segments = key.split(".");
  const leaf = segments[segments.length - 1] ?? key;
  const lines = source.split(/\r?\n/);
  const keyRe = new RegExp(`^\\s*${leaf.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[:=]`);
  const index = lines.findIndex((line) => keyRe.test(line));
  return {
    line: index >= 0 ? index + 1 : 1,
    raw: index >= 0 ? lines[index]!.trim() : key
  };
}

function parseYamlConfigKeys(source: string): FileConfigKey[] {
  const parsed = YAML.parse(source);
  return flattenYamlKeys(parsed).map((key) => ({ key, ...lineForKey(source, key) }));
}

function parsePropertiesConfigKeys(source: string): FileConfigKey[] {
  return source.split(/\r?\n/).flatMap((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("!")) return [];
    const match = trimmed.match(/^([^:=\s][^:=]*?)\s*[:=]/);
    return match?.[1] ? [{ key: match[1].trim(), line: index + 1, raw: trimmed }] : [];
  });
}

function parseTomlConfigKeys(source: string): FileConfigKey[] {
  let section = "";
  return source.split(/\r?\n/).flatMap((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return [];
    const sectionMatch = trimmed.match(/^\[([^\]]+)\]$/);
    if (sectionMatch?.[1]) {
      section = sectionMatch[1].trim();
      return [];
    }
    const keyMatch = trimmed.match(/^([A-Za-z0-9_.-]+)\s*=/);
    if (!keyMatch?.[1]) return [];
    const key = section ? `${section}.${keyMatch[1]}` : keyMatch[1];
    return [{ key, line: index + 1, raw: trimmed }];
  });
}

function parseFileConfigKeys(language: string, source: string): FileConfigKey[] {
  try {
    if (language === "yaml") return parseYamlConfigKeys(source);
    if (language === "properties") return parsePropertiesConfigKeys(source);
    if (language === "toml") return parseTomlConfigKeys(source);
  } catch {
    return [];
  }
  return [];
}

function pushConfigKey(result: ReturnType<typeof createCrossRepoExtraction>, file: ParsedFile, key: string, line: number, raw: string, rule: string, confidence: number): void {
  const configContract = contract("config", key, `Config key ${key}`);
  const evidenceNode = evidence({
    repoId: file.repoId,
    fileId: file.fileId,
    filePath: file.path,
    line,
    raw,
    rule,
    confidence
  });
  pushContractEvidence(result, file.repoId, configContract, "shared", evidenceNode);
}

function isProcessEnvMember(node: Parser.SyntaxNode | null): boolean {
  if (!node || node.type !== "member_expression") return false;
  const obj = node.childForFieldName("object");
  const prop = node.childForFieldName("property");
  return Boolean(obj && obj.text === "process" && prop && prop.text === "env");
}

export const envConfigExtractor: ContractExtractor = {
  name: "builtin:env-config",
  async extract(context) {
    const result = createCrossRepoExtraction();
    for (const file of context.parsedFiles.filter(isParsedCodeFile)) {
      if (FILE_CONFIG_LANGUAGES.has(file.language)) {
        const repo = context.repoResolver(file.repoId);
        if (!repo) continue;
        const source = await fs.readFile(path.join(repo.path, file.path), "utf8");
        for (const configKey of parseFileConfigKeys(file.language, source)) {
          pushConfigKey(result, file, configKey.key, configKey.line, configKey.raw, "config-file-key", confidenceFor("heuristic-config-file"));
        }
        continue;
      }

      // Check for JS/TS/Vue files to parse with AST
      const isJsLike = file.language === "typescript" ||
                       file.language === "tsx" ||
                       file.language === "javascript" ||
                       file.language === "jsx" ||
                       file.language === "vue";
      if (!isJsLike) continue;

      const ast = parseJsAst(file);
      if (!ast) continue;

      walkAst(ast.tree.rootNode, (node) => {
        // 7.2 process.env.KEY detection
        if (node.type === "member_expression") {
          const obj = node.childForFieldName("object");
          const prop = node.childForFieldName("property");
          if (prop && isProcessEnvMember(obj)) {
            const key = stringLiteralValue(prop) ?? prop.text;
            if (KEY_PATTERN.test(key)) {
              pushConfigKey(
                result,
                file,
                key,
                node.startPosition.row + 1,
                node.text,
                "config-key-reference",
                confidenceFor("heuristic-config-reference")
              );
            }
          }
        }

        if (node.type === "subscript_expression" && isProcessEnvMember(node.childForFieldName("object") ?? node.child(0))) {
          const indexNode = node.childForFieldName("index") ?? node.namedChild(1);
          const key = indexNode ? stringLiteralValue(indexNode) : undefined;
          if (key && KEY_PATTERN.test(key)) {
            pushConfigKey(
              result,
              file,
              key,
              node.startPosition.row + 1,
              node.text,
              "config-key-reference",
              confidenceFor("heuristic-config-reference")
            );
          }
        }

        // 7.3 config.get('KEY') detection
        if (node.type === "call_expression") {
          const fn = node.childForFieldName("function");
          if (fn && fn.type === "member_expression") {
            const obj = fn.childForFieldName("object");
            const prop = fn.childForFieldName("property");
            if (obj && obj.text === "config" && prop && prop.text === "get") {
              const args = callArguments(node);
              if (args.length > 0) {
                const resolved = resolveAstExpression(args[0]!, new Map());
                if (!resolved.dynamic && resolved.value) {
                  const key = resolved.value;
                  if (KEY_PATTERN.test(key)) {
                    pushConfigKey(
                      result,
                      file,
                      key,
                      node.startPosition.row + 1,
                      node.text,
                      "config-key-reference",
                      confidenceFor("heuristic-config-reference")
                    );
                  }
                }
              }
            }
          }
        }
      });
    }
    return toFactBundle(result);
  }
};
