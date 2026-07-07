import { compatExtractor } from "./compat.js";
import type Parser from "tree-sitter";
import type { AnnotationFact } from "../../../parsing/facts.js";
import type { ParsedFile } from "../../../parsing/types.js";
import type { FactCollector } from "../factCollector.js";
import { confidenceFor } from "../../../../shared/confidence.js";
import {
  parsedCodeFiles,
  pushEventContract, } from "./shared.js";
import { findContainingSymbol, namedChildren, parseSourceAst, walkSourceAst } from "./sourceAstUtils.js";
import { inferBrokerFromImports, type EventBroker } from "../../event.js";

// Listener annotations carry the topic/queue as a string argument, so they are
// the highest-precision event signal in Java. `@EventListener`/`@StreamListener`
// encode the topic as a parameter *type* (no string), which needs type
// resolution (deferred), so they are intentionally out of scope here.
const LISTENER_ANNOTATIONS: Record<string, { broker: EventBroker; topicArgs: string[] }> = {
  KafkaListener: { broker: "kafka", topicArgs: ["topics"] },
  RabbitListener: { broker: "rabbitmq", topicArgs: ["queues"] }
};

// Producer template methods â†?topic is the first string literal argument.
// `broker` is set only when the method name is broker-specific; `send` is
// ambiguous (kafkaTemplate / streamBridge / amqpTemplate all expose it) so it
// defers to the receiver name or the file's imported broker instead.
const PRODUCER_METHODS: Record<string, EventBroker | undefined> = {
  send: undefined,           // kafkaTemplate.send(...) / streamBridge.send(...) / amqpTemplate.send(...)
  convertAndSend: "rabbitmq" // rabbitTemplate.convertAndSend("exchange"/"routingKey", payload)
};

function javaStringValue(node: Parser.SyntaxNode | undefined): string | undefined {
  if (!node || node.type !== "string_literal") return undefined;
  return node.text.replace(/^["']|["']$/g, "");
}

/** A topic value is usable only if it is a concrete string, not a `${...}` / `#{...}` placeholder. */
function isConcreteTopic(value: string): boolean {
  return value.length > 0 && !value.includes("${") && !value.includes("#{");
}

/** Parses an annotation topic argument, unwrapping the `{"a","b"}` array form (serialized as JSON). */
function topicsFromAnnotation(annotation: AnnotationFact, argNames: string[]): string[] {
  const arg = annotation.arguments.find((a) => a.name && argNames.includes(a.name))
    ?? annotation.arguments.find((a) => !a.name);
  if (!arg) return [];
  const raw = arg.value.trim();
  let values: string[];
  if (raw.startsWith("[")) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      values = Array.isArray(parsed) ? parsed.map(String) : [raw];
    } catch {
      values = [raw];
    }
  } else {
    values = [raw];
  }
  return values.filter(isConcreteTopic);
}

function javaMethodCall(node: Parser.SyntaxNode): { object?: string; method?: string; args: Parser.SyntaxNode[] } | undefined {
  if (node.type !== "method_invocation") return undefined;
  const object = node.childForFieldName("object");
  const name = node.childForFieldName("name");
  const argsNode = node.childForFieldName("arguments");
  return { object: object?.text, method: name?.text, args: argsNode ? namedChildren(argsNode) : [] };
}

export const javaEventExtractor = compatExtractor({
  name: "builtin:java-event",
  languages: ["java"],
  frameworks: ["java:spring-kafka", "java:spring-amqp"],
  extract(context, collector: FactCollector) {
    for (const file of parsedCodeFiles(context.parsedFiles)) {
      if (file.language !== "java") continue;

      // Consumer side: annotation-driven, unambiguous.
      for (const annotation of file.facts?.annotations ?? []) {
        const config = LISTENER_ANNOTATIONS[annotation.name];
        if (!config) continue;
        for (const topic of topicsFromAnnotation(annotation, config.topicArgs)) {
          pushEventContract({
            collector,
            file,
            topic,
            role: "consumer",
            broker: config.broker,
            framework: config.broker,
            line: annotation.line,
            raw: annotation.raw,
            rule: "java-event-listener",
            confidence: confidenceFor("exact-event-annotation"),
            sourceSymbolId: annotation.ownerSymbolId
          });
        }
      }

      // Producer side: template call, import-gated.
      const importBroker = inferBrokerFromImports(file.imports);
      if (importBroker === "unknown") continue;

      const ast = parseSourceAst(file, "java");
      if (!ast) continue;

      walkSourceAst(ast.tree.rootNode, (node) => {
        const call = javaMethodCall(node);
        if (!call?.method || !(call.method in PRODUCER_METHODS)) return;

        const topic = javaStringValue(call.args.find((arg) => javaStringValue(arg) !== undefined));
        if (!topic || !isConcreteTopic(topic)) return;

        const methodBroker = PRODUCER_METHODS[call.method];
        // A kafka receiver name overrides everything; then a broker-specific
        // method name (convertAndSend â†?rabbitmq); otherwise trust the import.
        const broker = call.object?.toLowerCase().includes("kafka") ? "kafka" : (methodBroker ?? importBroker);
        const symbol = findContainingSymbol(file.symbols, node);
        pushEventContract({
          collector,
          file,
          topic,
          role: "producer",
          broker,
          framework: broker,
          line: node.startPosition.row + 1,
          raw: node.text,
          rule: "java-event-producer",
          confidence: confidenceFor("probable-event"),
          sourceSymbolId: symbol?.id
        });
      });
    }
  }
});
