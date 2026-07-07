import { compatExtractor } from "./compat.js";
import type { FactCollector } from "../factCollector.js";
import { parsedCodeFiles, pushGraphqlContract } from "./shared.js";
import { extractClientOperations, findGqlTemplateOccurrences } from "./graphqlSchema.js";
import { confidenceFor } from "../../../../shared/confidence.js";

export const graphqlClientExtractor = compatExtractor({
  name: "builtin:graphql-client",
  languages: ["javascript", "typescript", "jsx", "tsx", "vue", "graphql"],
  extract(context, collector: FactCollector) {
    for (const file of parsedCodeFiles(context.parsedFiles)) {
      if (!file.source) continue;

      if (file.language === "graphql") {
        const operations = extractClientOperations(file.source);
        for (const op of operations) {
          pushGraphqlContract({
            collector,
            file,
            operationType: op.operationType,
            field: op.fieldName,
            role: "consumer",
            line: op.line,
            raw: op.raw.slice(0, 160),
            rule: "graphql-client-file",
            confidence: confidenceFor("exact-parser-route"),
            source: "client-document",
            operationName: op.operationName
          });
        }
      } else {
        // JS/TS/Vue files: scan for gql`...` or graphql`...`
        const occurrences = findGqlTemplateOccurrences(file.source);
        for (const occ of occurrences) {
          const operations = extractClientOperations(occ.content);
          for (const op of operations) {
            pushGraphqlContract({
              collector,
              file,
              operationType: op.operationType,
              field: op.fieldName,
              role: "consumer",
              line: occ.line + op.line - 1,
              raw: op.raw.slice(0, 160),
              rule: "graphql-client-template",
              confidence: confidenceFor("probable-regex-route"),
              source: "client-document",
              operationName: op.operationName
            });
          }
        }
      }
    }
  }
});
