import type { EventRule } from "./types.js";
import { genericArguments, hasLexicalType, lexicalType, literal } from "./types.js";

export const kafkaEvents: EventRule = (file) => {
  const source = file.source ?? "";
  const output = [];
  for (const match of source.matchAll(/\b(\w+)\.(ProduceAsync|Produce|Subscribe)\s*\(\s*([^,\)]+)/g)) {
    const type = lexicalType(source, match[1]!, match.index!);
    const producerType = hasLexicalType(source, match[1]!, match.index!, /(?:^|\.)IProducer\s*</);
    const consumerType = hasLexicalType(source, match[1]!, match.index!, /(?:^|\.)IConsumer\s*</);
    if (!type || !producerType && !consumerType) continue;
    const topic = literal(match[3]!);
    if (!topic) continue;
    const producer = match[2] !== "Subscribe";
    const args = genericArguments(type);
    output.push({ topic, role: producer ? "producer" as const : "consumer" as const, broker: "kafka" as const,
      framework: "confluent-kafka", payloadType: args[1], index: match.index!, raw: match[0]!, rule: "confluent-kafka-typed-client" });
  }
  return output;
};
