import { compatExtractor } from "./compat.js";
import { confidenceFor } from "../../../../shared/confidence.js";
import type { ContractRole } from "../../../parsing/types.js";
import type { FactCollector } from "../factCollector.js";
import {
  evidence,
  isParsedCodeFile,
  pushEventContract, } from "./shared.js";
import {
  parseJsAst,
  walkAst,
  callArguments,
  resolveAstExpression,
  staticPropertyPath
} from "./jsAstUtils.js";
import { inferBrokerFromCallee, inferBrokerFromImports, inferPayloadType, inferPayloadFromHandler, type EventBroker } from "../../event.js";

const EVENT_METHODS = new Set(["publish", "emit", "send", "subscribe", "on", "consume"]);
const CONSUMER_METHODS = new Set(["subscribe", "on", "consume"]);
// Generic method names that also have countless non-event meanings
// (`res.send`, `process.on`, `el.emit`). These only count as events when an
// independent signal — a recognized broker receiver or a messaging-library
// import — confirms it, so they are import-gated below.
const GENERIC_METHODS = new Set(["send", "on", "emit"]);

// Framework column mirrors the broker; left unset (not the literal "unknown")
// when no broker is known, matching how HTTP specs normalize an empty framework.
function eventFramework(broker: EventBroker): string | undefined {
  return broker !== "unknown" ? broker : undefined;
}

export const eventExtractor = compatExtractor({
  name: "builtin:event",
  extract(context, collector: FactCollector) {
    for (const file of context.parsedFiles.filter(isParsedCodeFile)) {
      if (!(file.language === "typescript" || file.language === "tsx" || file.language === "javascript" || file.language === "jsx" || file.language === "vue")) continue;

      const ast = parseJsAst(file);
      if (!ast) continue;

      const importBroker = inferBrokerFromImports(file.imports);

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

        const role: ContractRole = CONSUMER_METHODS.has(methodName) ? "consumer" : "producer";

        const receiverNode = fn.childForFieldName("object");
        const receiver = receiverNode ? staticPropertyPath(receiverNode) : undefined;
        const calleeBroker = inferBrokerFromCallee(receiver);
        // Broker from the receiver name is most specific; fall back to the
        // file's messaging-library import. Either is also the import-gate.
        const broker = calleeBroker !== "unknown" ? calleeBroker : importBroker;

        // Import gate: generic method names (`send`/`on`/`emit`) only count as
        // events when a broker signal is present, filtering out `res.send()` /
        // `process.on()`. Specific names (`publish`/`subscribe`/`consume`) pass.
        if (GENERIC_METHODS.has(methodName) && broker === "unknown") return;

        const framework = eventFramework(broker);

        // Producers pass the payload positionally (args[1]); consumers pass a
        // handler callback there instead, so the payload type is read from the
        // handler's first parameter annotation. An explicit type argument
        // (`publish<T>(...)` / `consume<T>(...)`) takes priority on both sides.
        const payloadArg = role === "producer" ? args[1] : undefined;
        const payloadType = inferPayloadType({ payloadArg, typeArguments: node.childForFieldName("type_arguments") })
          ?? (role === "consumer" ? inferPayloadFromHandler(args[1]) : undefined);

        const line = node.startPosition.row + 1;
        pushEventContract({
          collector,
          file,
          topic: resolved.value,
          role,
          broker,
          framework,
          payloadType,
          line,
          raw: node.text,
          rule: role === "producer" ? "event-publisher" : "event-consumer",
          confidence: confidenceFor("probable-event")
        });

        // Degradation audit: a payload argument is present but could not be
        // resolved to a named type (dynamic construction / bare reference).
        // Anonymous object/array literals are valid inline payloads, not unresolved.
        if (!payloadType && payloadArg && payloadArg.type !== "object" && payloadArg.type !== "array") {
          collector.addEvidence(evidence({
            repoId: file.repoId,
            fileId: file.fileId,
            filePath: file.path,
            line,
            raw: `${node.text} // unresolved: payload-type-unresolvable`,
            rule: "payload-type-unresolvable",
            confidence: 0
          }));
        }
      });
    }
  }
});
