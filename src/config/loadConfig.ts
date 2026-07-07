import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import {
  configSchema,
  type AppConfig
} from "./schema.js";
import { configFileCandidates, configFilePath } from "../shared/branding.js";

export const configPath = (cwd = process.cwd()): string => configFilePath(cwd);

export async function resolveConfigPath(cwd = process.cwd()): Promise<string> {
  for (const file of configFileCandidates(cwd)) {
    try {
      await fs.access(file);
      return file;
    } catch {
      // Try the next branded or legacy location.
    }
  }
  return configPath(cwd);
}

function resolveEnvVars(value: any): any {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Za-z0-9_]+)\}/g, (_, name) => process.env[name] ?? "");
  }
  if (Array.isArray(value)) {
    return value.map(resolveEnvVars);
  }
  if (typeof value === "object") {
    const result: any = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = resolveEnvVars(v);
    }
    return result;
  }
  return value;
}

export async function loadConfig(cwd = process.cwd()): Promise<AppConfig> {
  const file = await resolveConfigPath(cwd);
  const raw = await fs.readFile(file, "utf8");
  const parsed = YAML.parse(raw);

  // Plaintext API key warnings
  if (parsed?.llm?.apiKey && typeof parsed.llm.apiKey === "string" && !parsed.llm.apiKey.startsWith("${") && parsed.llm.apiKey !== "") {
    console.warn(`[WARNING] Storing plaintext API keys in configuration is not recommended. Please consider using environment variables or references like '\${OPENAI_API_KEY}' for better security.`);
  }
  if (parsed?.embedding?.apiKey && typeof parsed.embedding.apiKey === "string" && !parsed.embedding.apiKey.startsWith("${") && parsed.embedding.apiKey !== "") {
    console.warn(`[WARNING] Storing plaintext API keys in configuration is not recommended. Please consider using environment variables or references like '\${OPENAI_API_KEY}' for better security.`);
  }

  const resolved = resolveEnvVars(parsed);
  return configSchema.parse(resolved);
}

function pruneObject(obj: any, defaultObj: any): any {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== "object") {
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj;
  }
  const result: any = {};
  for (const [key, value] of Object.entries(obj)) {
    // Some fields we always preserve
    if (key === "systemName" || key === "repos") {
      result[key] = value;
      continue;
    }
    const defaultValue = defaultObj?.[key];
    if (value && typeof value === "object") {
      if (Array.isArray(value)) {
        if (defaultValue !== undefined && Array.isArray(defaultValue)) {
          if (JSON.stringify(value) !== JSON.stringify(defaultValue)) {
            result[key] = value;
          }
        } else {
          result[key] = value;
        }
      } else {
        const prunedChild = pruneObject(value, defaultValue);
        if (prunedChild !== undefined && Object.keys(prunedChild).length > 0) {
          result[key] = prunedChild;
        }
      }
    } else {
      if (value !== defaultValue) {
        result[key] = value;
      }
    }
  }
  return result;
}

export function pruneConfig(config: AppConfig): any {
  const defaultVal = configSchema.parse({});
  return pruneObject(config, defaultVal);
}

function hasEnvVarRef(node: any): boolean {
  if (node === null || node === undefined) return false;
  if (typeof node === "string" && node.includes("${")) return true;
  if (YAML.isScalar(node) && typeof node.value === "string" && node.value.includes("${")) return true;
  if (YAML.isMap(node)) {
    if (node.items) {
      for (const item of node.items) {
        if (YAML.isPair(item) && hasEnvVarRef(item.value)) return true;
      }
    }
  }
  if (YAML.isSeq(node)) {
    if (node.items) {
      for (const item of node.items) {
        if (hasEnvVarRef(item)) return true;
      }
    }
  }
  return false;
}

function syncDocument(doc: YAML.Document, docMap: YAML.YAMLMap, obj: any) {
  const docKeys = new Set<string>();
  if (docMap.items) {
    for (const item of docMap.items) {
      if (YAML.isPair(item) && YAML.isScalar(item.key)) {
        docKeys.add(String(item.key.value));
      }
    }
  }

  for (const [key, value] of Object.entries(obj)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      if (!docMap.has(key)) {
        docMap.set(key, doc.createNode({}));
      }
      const child = docMap.get(key);
      if (YAML.isMap(child)) {
        syncDocument(doc, child as YAML.YAMLMap, value);
      } else {
        docMap.set(key, value);
      }
    } else {
      const existing = docMap.get(key);
      let keepExisting = false;
      if (typeof existing === "string" && existing.includes("${")) {
        const resolvedExisting = resolveEnvVars(existing);
        if (resolvedExisting === value) {
          keepExisting = true;
        }
      } else if (YAML.isScalar(existing) && typeof existing.value === "string" && existing.value.includes("${")) {
        const resolvedExisting = resolveEnvVars(existing.value);
        if (resolvedExisting === value) {
          keepExisting = true;
        }
      }
      if (!keepExisting) {
        docMap.set(key, value);
      }
    }
    docKeys.delete(key);
  }

  for (const key of docKeys) {
    const existing = docMap.get(key);
    if (!hasEnvVarRef(existing)) {
      docMap.delete(key);
    }
  }
}

export async function writeConfig(config: AppConfig, cwd = process.cwd()): Promise<void> {
  const file = await resolveConfigPath(cwd);
  await fs.mkdir(path.dirname(file), { recursive: true });

  let raw = "";
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    // Ignore, file doesn't exist yet
  }

  const doc = YAML.parseDocument(raw);
  if (!doc.contents || !YAML.isMap(doc.contents)) {
    doc.contents = doc.createNode({}) as any;
  }

  const pruned = pruneConfig(config);
  syncDocument(doc, doc.contents as YAML.YAMLMap, pruned);

  await fs.writeFile(file, doc.toString(), "utf8");
}

export function defaultConfig(): AppConfig {
  return configSchema.parse({});
}
