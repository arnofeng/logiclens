import { compatExtractor } from "./compat.js";
import { entityId } from "../../../../shared/path.js";
import { confidenceFor } from "../../../../shared/confidence.js";
import type { FactCollector } from "../factCollector.js";
import {
  contract,
  evidence,
  parsedCodeFiles,
  pushContractEvidence,
  toBusinessEntityName, } from "./shared.js";

export const sharedSymbolExtractor = compatExtractor({
  name: "builtin:shared-symbol",
  extract(context, collector: FactCollector) {
    for (const file of parsedCodeFiles(context.parsedFiles)) {
      for (const symbol of file.symbols) {
        const sharedKind = symbol.kind === "enum" || /Enum$/u.test(symbol.name)
          ? "enum" as const
          : /Config$/u.test(symbol.name)
            ? "config" as const
            : undefined;
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
