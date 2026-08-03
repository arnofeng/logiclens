import { defineBuiltinExtractor } from "./defineBuiltinExtractor.js";
import type Parser from "tree-sitter";
import type { FactCollector } from "../factCollector.js";
import { confidenceFor } from "../../../../shared/confidence.js";
import { parsedCodeFiles, pushEventContract } from "./shared.js";
import { findContainingSymbol, indexedSourceAstNodes, namedChildren, parseSourceAst } from "./sourceAstUtils.js";
import type { EventBroker } from "../../event.js";

/** Exact AST/API patterns supported by deterministic Java event discovery. */
export const JAVA_EVENT_PATTERNS = [
  "@EventListener(payload-parameter)",
  "@TransactionalEventListener(payload-parameter)",
  "@KafkaListener(topics=..., payload-parameter)",
  "@RabbitListener(queues=..., payload-parameter)",
  "ApplicationEventPublisher.publishEvent(payload)",
  "KafkaTemplate.send(topic,payload)",
  "KafkaTemplate.send(topic,key,payload)",
  "RabbitTemplate.convertAndSend(routingKey,payload)",
  "RabbitTemplate.convertAndSend(exchange,routingKey,payload)",
  "AmqpTemplate.send(destination,Message)"
] as const;

type ParameterSlot = { index: number; name?: string; type: string };
type Receiver = { broker: EventBroker | "application"; payloadType?: string };

const INFRASTRUCTURE_TYPES = new Set([
  "Acknowledgment", "Acknowledgement", "Headers", "MessageHeaders", "Header", "Metadata",
  "Consumer", "ConsumerRecord", "ConsumerRecords", "Message", "Channel", "Envelope",
  "AmqpHeaders", "KafkaHeaders", "Delivery", "StreamObserver"
]);

function simpleName(raw: string): string {
  return raw.replace(/<.*>/su, "").replace(/\[\]$/u, "").trim().split(".").at(-1) ?? raw;
}

function isInfrastructure(type: string): boolean {
  return INFRASTRUCTURE_TYPES.has(simpleName(type));
}

function methodParameters(node: Parser.SyntaxNode): ParameterSlot[] {
  const parameters = node.childForFieldName("parameters");
  if (!parameters) return [];
  return namedChildren(parameters)
    .filter((parameter) => parameter.type === "formal_parameter" || parameter.type === "spread_parameter")
    .map((parameter, index) => ({
      index,
      name: parameter.childForFieldName("name")?.text,
      type: parameter.childForFieldName("type")?.text.replace(/\s+/gu, " ").trim() ?? ""
    }))
    .filter((parameter) => Boolean(parameter.type));
}

function annotationText(node: Parser.SyntaxNode, names: readonly string[]): string | undefined {
  const modifiers = node.namedChildren.find((child) => child.type === "modifiers");
  return modifiers?.namedChildren.find((child) => {
    if (child.type !== "annotation" && child.type !== "marker_annotation") return false;
    const name = child.namedChildren[0]?.text.split(".").at(-1);
    return Boolean(name && names.includes(name));
  })?.text;
}

function annotationTopics(text: string, property: string): string[] {
  const named = new RegExp(`\\b${property}\\s*=\\s*(\\{[^}]*\\}|\"[^\"]*\")`, "u").exec(text)?.[1];
  const positional = /\(\s*(\{[^}]*\}|"[^"]*")/u.exec(text)?.[1];
  return [...(named ?? positional ?? "").matchAll(/"([^"$#{}]+)"/gu)].map((match) => match[1]!).filter(Boolean);
}

function call(node: Parser.SyntaxNode): { object?: string; method?: string; args: Parser.SyntaxNode[] } | undefined {
  if (node.type !== "method_invocation") return undefined;
  const argumentsNode = node.childForFieldName("arguments");
  return {
    object: node.childForFieldName("object")?.text?.replace(/^this\./u, ""),
    method: node.childForFieldName("name")?.text,
    args: argumentsNode ? namedChildren(argumentsNode) : []
  };
}

function stringValue(node: Parser.SyntaxNode | undefined): string | undefined {
  return node?.type === "string_literal" ? node.text.slice(1, -1) : undefined;
}

function declaredVariables(ast: ReturnType<typeof parseSourceAst>): { types: Map<string, string>; receivers: Map<string, Receiver> } {
  const types = new Map<string, string>();
  const receivers = new Map<string, Receiver>();
  if (!ast) return { types, receivers };
  for (const node of indexedSourceAstNodes(ast, ["field_declaration", "local_variable_declaration"])) {
    const type = node.childForFieldName("type")?.text ?? node.namedChildren.find((child) => /type/u.test(child.type))?.text;
    if (!type) continue;
    for (const declarator of node.namedChildren.filter((child) => child.type === "variable_declarator")) {
      const name = declarator.childForFieldName("name")?.text;
      if (!name) continue;
      types.set(name, type);
      const genericArgs = /<([\s\S]+)>/u.exec(type)?.[1]?.split(",").map((part) => part.trim());
      if (/\bKafkaTemplate\b/u.test(type)) receivers.set(name, { broker: "kafka", payloadType: genericArgs?.at(-1) });
      else if (/\b(?:RabbitTemplate|AmqpTemplate)\b/u.test(type)) receivers.set(name, { broker: "rabbitmq" });
      else if (/\bApplicationEventPublisher\b/u.test(type)) receivers.set(name, { broker: "application" });
    }
  }
  return { types, receivers };
}

function expressionType(node: Parser.SyntaxNode | undefined, variables: Map<string, string>): string | undefined {
  if (!node) return undefined;
  if (node.type === "object_creation_expression") return node.childForFieldName("type")?.text;
  if (node.type === "identifier") {
    let owner: Parser.SyntaxNode | null = node.parent;
    while (owner && owner.type !== "method_declaration") owner = owner.parent;
    const parameter = owner ? methodParameters(owner).find((slot) => slot.name === node.text) : undefined;
    return parameter?.type ?? variables.get(node.text);
  }
  const builder = /\b([A-Za-z_$][\w$.]*)\.newBuilder\s*\(/u.exec(node.text)?.[1];
  if (builder) return builder;
  const cast = /^\(\s*([A-Za-z_$][\w$.]*(?:<[^>]+>)?)\s*\)/u.exec(node.text)?.[1];
  return cast;
}

export const javaEventExtractor = defineBuiltinExtractor({
  name: "builtin:java-event",
  languages: ["java"],
  frameworks: ["java:spring-events", "java:spring-kafka", "java:spring-amqp"],
  extract(context, collector: FactCollector) {
    for (const file of parsedCodeFiles(context.parsedFiles)) {
      if (file.language !== "java") continue;
      const ast = parseSourceAst(file, "java");
      if (!ast) continue;
      const { types, receivers } = declaredVariables(ast);

      for (const method of indexedSourceAstNodes(ast, ["method_declaration"])) {
        const listener = annotationText(method, ["EventListener", "TransactionalEventListener", "KafkaListener", "RabbitListener"]);
        if (!listener) continue;
        const annotation = /@(?:[\w$.]+\.)?(EventListener|TransactionalEventListener|KafkaListener|RabbitListener)\b/u.exec(listener)?.[1];
        if (!annotation) continue;
        const broker: EventBroker = annotation === "KafkaListener" ? "kafka" : annotation === "RabbitListener" ? "rabbitmq" : "unknown";
        const parameters = methodParameters(method);
        const payloadCandidates = parameters.filter((parameter) => !isInfrastructure(parameter.type));
        const payload = payloadCandidates.length === 1 ? payloadCandidates[0] : undefined;
        const topics = annotation === "KafkaListener" ? annotationTopics(listener, "topics")
          : annotation === "RabbitListener" ? annotationTopics(listener, "queues")
          : payload ? [payload.type] : [annotation];
        for (const topic of topics) {
          pushEventContract({
            collector, file, topic, role: "consumer", broker, framework: annotation,
            payloadType: payload?.type,
            payloadSlot: payload ? { index: payload.index, name: payload.name } : undefined,
            payloadInference: payload ? "resolved" : payloadCandidates.length > 1 ? "ambiguous" : "unsupported",
            topicConfidence: annotation === "KafkaListener" || annotation === "RabbitListener" ? 1 : 0.95,
            line: method.startPosition.row + 1, raw: listener, rule: `java-event-listener:${annotation}`,
            confidence: confidenceFor("exact-event-annotation"), sourceSymbolId: findContainingSymbol(file.symbols, method)?.id
          });
        }
      }

      for (const node of indexedSourceAstNodes(ast, ["method_invocation"])) {
        const invocation = call(node);
        const receiver = invocation?.object ? receivers.get(invocation.object) : undefined;
        if (!invocation?.method || !receiver) continue;
        let topic: string | undefined;
        let payloadNode: Parser.SyntaxNode | undefined;
        if (receiver.broker === "application" && invocation.method === "publishEvent" && invocation.args.length === 1) {
          payloadNode = invocation.args[0];
        } else if (receiver.broker === "kafka" && invocation.method === "send" && (invocation.args.length === 2 || invocation.args.length === 3)) {
          topic = stringValue(invocation.args[0]);
          payloadNode = invocation.args.at(-1);
        } else if (receiver.broker === "rabbitmq" && invocation.method === "convertAndSend" && (invocation.args.length === 2 || invocation.args.length === 3)) {
          topic = stringValue(invocation.args.at(-2));
          payloadNode = invocation.args.at(-1);
        } else if (receiver.broker === "rabbitmq" && invocation.method === "send" && invocation.args.length === 2) {
          topic = stringValue(invocation.args[0]);
          payloadNode = invocation.args[1];
        } else continue;
        const payloadType = expressionType(payloadNode, types) ?? receiver.payloadType;
        topic ??= payloadType;
        if (!topic || topic.includes("${") || topic.includes("#{")) continue;
        const symbol = findContainingSymbol(file.symbols, node);
        pushEventContract({
          collector, file, topic, role: "producer", broker: receiver.broker === "application" ? "unknown" : receiver.broker,
          framework: receiver.broker === "application" ? "spring-events" : receiver.broker,
          payloadType, payloadSlot: { index: invocation.args.indexOf(payloadNode!) },
          payloadInference: payloadType ? "resolved" : "unresolved", topicConfidence: stringValue(invocation.args[0]) ? 1 : 0.95,
          line: node.startPosition.row + 1, raw: node.text, rule: `java-event-producer:${invocation.method}`,
          confidence: confidenceFor("exact-parser-route"), sourceSymbolId: symbol?.id
        });
      }
    }
  }
});
