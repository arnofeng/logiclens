import type { EventRule } from "./types.js";
import { hasLexicalType, isLexicallyVisible, literal } from "./types.js";

export const azureMessagingEvents: EventRule = (file) => {
  const source = file.source ?? "";
  const endpoints = new Map<string, Array<{ topic: string; role: "producer" | "consumer"; index: number }>>();
  for (const match of source.matchAll(/\b(\w+)\s*=\s*(\w+)\.(CreateSender|CreateReceiver|CreateProcessor)\s*\(\s*([^,\)]+)/g)) {
    if (!hasLexicalType(source, match[2]!, match.index!, /(?:^|\.)ServiceBusClient$/)) continue;
    const topic = literal(match[4]!);
    if (topic) {
      const name = match[1]!;
      const values = endpoints.get(name) ?? [];
      values.push({ topic, role: match[3] === "CreateSender" ? "producer" : "consumer", index: match.index! });
      endpoints.set(name, values);
    }
  }
  const output = [];
  for (const match of source.matchAll(/\b(\w+)\.(SendMessageAsync|SendMessagesAsync|ReceiveMessageAsync|ReceiveMessagesAsync|StartProcessingAsync)\s*\(/g)) {
    const endpoint = endpoints.get(match[1]!)?.filter((value) => isLexicallyVisible(source, value.index, match.index!)).at(-1);
    if (!endpoint) continue;
    const { index: _declarationIndex, ...fact } = endpoint;
    output.push({ ...fact, broker: "unknown" as const, framework: "azure-service-bus", index: match.index!, raw: match[0]!, rule: "azure-service-bus-typed-endpoint" });
  }
  return output;
};
