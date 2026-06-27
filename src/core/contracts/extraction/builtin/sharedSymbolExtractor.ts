import { entityId } from "../../../../shared/path.js";
import { confidenceFor } from "../../../../shared/confidence.js";
import type { ContractExtractor } from "../../../../interfaces/plugins/types.js";
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

/**
 * Languages that have a dedicated schema extractor producing higher-confidence
 * `SchemaSpec` results.  For these languages the shared-symbol extractor skips
 * `schema` and `dto` kinds to avoid duplicate low-confidence evidence.
 */
const LANGUAGES_WITH_SCHEMA_EXTRACTOR = new Set(["typescript", "tsx", "java", "python", "go"]);

export const sharedSymbolExtractor: ContractExtractor = {
  name: "builtin:shared-symbol",
  extract(context) {
    const result = createCrossRepoExtraction();
    for (const file of context.parsedFiles.filter(isParsedCodeFile)) {
      for (const symbol of file.symbols) {
        const sharedKind = classifySharedContract(symbol.name, symbol.kind);
        if (!sharedKind) continue;

        // Dedicated schema extractors (tsSchemaExtractor / javaSchemaExtractor)
        // handle schema + dto for TS/TSX/Java with higher confidence.  Skip
        // those kinds here to avoid duplicate low-confidence evidence records.
        if (
          (sharedKind === "schema" || sharedKind === "dto") &&
          LANGUAGES_WITH_SCHEMA_EXTRACTOR.has(file.language)
        ) {
          continue;
        }

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
