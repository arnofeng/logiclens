import { entityId } from "../../utils/path.js";
import { confidenceFor } from "../../confidence.js";
import type { ContractExtractor } from "../../plugins/types.js";
import {
  classifySharedContract,
  contract,
  createCrossRepoExtraction,
  evidence,
  isParsedCodeFile,
  pushContractEvidence,
  toBusinessEntityName,
  toFactBundle
} from "./shared.js";

export const sharedSymbolExtractor: ContractExtractor = {
  name: "builtin:shared-symbol",
  extract(context) {
    const result = createCrossRepoExtraction();
    for (const file of context.parsedFiles.filter(isParsedCodeFile)) {
      for (const symbol of file.symbols) {
        const sharedKind = classifySharedContract(symbol.name, symbol.kind);
        if (!sharedKind) continue;
        const sharedContract = contract(sharedKind, symbol.name, `${sharedKind.toUpperCase()} ${symbol.name}`);
        const evidenceNode = evidence({
          repoId: file.repoId,
          fileId: file.fileId,
          filePath: file.path,
          line: symbol.startLine,
          raw: symbol.signature,
          rule: `${sharedKind}-symbol`,
          confidence: confidenceFor("heuristic-shared-symbol")
        });
        pushContractEvidence(result, file.repoId, sharedContract, "shared", evidenceNode);
        const entityName = toBusinessEntityName(sharedContract);
        if (entityName) {
          result.entities.push({ id: entityId(entityName), name: entityName, kind: "domain", description: "Domain entity inferred from cross-repo contracts" });
          result.contractEntities.push({ contractId: sharedContract.id, entityId: entityId(entityName), evidenceId: evidenceNode.id, confidence: evidenceNode.confidence });
        }
      }
    }
    return toFactBundle(result);
  }
};
