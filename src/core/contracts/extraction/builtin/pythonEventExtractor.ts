import { compatExtractor } from "./compat.js";
import type Parser from "tree-sitter";
import type { ParsedFile } from "../../../parsing/types.js";
import type { ContractExtractor } from "../../../plugins/types.js";
import type { FactCollector } from "../factCollector.js";
import { confidenceFor } from "../../../../shared/confidence.js";
import {
  isParsedCodeFile,
  pushEventContract, } from "./shared.js";
import {
  attributeParts,
  callArguments,
  findContainingSymbol,
  namedChildren,
  parseSourceAst,
  stringLiteralValue,
  walkSourceAst
} from "./sourceAstUtils.js";
import { inferBrokerFromImports, type EventBroker } from "../../event.js";

type TopicSource = "first" | "kw:routing_key" | "kw:queue";

// Producer-side call methods. `broker` when set is implied by the method name;
// otherwise it falls back to the file's import-derived broker.
const PRODUCER_CALLS: Record<string, { broker?: EventBroker; topic: TopicSource }> = {
  send: { topic: "first" },                       // kafka-python / aiokafka
  produce: { broker: "kafka", topic: "first" },   // confluent_kafka
  basic_publish: { broker: "rabbitmq", topic: "kw:routing_key" }, // pika
  publish: { broker: "redis-stream", topic: "first" },            // redis pub/sub
  xadd: { broker: "redis-stream", topic: "first" }                // redis streams
};

const CONSUMER_CALLS: Record<string, { broker?: EventBroker; topic: TopicSource }> = {
  subscribe: { topic: "first" },                                  // kafka consumer
  basic_consume: { broker: "rabbitmq", topic: "kw:queue" }        // pika
};

function pythonCall(node: Parser.SyntaxNode): { object?: string; method?: string; node: Parser.SyntaxNode } | undefined {
  if (node.type !== "call") return undefined;
  const fn = node.childForFieldName("function") ?? node.namedChild(0);
  if (!fn || fn.type !== "attribute") return undefined;
  const { object, property } = attributeParts(fn);
  return { object, method: property, node };
}

function keywordArgValue(callNode: Parser.SyntaxNode, name: string): Parser.SyntaxNode | undefined {
  const argsList = callNode.childForFieldName("arguments");
  if (!argsList) return undefined;
  for (const child of namedChildren(argsList)) {
    if (child.type !== "keyword_argument") continue;
    if (child.childForFieldName("name")?.text === name) return child.childForFieldName("value") ?? undefined;
  }
  return undefined;
}

function firstPositionalArg(callNode: Parser.SyntaxNode): Parser.SyntaxNode | undefined {
  return callArguments(callNode).find((arg) => arg.type !== "keyword_argument");
}

/** Resolves a topic string from a positional arg, unwrapping a `["topic"]` list. */
function topicFromNode(node: Parser.SyntaxNode | undefined): string | undefined {
  if (!node) return undefined;
  if (node.type === "list") {
    const first = namedChildren(node)[0];
    return first ? stringLiteralValue(first) : undefined;
  }
  return stringLiteralValue(node);
}

function resolveTopic(callNode: Parser.SyntaxNode, source: TopicSource): string | undefined {
  if (source === "first") return topicFromNode(firstPositionalArg(callNode));
  if (source === "kw:routing_key") return topicFromNode(keywordArgValue(callNode, "routing_key"));
  return topicFromNode(keywordArgValue(callNode, "queue"));
}

function importsCelery(file: ParsedFile): boolean {
  return (file.imports ?? []).some((ref) => ref.module?.toLowerCase().includes("celery"));
}

function isCeleryTaskDecorator(name: string): boolean {
  const last = name.split(".").at(-1);
  return last === "task" || last === "shared_task";
}

export const pythonEventExtractor = compatExtractor({
  name: "builtin:python-event",
  languages: ["python"],
  frameworks: ["python:kafka", "python:pika", "python:redis", "python:celery"],
  extract(context, collector: FactCollector) {
    for (const file of context.parsedFiles.filter(isParsedCodeFile)) {
      if (file.language !== "python") continue;

      const importBroker = inferBrokerFromImports(file.imports);

      // Celery task handlers are consumers; gate on a celery import so a bare
      // `@task` on an unrelated helper is not mistaken for an event handler.
      if (importsCelery(file)) {
        for (const decorator of file.facts?.decorators ?? []) {
          if (!decorator.ownerSymbolId || !isCeleryTaskDecorator(decorator.name)) continue;
          const ownerSymbol = file.symbols.find((s) => s.id === decorator.ownerSymbolId);
          if (!ownerSymbol) continue;
          pushEventContract({
            collector,
            file,
            topic: ownerSymbol.name,
            role: "consumer",
            broker: "unknown",
            framework: "celery",
            line: decorator.line,
            raw: decorator.raw,
            rule: "python-celery-task",
            confidence: confidenceFor("exact-event-annotation"),
            sourceSymbolId: ownerSymbol.id
          });
        }
      }

      // Call-based producers/consumers are import-gated: only files that import
      // a known messaging library are scanned for generic `send`/`publish`/etc.
      if (importBroker === "unknown") continue;

      const ast = parseSourceAst(file, "python");
      if (!ast) continue;

      walkSourceAst(ast.tree.rootNode, (node) => {
        const call = pythonCall(node);
        if (!call?.method) return;

        const producer = PRODUCER_CALLS[call.method];
        const consumer = CONSUMER_CALLS[call.method];
        const config = producer ?? consumer;
        if (!config) return;

        const topic = resolveTopic(node, config.topic);
        if (!topic) return;

        const broker = config.broker ?? importBroker;
        const symbol = findContainingSymbol(file.symbols, node);
        pushEventContract({
          collector,
          file,
          topic,
          role: producer ? "producer" : "consumer",
          broker,
          framework: broker,
          line: node.startPosition.row + 1,
          raw: node.text,
          rule: producer ? "python-event-producer" : "python-event-consumer",
          confidence: confidenceFor("probable-event"),
          sourceSymbolId: symbol?.id
        });
      });
    }
  }
});
