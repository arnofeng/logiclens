import type Parser from "tree-sitter";
import type { ImportRef } from "../parsing/types.js";
import type { EventSpec } from "./spec.js";

export type EventBroker = NonNullable<EventSpec["broker"]>;

/**
 * Mainstream messaging-library registry, keyed by substrings that appear in an
 * import module path. Used for import-gating: a generic method like
 * `send`/`on`/`emit` is only treated as an event when the file actually imports
 * a known broker library, which filters out `res.send()` / `process.on()` noise.
 *
 * Matching is substring + case-insensitive, so it spans naming variants across
 * languages: JS (`kafkajs`), Python (`confluent_kafka`), Go import paths
 * (`github.com/segmentio/kafka-go`) and Java packages (`org.springframework.kafka`).
 */
const BROKER_LIBRARIES: { match: string[]; broker: EventBroker }[] = [
  {
    broker: "kafka",
    // "kafka" as a substring covers kafka-python (`import kafka`), confluent_kafka,
    // aiokafka, kafka-go and kafkajs in one go; the rest catch sarama / NestJS.
    match: ["kafka", "@nestjs/microservices", "shopify/sarama", "/sarama"]
  },
  {
    broker: "rabbitmq",
    match: ["amqplib", "amqp-connection-manager", "pika", "amqp091", "org.springframework.amqp", "com.rabbitmq"]
  },
  {
    broker: "redis-stream",
    match: ["ioredis", "go-redis", "redis"]
  },
  {
    broker: "nats",
    match: ["nats"]
  }
];

/**
 * Infers the messaging broker from a file's imports (the import-gating signal).
 * Returns the first matching broker, or "unknown" when no known messaging
 * library is imported.
 */
export function inferBrokerFromImports(imports: ImportRef[] | undefined): EventBroker {
  if (!imports || imports.length === 0) return "unknown";
  for (const ref of imports) {
    const module = ref.module?.toLowerCase();
    if (!module) continue;
    for (const entry of BROKER_LIBRARIES) {
      if (entry.match.some((needle) => module.includes(needle))) return entry.broker;
    }
  }
  return "unknown";
}

/**
 * Canonical identity key for an event contract. Topics are case-insensitive
 * and whitespace-insensitive, mirroring `canonicalContractKey("event", ...)`.
 */
export function canonicalEventContractKey(topic: string): string {
  return topic.trim().toLowerCase();
}

/**
 * Infers the messaging broker from the call receiver (the object the
 * publish/subscribe method is invoked on), e.g. `kafkaProducer.send(...)`,
 * `rabbitChannel.publish(...)`, `redisStream.add(...)`. EventEmitter-style
 * receivers and anything else degrade to "unknown".
 */
export function inferBrokerFromCallee(receiver: string | undefined): EventBroker {
  if (!receiver) return "unknown";
  const r = receiver.toLowerCase();
  if (r.includes("kafka")) return "kafka";
  if (r.includes("rabbit") || r.includes("amqp")) return "rabbitmq";
  if (r.includes("redis")) return "redis-stream";
  return "unknown";
}

function baseTypeName(node: Parser.SyntaxNode): string | undefined {
  switch (node.type) {
    case "identifier":
    case "type_identifier":
    case "property_identifier":
      return node.text;
    case "generic_type": {
      const name = node.childForFieldName("name") ?? node.namedChild(0);
      return name ? baseTypeName(name) : undefined;
    }
    case "member_expression":
    case "nested_type_identifier": {
      const segment = node.text.split(".").pop();
      return segment || undefined;
    }
    default:
      return undefined;
  }
}

/**
 * Infers the named payload type for an event publish/subscribe call.
 *
 * Resolvable signals (in priority order):
 *  - explicit type argument: `publish<OrderCreatedEvent>(topic, payload)`
 *  - constructor expression: `publish(topic, new OrderCreatedEvent(...))`
 *  - type assertion: `publish(topic, payload as OrderCreatedEvent)`
 *
 * Anonymous object literals and dynamically constructed payloads are NOT
 * named types and return `undefined` (the caller decides whether to degrade).
 */
export function inferPayloadType(input: {
  payloadArg?: Parser.SyntaxNode;
  typeArguments?: Parser.SyntaxNode | null;
}): string | undefined {
  if (input.typeArguments) {
    const typeNode = input.typeArguments.namedChild(0);
    if (typeNode) {
      const name = baseTypeName(typeNode);
      if (name) return name;
    }
  }
  const payloadArg = input.payloadArg;
  if (!payloadArg) return undefined;
  if (payloadArg.type === "new_expression") {
    const ctor = payloadArg.childForFieldName("constructor");
    return ctor ? baseTypeName(ctor) : undefined;
  }
  if (payloadArg.type === "as_expression") {
    const typeNode = payloadArg.namedChild(payloadArg.namedChildCount - 1);
    return typeNode ? baseTypeName(typeNode) : undefined;
  }
  return undefined;
}

/**
 * Infers the payload type from a consumer-side handler's first parameter
 * annotation, e.g. `subscribe(topic, (msg: OrderCreatedEvent) => {})`. This
 * mirrors producer payload inference so producer/consumer specs for the same
 * topic can carry a symmetric named type. Untyped handlers degrade to
 * `undefined`.
 */
export function inferPayloadFromHandler(handlerArg: Parser.SyntaxNode | undefined): string | undefined {
  if (!handlerArg) return undefined;
  if (handlerArg.type !== "arrow_function" && handlerArg.type !== "function_expression" && handlerArg.type !== "function") {
    return undefined;
  }
  const params = handlerArg.childForFieldName("parameters");
  const firstParam = params?.namedChild(0);
  if (!firstParam) return undefined;
  const typeAnnotation = firstParam.childForFieldName("type")
    ?? firstParam.namedChildren.find((child) => child.type === "type_annotation");
  const typeNode = typeAnnotation?.namedChild(0);
  return typeNode ? baseTypeName(typeNode) : undefined;
}
