import { canonicalContractKey } from "../contracts/extraction/crossRepoContracts.js";
import { contractId, evidenceId, normalizeName } from "../../shared/path.js";

export { canonicalContractKey };

export function createContractId(kind: string, key: string): string {
  return contractId(kind, key);
}

export function createEvidenceId(parts: string[]): string {
  return evidenceId(parts);
}

export function normalizeRuleName(sourceName: string, ruleName: string): string {
  return `${normalizeName(sourceName)}/${normalizeName(ruleName)}`;
}
