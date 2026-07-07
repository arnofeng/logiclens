import { compatExtractor } from "./compat.js";
import { entityId } from "../../../../shared/path.js";
import { confidenceFor } from "../../../../shared/confidence.js";
import type { FactCollector } from "../factCollector.js";
import {
  classifySharedContract,
  contract,
  evidence,
  parsedCodeFiles,
  pushContractEvidence,
  toBusinessEntityName, } from "./shared.js";

/**
 * Languages that have a dedicated schema extractor producing higher-confidence
 * `SchemaSpec` results.  For these languages the shared-symbol extractor skips
 * `schema` and `dto` kinds to avoid duplicate low-confidence evidence.
 */
const LANGUAGES_WITH_SCHEMA_EXTRACTOR = new Set(["typescript", "tsx", "java", "python", "go"]);

export const sharedSymbolExtractor = compatExtractor({
  name: "builtin:shared-symbol",
  extract(context, collector: FactCollector) {
    for (const file of parsedCodeFiles(context.parsedFiles)) {
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
        pushContractEvidence(collector, file.repoId, sharedContract, "shared", evidenceNode);
        const entityName = toBusinessEntityName(sharedContract);
        if (entityName) {
          collector.addEntity({ id: entityId(entityName), name: entityName, kind: "domain", description: "Domain entity inferred from cross-repo contracts" });
          collector.addContractEntity({ contractId: sharedContract.id, entityId: entityId(entityName), evidenceId: evidenceNode.id, confidence: evidenceNode.confidence });
        }
      }
    }
  }
});
