import type { EventRule } from "./types.js";
import { hasLexicalType, lexicalType } from "./types.js";

export const nserviceBusEvents: EventRule = (file) => {
  const source = file.source ?? "";
  const output = [];
  for (const match of source.matchAll(/\b(\w+)\.(Publish|Send|SendLocal)\s*(?:<\s*([\w.]+)\s*>)?\s*\(\s*(\w+)?/g)) {
    if (!hasLexicalType(source, match[1]!, match.index!, /(?:^|\.)(?:IMessageSession|IEndpointInstance)$/)) continue;
    const inferred = match[3] ?? (match[4] ? lexicalType(source, match[4], match.index!) : undefined);
    if (!inferred) continue;
    const payloadType = inferred.replace(/^.*\./, "");
    output.push({ topic: payloadType, role: "producer" as const, broker: "unknown" as const, framework: "nservicebus",
      payloadType, index: match.index!, raw: match[0]!, rule: `nservicebus-${match[2]!.toLowerCase()}-session` });
  }
  for (const match of source.matchAll(/\bclass\s+\w+[^\n{]*:\s*[^\n{]*\bIHandleMessages\s*<\s*([\w.]+)\s*>/g)) {
    const payloadType = match[1]!.replace(/^.*\./, "");
    output.push({ topic: payloadType, role: "consumer" as const, broker: "unknown" as const, framework: "nservicebus",
      payloadType, index: match.index!, raw: match[0]!, rule: "nservicebus-handler-interface" });
  }
  return output;
};
