import Parser from "tree-sitter";
import { isBuiltinSourceLanguage, getCachedQuery } from "../parsing/treeSitter.js";
import type { CallRef, CodeSymbol, SourceLanguage } from "../parsing/types.js";

function extractReceiver(callNode: Parser.SyntaxNode): string | undefined {
  if (callNode.type === "call_expression" || callNode.type === "new_expression") {
    const funcNode = callNode.childForFieldName("function") ?? callNode.childForFieldName("constructor");
    if (funcNode) {
      if (funcNode.type === "member_expression") {
        return funcNode.childForFieldName("object")?.text;
      } else if (funcNode.type === "selector_expression") {
        return funcNode.childForFieldName("operand")?.text ?? funcNode.childForFieldName("object")?.text ?? funcNode.namedChild(0)?.text;
      }
    }
  } else if (callNode.type === "method_invocation") {
    return callNode.childForFieldName("object")?.text;
  } else if (callNode.type === "call") {
    const funcNode = callNode.childForFieldName("function");
    if (funcNode && funcNode.type === "attribute") {
      return funcNode.childForFieldName("value")?.text ?? funcNode.namedChild(0)?.text;
    }
  }
  return undefined;
}

function countArguments(callNode: Parser.SyntaxNode): number | undefined {
  const argsNode = callNode.childForFieldName("arguments");
  if (!argsNode) return undefined;
  let count = 0;
  for (let i = 0; i < argsNode.namedChildCount; i++) {
    const child = argsNode.namedChild(i);
    if (child && child.type !== "comment" && child.type !== "line_comment" && child.type !== "block_comment") {
      count++;
    }
  }
  return count;
}

export function extractCallsFromTreeSitter(
  tree: Parser.Tree,
  fileId: string,
  language: SourceLanguage | string,
  symbols: CodeSymbol[],
  query?: Parser.Query
): CallRef[] {
  let activeQuery = query;
  if (!activeQuery) {
    if (!isBuiltinSourceLanguage(language)) {
      throw new Error(`No call query provided for language "${language}".`);
    }
    activeQuery = getCachedQuery(language, "calls");
  }
  const matches = activeQuery.matches(tree.rootNode);
  const calls: CallRef[] = [];

  const findCaller = (line: number): string | undefined => {
    const containing = symbols
      .filter((symbol) => symbol.startLine <= line && symbol.endLine >= line)
      .sort((a, b) => (a.endLine - a.startLine) - (b.endLine - b.startLine))[0];
    return containing?.id;
  };

  for (const match of matches) {
    let calleeName = "";
    let rawText = "";
    let startLine = 1;
    let callNode: Parser.SyntaxNode | undefined = undefined;

    for (const capture of match.captures) {
      if (capture.name === "call") {
        callNode = capture.node;
        rawText = capture.node.text;
        startLine = capture.node.startPosition.row + 1;
      } else if (capture.name === "call.name") {
        calleeName = capture.node.text.replace(/^["']|["']$/g, "");
      }
    }

    if (calleeName) {
      const receiver = callNode ? extractReceiver(callNode) : undefined;
      const argsCount = callNode ? countArguments(callNode) : undefined;

      calls.push({
        callerSymbolId: findCaller(startLine),
        calleeName,
        receiver,
        argsCount,
        raw: rawText,
        fileId,
        line: startLine
      });
    }
  }

  return calls;
}
