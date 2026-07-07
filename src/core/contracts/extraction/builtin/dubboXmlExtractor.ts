import { compatExtractor } from "./compat.js";
import type { CodeSymbol, ParsedFile } from "../../../parsing/types.js";
import type { FactCollector } from "../factCollector.js";
import { confidenceFor } from "../../../../shared/confidence.js";
import { codeId } from "../../../../shared/path.js";
import { hashText } from "../../../../shared/hash.js";
import { parsedCodeFiles, pushDubboContract } from "./shared.js";
import { parseDubboXmlConfig } from "./dubboXmlConfig.js";

function makeXmlSymbol(file: ParsedFile, raw: string, offset: number, name: string): CodeSymbol {
  const source = file.source ?? raw;
  const startLine = source.slice(0, offset).split(/\r?\n/).length;
  const qualifiedName = `${name}@${offset}`;
  return {
    id: codeId(file.repoId, file.path, "variable", qualifiedName, startLine),
    repoId: file.repoId,
    fileId: file.fileId,
    kind: "variable",
    name,
    qualifiedName,
    startLine,
    endLine: startLine,
    signature: raw,
    source,
    hash: hashText(raw)
  };
}

export const dubboXmlExtractor = compatExtractor({
  name: "builtin:dubbo-xml",
  languages: ["xml"],
  extract(context, collector: FactCollector) {
    for (const file of parsedCodeFiles(context.parsedFiles)) {
      if (file.language !== "xml") continue;
      const source = file.source;
      if (!source) continue;
      for (const entry of parseDubboXmlConfig(source)) {
        const symbol = makeXmlSymbol(file, entry.raw, entry.offset, `${entry.interfaceName}#*`);
        pushDubboContract({
          collector,
          file,
          symbol,
          interfaceName: entry.interfaceName,
          method: "*",
          role: entry.kind === "service" ? "producer" : "consumer",
          offset: entry.offset,
          raw: entry.raw,
          rule: entry.kind === "service" ? "dubbo-xml-service" : "dubbo-xml-reference",
          confidence: confidenceFor("exact-parser-route"),
          group: entry.group,
          version: entry.version,
          config: "xml",
          framework: "dubbo-java"
        });
      }
    }
  }
});
