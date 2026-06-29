import { compatExtractor } from "./compat.js";
import type { FactCollector } from "../factCollector.js";
import type { ParsedFile, CodeSymbol } from "../../../parsing/types.js";
import { parseProto, type Message, type Field, type Service, type Method } from "./protoSchema.js";
import { pushGrpcContract, pushSchemaContract } from "./shared.js";
import { normalizePrimitiveType, type SchemaFieldSpec } from "../../spec.js";
import { codeId } from "../../../../shared/path.js";
import { hashText } from "../../../../shared/hash.js";

// Helper to find the start line of a regex search in source lines
function findStartLine(lines: string[], regex: RegExp): number {
  for (let i = 0; i < lines.length; i++) {
    if (regex.test(lines[i]!)) {
      return i + 1; // 1-indexed
    }
  }
  return 1;
}

// Helper to find the start line within a specific line range
function findStartLineInRange(lines: string[], regex: RegExp, startLine: number, endLine: number): number {
  const start = Math.max(0, startLine - 1);
  const end = Math.min(lines.length, endLine);
  for (let i = start; i < end; i++) {
    if (regex.test(lines[i]!)) {
      return i + 1; // 1-indexed
    }
  }
  return startLine;
}

// Helper to find the line range of a bracket-enclosed node
function findLineRange(lines: string[], startRegex: RegExp): { startLine: number; endLine: number } {
  const startLine = findStartLine(lines, startRegex);
  let endLine = startLine;
  let braces = 0;
  let foundOpen = false;
  for (let i = startLine - 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (!foundOpen) {
      if (line.includes("{")) {
        foundOpen = true;
        braces += (line.match(/{/g) || []).length;
        braces -= (line.match(/}/g) || []).length;
      }
    } else {
      braces += (line.match(/{/g) || []).length;
      braces -= (line.match(/}/g) || []).length;
    }
    if (foundOpen && braces <= 0) {
      endLine = i + 1;
      break;
    }
  }
  return { startLine, endLine };
}

export const protoExtractor = compatExtractor({
  name: "builtin:proto",
  languages: ["proto"],
  extract(context, collector: FactCollector) {
    for (const file of context.parsedFiles) {
      if (file.language !== "proto" || !file.source) continue;

      const schema = parseProto(file.source);
      if (!schema) continue;

      const pkg = schema.package || "";
      const lines = file.source.split(/\r?\n/);

      // --- 1. Services and RPC Methods ---
      for (const service of (schema.services || []) as Service[]) {
        for (const method of (service.methods || []) as Method[]) {
          const fullName = pkg
            ? `${pkg}.${service.name}/${method.name}`
            : `${service.name}/${method.name}`;

          // Determine streaming type
          const c = method.client_streaming ?? false;
          const s = method.server_streaming ?? false;
          const streaming = (c && s)
            ? "bidi-stream"
            : c
            ? "client-stream"
            : s
            ? "server-stream"
            : "unary";

          // Find lines for method
          const methodRegex = new RegExp(`rpc\\s+${method.name}\\b`);
          const methodLines = findLineRange(lines, methodRegex);
          const methodRaw = lines.slice(methodLines.startLine - 1, methodLines.endLine).join("\n");

          const methodSymbol: CodeSymbol = {
            id: codeId(file.repoId, file.path, "method", `${service.name}.${method.name}`, methodLines.startLine),
            repoId: file.repoId,
            fileId: file.fileId,
            kind: "method",
            name: method.name,
            qualifiedName: `${service.name}.${method.name}`,
            startLine: methodLines.startLine,
            endLine: methodLines.endLine,
            signature: `rpc ${method.name}(${method.input_type}) returns (${method.output_type})`,
            source: methodRaw,
            hash: hashText(methodRaw)
          };

          pushGrpcContract({
            collector,
            file,
            symbol: methodSymbol,
            fullName,
            role: "shared",
            offset: 0,
            raw: methodRaw,
            rule: "proto-rpc",
            confidence: 1.0,
            service: service.name,
            method: method.name,
            package: pkg || undefined,
            requestType: method.input_type,
            responseType: method.output_type,
            streaming,
            framework: "proto"
          });
        }
      }

      // --- 2. Message Schemas (including nested recursively) ---
      const extractMessages = (messagesList: Message[], parentPrefix: string) => {
        for (const msg of messagesList) {
          const fullMsgName = parentPrefix ? `${parentPrefix}.${msg.name}` : msg.name;
          const messageKey = pkg ? `${pkg}.${fullMsgName}` : fullMsgName;

          const msgRegex = new RegExp(`message\\s+${msg.name}\\b`);
          const msgLines = findLineRange(lines, msgRegex);
          const msgRaw = lines.slice(msgLines.startLine - 1, msgLines.endLine).join("\n");

          const msgSymbol: CodeSymbol = {
            id: codeId(file.repoId, file.path, "struct", fullMsgName, msgLines.startLine),
            repoId: file.repoId,
            fileId: file.fileId,
            kind: "struct",
            name: msg.name,
            qualifiedName: fullMsgName,
            startLine: msgLines.startLine,
            endLine: msgLines.endLine,
            signature: `message ${msg.name}`,
            source: msgRaw,
            hash: hashText(msgRaw)
          };

          const fields: SchemaFieldSpec[] = (msg.fields || []).map((f: Field) => {
            const fieldRegex = new RegExp(`\\b${f.name}\\s*=`);
            const fieldLine = findStartLineInRange(lines, fieldRegex, msgLines.startLine, msgLines.endLine);

            // Formulate raw type representation to normalize
            let rawType = f.type;
            if (f.map) {
              rawType = `map<${f.map.from}, ${f.map.to}>`;
            } else if (f.repeated) {
              rawType = `repeated ${f.type}`;
            }

            return {
              name: f.name,
              type: normalizePrimitiveType("proto", rawType),
              optional: f.optional ?? false,
              sourceLine: fieldLine
            };
          });

          pushSchemaContract({
            collector,
            file,
            symbol: msgSymbol,
            name: messageKey,
            language: "proto",
            fields,
            raw: msgRaw,
            rule: "proto-schema",
            confidence: 1.0
          });

          // Recursively process nested messages
          if (msg.messages && msg.messages.length > 0) {
            extractMessages(msg.messages, fullMsgName);
          }
        }
      };

      extractMessages((schema.messages || []) as Message[], "");
    }
  }
});
