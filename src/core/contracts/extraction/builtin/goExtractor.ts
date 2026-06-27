import type Parser from "tree-sitter";
import type { CodeSymbol, ParsedFile } from "../../../parsing/types.js";
import type { ContractExtractor } from "../../../../plugins/types.js";
import { confidenceFor } from "../../../../shared/confidence.js";
import {
  createCrossRepoExtraction,
  evidence,
  isParsedCodeFile,
  pushApiContractFromPath,
  pushEventContract,
  sourceLine,
  toFactBundle
} from "./shared.js";
import {
  callArguments,
  findContainingSymbol,
  namedChildren,
  parseSourceAst,
  selectorParts,
  stringLiteralValue,
  symbolOffset,
  walkSourceAst
} from "./sourceAstUtils.js";
import { inferBrokerFromImports, type EventBroker } from "../../event.js";

const GIN_ROUTE_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "Handle"]);
const NET_HTTP_PRODUCER_METHODS = new Set(["HandleFunc", "Handle"]);
const NET_HTTP_CONSUMER_METHODS = new Set(["Get", "Post", "PostForm", "Head"]);

function selectorCall(node: Parser.SyntaxNode): { object?: string; method?: string; args: Parser.SyntaxNode[]; raw: string } | undefined {
  if (node.type !== "call_expression") return undefined;
  const fn = node.childForFieldName("function") ?? node.namedChild(0);
  if (!fn || fn.type !== "selector_expression") return undefined;
  const { object, property } = selectorParts(fn);
  return { object, method: property, args: callArguments(node), raw: node.text };
}

function collectGinRouterVars(root: Parser.SyntaxNode): Set<string> {
  const routers = new Set<string>();
  walkSourceAst(root, (node) => {
    if (node.type !== "short_var_declaration" && node.type !== "var_spec") return;
    const children = namedChildren(node);
    const name = firstIdentifier(children[0]);
    const call = firstCallExpression(children[1]);
    const selector = call ? selectorCall(call) : undefined;
    if (name && selector?.object === "gin" && selector.method === "Default") routers.add(name);
  });
  return routers;
}

function firstIdentifier(node: Parser.SyntaxNode | undefined): string | undefined {
  if (!node) return undefined;
  if (node.type === "identifier") return node.text;
  return namedChildren(node).map(firstIdentifier).find(Boolean);
}

function firstCallExpression(node: Parser.SyntaxNode | undefined): Parser.SyntaxNode | undefined {
  if (!node) return undefined;
  if (node.type === "call_expression") return node;
  return namedChildren(node).map(firstCallExpression).find(Boolean);
}

function pushDynamicUnresolvedEvidence(input: {
  result: ReturnType<typeof createCrossRepoExtraction>;
  file: ParsedFile;
  symbol: CodeSymbol;
  offset: number;
  raw: string;
}): void {
  input.result.evidence.push(evidence({
    repoId: input.file.repoId,
    fileId: input.file.fileId,
    filePath: input.file.path,
    line: sourceLine(input.symbol.source, input.offset, input.symbol.startLine),
    raw: `${input.raw} // unresolved: HTTP call argument is not a resolvable static path`,
    rule: "dynamic-unresolved",
    confidence: 0
  }));
}

function isInsideSelectorCall(node: Parser.SyntaxNode): boolean {
  let current: Parser.SyntaxNode | null = node.parent;
  while (current) {
    if (current.type === "call_expression") return Boolean(selectorCall(current));
    current = current.parent;
  }
  return false;
}

// NATS publishes/subscribes carry the subject as the first string argument.
const NATS_PRODUCER_METHODS = new Set(["Publish", "PublishMsg", "PublishRequest"]);
const NATS_CONSUMER_METHODS = new Set(["Subscribe", "QueueSubscribe", "SubscribeSync", "ChanSubscribe"]);
// kafka-go / sarama carry the topic as a `Topic:` field inside a struct literal.
const KAFKA_STRUCT_CONSUMER = /Reader(Config)?$|ConsumerMessage$/;
const KAFKA_STRUCT_RELEVANT = /Message$|ProducerMessage$|Reader(Config)?$|Writer(Config)?$|ConsumerMessage$/;

function firstStringLiteralDescendant(node: Parser.SyntaxNode): Parser.SyntaxNode | undefined {
  let found: Parser.SyntaxNode | undefined;
  walkSourceAst(node, (child) => {
    if (found) return;
    if (child.type === "interpreted_string_literal" || child.type === "raw_string_literal") found = child;
  });
  return found;
}

/** Extracts a concrete `Topic: "..."` value from a kafka-go/sarama struct literal. */
function kafkaStructTopic(node: Parser.SyntaxNode): { topic?: string; relevant: boolean; role: "producer" | "consumer" } | undefined {
  if (node.type !== "composite_literal") return undefined;
  const typeName = node.childForFieldName("type")?.text ?? "";
  if (!KAFKA_STRUCT_RELEVANT.test(typeName)) return undefined;
  const role = KAFKA_STRUCT_CONSUMER.test(typeName) ? "consumer" : "producer";
  const body = node.childForFieldName("body");
  if (!body) return { relevant: true, role };
  for (const el of namedChildren(body)) {
    if (el.type !== "keyed_element" && el.type !== "literal_element") continue;
    if (!/^Topic\s*:/.test(el.text)) continue;
    const str = firstStringLiteralDescendant(el);
    return { topic: str ? stringLiteralValue(str) : undefined, relevant: true, role };
  }
  return { relevant: true, role };
}

function extractGoEvents(
  result: ReturnType<typeof createCrossRepoExtraction>,
  file: ParsedFile,
  root: Parser.SyntaxNode,
  importBroker: EventBroker
): void {
  walkSourceAst(root, (node) => {
    // NATS subject-as-string calls. `Subscribe`/`Publish` are generic method
    // names, so only attribute them to NATS when the file actually imports
    // NATS — otherwise a kafka-only file's `reader.Subscribe(...)` would be
    // mislabelled as a nats event.
    const call = importBroker === "nats" ? selectorCall(node) : undefined;
    if (call?.method) {
      const isProducer = NATS_PRODUCER_METHODS.has(call.method);
      const isConsumer = NATS_CONSUMER_METHODS.has(call.method);
      if (isProducer || isConsumer) {
        const topic = call.args[0] ? stringLiteralValue(call.args[0]) : undefined;
        const line = node.startPosition.row + 1;
        if (!topic) {
          result.evidence.push(evidence({
            repoId: file.repoId,
            fileId: file.fileId,
            filePath: file.path,
            line,
            raw: `${call.raw} // unresolved: event-topic-unresolvable`,
            rule: "event-topic-unresolvable",
            confidence: 0
          }));
          return;
        }
        pushEventContract({
          result,
          file,
          topic,
          role: isProducer ? "producer" : "consumer",
          broker: "nats",
          framework: "nats",
          line,
          raw: call.raw,
          rule: isProducer ? "go-event-producer" : "go-event-consumer",
          confidence: confidenceFor("probable-event"),
          sourceSymbolId: findContainingSymbol(file.symbols, node)?.id
        });
        return;
      }
    }

    // kafka-go / sarama struct-field topics.
    const struct = kafkaStructTopic(node);
    if (struct) {
      const line = node.startPosition.row + 1;
      if (!struct.topic) {
        result.evidence.push(evidence({
          repoId: file.repoId,
          fileId: file.fileId,
          filePath: file.path,
          line,
          raw: `${node.text.slice(0, 80)} // unresolved: event-topic-unresolvable`,
          rule: "event-topic-unresolvable",
          confidence: 0
        }));
        return;
      }
      pushEventContract({
        result,
        file,
        topic: struct.topic,
        role: struct.role,
        broker: importBroker === "unknown" ? "kafka" : importBroker,
        framework: "kafka",
        line,
        raw: node.text.slice(0, 120),
        rule: struct.role === "producer" ? "go-event-producer" : "go-event-consumer",
        confidence: confidenceFor("probable-event"),
        sourceSymbolId: findContainingSymbol(file.symbols, node)?.id
      });
    }
  });
}

export const goExtractor: ContractExtractor = {
  name: "builtin:go-extractor",
  languages: ["go"],
  frameworks: ["go:generic", "go:gin", "go:mod"],
  extract(context) {
    const result = createCrossRepoExtraction();
    for (const file of context.parsedFiles.filter(isParsedCodeFile)) {
      if (file.language !== "go") continue;
      const ast = parseSourceAst(file, "go");
      if (!ast) continue;

      const importBroker = inferBrokerFromImports(file.imports);
      if (importBroker !== "unknown") extractGoEvents(result, file, ast.tree.rootNode, importBroker);

      const ginRouters = collectGinRouterVars(ast.tree.rootNode);
      const seenStringOffsets = new Set<number>();

      walkSourceAst(ast.tree.rootNode, (node) => {
        const call = selectorCall(node);
        if (call) {
          const symbol = findContainingSymbol(file.symbols, node);
          if (!symbol || !call.object || !call.method) return;
          const firstArg = call.args[0];
          const apiPath = firstArg ? stringLiteralValue(firstArg) : undefined;
          const offset = symbolOffset(file, symbol, node);

          if (ginRouters.has(call.object) && GIN_ROUTE_METHODS.has(call.method) && apiPath?.startsWith("/")) {
            seenStringOffsets.add(firstArg!.startIndex);
            const ginMethod = call.method !== "Handle" ? call.method.toUpperCase() : undefined;
            pushApiContractFromPath({
              result,
              file,
              symbol,
              apiPath,
              role: "producer",
              offset,
              raw: call.raw,
              rule: "go-gin-route-producer",
              confidence: confidenceFor("exact-parser-route"),
              method: ginMethod,
              framework: "go-gin"
            });
            return;
          }

          if (call.object === "http" && NET_HTTP_PRODUCER_METHODS.has(call.method) && apiPath?.startsWith("/")) {
            seenStringOffsets.add(firstArg!.startIndex);
            pushApiContractFromPath({
              result,
              file,
              symbol,
              apiPath,
              role: "producer",
              offset,
              raw: call.raw,
              rule: "go-net-http-producer",
              confidence: confidenceFor("exact-parser-route"),
              framework: "go-net-http"
            });
            return;
          }

          if (call.object === "http" && NET_HTTP_CONSUMER_METHODS.has(call.method)) {
            if (!apiPath?.startsWith("/")) {
              pushDynamicUnresolvedEvidence({ result, file, symbol, offset, raw: call.raw });
              return;
            }
            seenStringOffsets.add(firstArg!.startIndex);
            const netMethod = call.method === "Get" ? "GET"
              : call.method === "Post" || call.method === "PostForm" ? "POST"
              : call.method === "Head" ? "HEAD" : undefined;
            pushApiContractFromPath({
              result,
              file,
              symbol,
              apiPath,
              role: "consumer",
              offset,
              raw: call.raw,
              rule: "go-http-client-consumer",
              confidence: confidenceFor("probable-http-client"),
              method: netMethod,
              framework: "go-net-http"
            });
            return;
          }
        }

        if (
          node.type !== "interpreted_string_literal" &&
          node.type !== "raw_string_literal"
        ) {
          return;
        }
        if (seenStringOffsets.has(node.startIndex) || isInsideSelectorCall(node)) return;
        const apiPath = stringLiteralValue(node);
        if (!apiPath?.startsWith("/api/")) return;
        const symbol = findContainingSymbol(file.symbols, node);
        if (!symbol) return;
        pushApiContractFromPath({
          result,
          file,
          symbol,
          apiPath,
          role: "consumer",
          offset: symbolOffset(file, symbol, node),
          raw: node.text,
          rule: "go-api-path-consumer",
          confidence: confidenceFor("probable-http-route"),
          framework: "go"
        });
      });
    }
    return toFactBundle(result);
  }
};
