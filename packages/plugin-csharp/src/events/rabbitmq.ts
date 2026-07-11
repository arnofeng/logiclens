import type { EventRule } from "./types.js";
import { hasLexicalType, literal } from "./types.js";

export const rabbitMqEvents: EventRule = (file) => {
  const source = file.source ?? "";
  const output = [];
  for (const match of source.matchAll(/\b(\w+)\.(BasicPublishAsync|BasicPublish|BasicConsumeAsync|BasicConsume)\s*\(([^;]*)\)/g)) {
    if (!hasLexicalType(source, match[1]!, match.index!, /(?:^|\.)(?:IModel|IChannel)$/)) continue;
    const literals = [...match[3]!.matchAll(/\"(?:[^\"\\]|\\.)*\"/g)].map((item) => literal(item[0]!)).filter((item): item is string => item !== undefined);
    const producer = match[2]!.startsWith("BasicPublish");
    const topic = producer ? literals[1] : literals[0];
    if (!topic) continue;
    output.push({ topic, role: producer ? "producer" as const : "consumer" as const, broker: "rabbitmq" as const,
      framework: "rabbitmq-dotnet-client", index: match.index!, raw: match[0]!, rule: "rabbitmq-typed-channel" });
  }
  return output;
};
