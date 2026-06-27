import { canonicalContractKey } from "../core/contracts/extraction/crossRepoContracts.js";
import { contractId, evidenceId, normalizeName } from "../shared/path.js";

export { canonicalContractKey };

/**
 * Creates a unique ID for a contract based on its kind and key.
 * 
 * @param kind - The kind of contract (e.g., "package", "api", "event").
 * @param key - The contract key (e.g., a package name, URL path, or event name).
 * @returns A unique contract node ID.
 */
export function createContractId(kind: string, key: string): string {
  return contractId(kind, key);
}

/**
 * Creates a unique ID for an evidence node by hashing the provided path/identity components.
 * 
 * @param parts - A list of unique components identifying the evidence (e.g., file ID, line number, relationship details).
 * @returns A unique evidence node ID.
 */
export function createEvidenceId(parts: string[]): string {
  return evidenceId(parts);
}

/**
 * Standardizes a plugin rule name, combining the plugin name and the rule name.
 * Normalizes case and special characters for consistency.
 * 
 * @param pluginName - The name of the plugin defining the rule.
 * @param ruleName - The name of the rule.
 * @returns The normalized, slash-separated plugin rule name (e.g. "my-plugin/my-rule").
 */
export function normalizePluginRuleName(pluginName: string, ruleName: string): string {
  return `${normalizeName(pluginName)}/${normalizeName(ruleName)}`;
}
