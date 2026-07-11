import type { FactExtractorPlugin, PluginSymbolView } from "@logiclens/plugin-sdk";
import { azureMessagingEvents } from "./events/azureMessaging.js";
import { kafkaEvents } from "./events/kafka.js";
import { massTransitEvents } from "./events/massTransit.js";
import { nserviceBusEvents } from "./events/nservicebus.js";
import { rabbitMqEvents } from "./events/rabbitmq.js";

const RULES = [kafkaEvents, rabbitMqEvents, massTransitEvents, nserviceBusEvents, azureMessagingEvents];

function lineAt(source: string, index: number): number { return source.slice(0, index).split("\n").length; }
function owner(symbols: readonly PluginSymbolView[], filePath: string, line: number): string | undefined {
  return symbols.filter((symbol) => symbol.filePath === filePath && symbol.startLine <= line && symbol.endLine >= line)
    .sort((a, b) => (a.endLine - a.startLine) - (b.endLine - b.startLine))[0]?.id;
}

export const csharpEventExtractor: FactExtractorPlugin = {
  name: "csharp:events",
  languages: ["csharp"],
  extract(context) {
    for (const file of context.files.byLanguage("csharp")) {
      if (/(?:^|[\\/])(?:obj|generated)(?:[\\/]|$)/i.test(file.path) || /(?:\.g|\.generated|\.designer)\.cs$/i.test(file.path)) continue;
      const source = file.source ?? "";
      const seen = new Set<string>();
      for (const rule of RULES) for (const candidate of rule(file)) {
        const line = lineAt(source, candidate.index);
        const key = `${candidate.framework}\0${candidate.role}\0${candidate.topic}\0${line}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const { index: _index, raw, rule: ruleName, ...fact } = candidate;
        context.emit.event({ ...fact, repoId: file.repoId, filePath: file.path, sourceSymbolId: owner(context.symbols, file.path, line),
          evidence: { filePath: file.path, line, raw, rule: ruleName, confidence: "exact" } });
      }
    }
  }
};
