import { entityId, normalizeName } from "../../utils/path.js";
import { confidenceFor } from "../../confidence.js";
import type { ContractRole } from "../../parsers/types.js";
import type { ContractExtractor } from "../../plugins/types.js";
import {
  contract,
  createCrossRepoExtraction,
  evidence,
  isParsedCodeFile,
  operationVerb,
  pushContractEvidence,
  toBusinessEntityName,
  toFactBundle
} from "./shared.js";
import {
  parseJsAst,
  walkAst,
  callArguments,
  resolveAstExpression
} from "./jsAstUtils.js";

const EVENT_METHODS = new Set(["publish", "emit", "send", "subscribe", "on", "consume"]);

export const eventExtractor: ContractExtractor = {
  name: "builtin:event",
  extract(context) {
    const result = createCrossRepoExtraction();
    for (const file of context.parsedFiles.filter(isParsedCodeFile)) {
      if (!(file.language === "typescript" || file.language === "tsx" || file.language === "javascript" || file.language === "jsx" || file.language === "vue")) continue;

      const ast = parseJsAst(file);
      if (!ast) continue;

      walkAst(ast.tree.rootNode, (node) => {
        if (node.type !== "call_expression") return;

        const fn = node.childForFieldName("function");
        if (!fn) return;

        if (fn.type !== "member_expression") return;
        const methodName = fn.childForFieldName("property")?.text;

        if (!methodName || !EVENT_METHODS.has(methodName)) return;

        const args = callArguments(node);
        if (args.length === 0) return;

        const resolved = resolveAstExpression(args[0]!, new Map());
        if (resolved.dynamic || !resolved.value) return;

        const eventTopic = resolved.value;
        const eventContract = contract("event", eventTopic, `Event topic ${eventTopic}`);
        const role: ContractRole = (methodName === "subscribe" || methodName === "on" || methodName === "consume")
          ? "consumer"
          : "producer";

        const line = node.startPosition.row + 1;
        const evidenceNode = evidence({
          repoId: file.repoId,
          fileId: file.fileId,
          filePath: file.path,
          line,
          raw: node.text,
          rule: role === "producer" ? "event-publisher" : "event-consumer",
          confidence: confidenceFor("probable-event")
        });

        pushContractEvidence(result, file.repoId, eventContract, role, evidenceNode);
        const entityName = toBusinessEntityName(eventContract);
        if (entityName) {
          result.entities.push({ id: entityId(entityName), name: entityName, kind: "domain", description: "Domain entity inferred from cross-repo contracts" });
          result.contractEntities.push({ contractId: eventContract.id, entityId: entityId(entityName), evidenceId: evidenceNode.id, confidence: evidenceNode.confidence });
          const operationId = `operation:${normalizeName(`${operationVerb(eventContract, role)}:${entityName}:${eventContract.key}:${file.repoId}`)}`;
          result.operations.push({ id: operationId, verb: operationVerb(eventContract, role), entityName, description: `${role} ${eventContract.kind} ${eventContract.key}` });
          result.operationRepos.push({ operationId, repoId: file.repoId, role, evidenceId: evidenceNode.id, confidence: evidenceNode.confidence });
        }
      });
    }
    return toFactBundle(result);
  }
};
