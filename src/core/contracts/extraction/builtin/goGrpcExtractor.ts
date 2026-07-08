import { compatExtractor } from "./compat.js";
import type Parser from "tree-sitter";
import type { CodeSymbol } from "../../../parsing/types.js";
import type { FactCollector } from "../factCollector.js";
import { confidenceFor } from "../../../../shared/confidence.js";
import { pushGrpcContract } from "./shared.js";
import { walkSourceAst, parseSourceAst, namedChildren } from "./sourceAstUtils.js";
import { codeId } from "../../../../shared/path.js";
import { hashText } from "../../../../shared/hash.js";

// Helper to extract type name from AST parameter/argument nodes
function extractTypeName(node: Parser.SyntaxNode | null | undefined): string | undefined {
  if (!node) return undefined;
  if (node.type === "qualified_type") {
    return node.childForFieldName("name")?.text || node.namedChild(1)?.text || undefined;
  }
  if (node.type === "type_identifier") {
    return node.text;
  }
  if (node.type === "pointer_type") {
    return extractTypeName(node.namedChild(0));
  }
  if (node.type === "composite_literal") {
    const typeNode = node.childForFieldName("type") || node.namedChild(0);
    if (typeNode) return extractTypeName(typeNode);
  }
  for (let i = 0; i < node.namedChildCount; i++) {
    const res = extractTypeName(node.namedChild(i));
    if (res) return res;
  }
  return undefined;
}

export const goGrpcExtractor = compatExtractor({
  name: "builtin:go-grpc",
  languages: ["go"],
  extract(context, collector: FactCollector) {
    for (const file of context.parsedFiles) {
      if (file.language !== "go") continue;

      const ast = parseSourceAst(file, "go");
      if (!ast) continue;

      // 1. Scan for structs embedding pb.Unimplemented{Service}Server
      const structToService = new Map<string, { serviceName: string }>();
      walkSourceAst(ast.tree.rootNode, (node) => {
        if (node.type !== "type_spec") return;
        const nameNode = node.childForFieldName("name");
        if (!nameNode) return;
        const structName = nameNode.text;

        const structType = node.namedChildren.find((c) => c.type === "struct_type");
        if (!structType) return;

        const fieldList = structType.namedChildren.find((c) => c.type === "field_declaration_list");
        if (!fieldList) return;

        for (let i = 0; i < fieldList.namedChildCount; i++) {
          const field = fieldList.namedChild(i);
          if (!field || field.type !== "field_declaration") continue;

          // Embedded field has no name identifiers
          const hasName = field.namedChildren.some((c) => c.type === "field_identifier");
          if (hasName) continue;

          const typeNode = field.namedChildren.find((c) => c.type === "qualified_type" || c.type === "type_identifier");
          if (!typeNode) continue;

          let typeName = "";
          if (typeNode.type === "qualified_type") {
            typeName = typeNode.childForFieldName("name")?.text || typeNode.namedChild(1)?.text || "";
          } else {
            typeName = typeNode.text;
          }

          const serverMatch = typeName.match(/^Unimplemented(.+)Server$/);
          if (serverMatch) {
            const serviceName = serverMatch[1]!;
            structToService.set(structName, { serviceName });
          }
        }
      });

      // 2. Scan for Server (Producer) method implementations
      walkSourceAst(ast.tree.rootNode, (node) => {
        if (node.type !== "method_declaration") return;

        const receiverList = node.childForFieldName("receiver");
        if (!receiverList) return;

        const receiverDecl = receiverList.namedChild(0);
        if (!receiverDecl || receiverDecl.type !== "parameter_declaration") return;

        const typeNode = receiverDecl.childForFieldName("type") || receiverDecl.namedChild(1);
        if (!typeNode) return;

        let receiverTypeName = "";
        if (typeNode.type === "pointer_type") {
          receiverTypeName = typeNode.namedChild(0)?.text || "";
        } else {
          receiverTypeName = typeNode.text;
        }

        const serviceInfo = structToService.get(receiverTypeName);
        if (!serviceInfo) return;

        const methodNameNode = node.childForFieldName("name");
        if (!methodNameNode) return;
        const methodName = methodNameNode.text;

        const paramList = node.childForFieldName("parameters");
        const returnList = node.childForFieldName("result");

        const params = paramList ? namedChildren(paramList) : [];
        const returns = returnList ? (returnList.type === "parameter_list" ? namedChildren(returnList) : [returnList]) : [];

        let requestType: string | undefined;
        let responseType: string | undefined;
        let streaming: "unary" | "client-stream" | "server-stream" | "bidi-stream" = "unary";

        // Check if any parameter represents a stream (Service_MethodServer or Service_MethodClient pattern)
        let streamParamIndex = -1;
        for (let i = 0; i < params.length; i++) {
          const tName = extractTypeName(params[i]);
          if (tName && /^[A-Za-z0-9]+_[A-Za-z0-9]+(Server|Client)$/.test(tName)) {
            streamParamIndex = i;
            break;
          }
        }

        if (streamParamIndex !== -1) {
          // Streaming RPC implementation
          if (params.length === 2 && streamParamIndex === 1) {
            // e.g. ListOrders(req *pb.ListRequest, stream pb.OrderService_ListOrdersServer)
            streaming = "server-stream";
            requestType = extractTypeName(params[0]);
          } else {
            // e.g. Method(stream pb.OrderService_MethodServer) -> client/bidi streaming
            streaming = "bidi-stream";
          }
          responseType = undefined; // streaming methods return only error on Go side
        } else {
          // Unary RPC implementation: (ctx, req) (resp, error)
          streaming = "unary";
          const reqParam = params[1] || params[0];
          requestType = reqParam ? extractTypeName(reqParam) : undefined;
          if (returns.length > 0) {
            const firstRet = extractTypeName(returns[0]);
            if (firstRet && firstRet !== "error") {
              responseType = firstRet;
            }
          }
        }

        const fullName = `${serviceInfo.serviceName}/${methodName}`;

        const startLine = node.startPosition.row + 1;
        const endLine = node.endPosition.row + 1;
        const raw = node.text;

        const methodSymbol: CodeSymbol = {
          id: codeId(file.repoId, file.path, "method", `${serviceInfo.serviceName}.${methodName}`, startLine),
          repoId: file.repoId,
          fileId: file.fileId,
          kind: "method",
          name: methodName,
          qualifiedName: `${serviceInfo.serviceName}.${methodName}`,
          startLine,
          endLine,
          signature: `func (s *${receiverTypeName}) ${methodName}(...)`,
          source: raw,
          hash: hashText(raw)
        };

        pushGrpcContract({
          collector,
          file,
          symbol: methodSymbol,
          fullName,
          role: "producer",
          offset: 0,
          raw,
          rule: "go-grpc-server",
          confidence: confidenceFor("exact-parser-route"),
          service: serviceInfo.serviceName,
          method: methodName,
          package: undefined, // Go side leaves package undefined to match Section 6 design
          requestType,
          responseType,
          streaming,
          framework: "grpc-go"
        });
      });

      // 3. Scan for Client (Consumer) variable bindings and calls
      const clientVariables = new Map<string, { serviceName: string }>();

      walkSourceAst(ast.tree.rootNode, (node) => {
        // Track: c := pb.NewOrderServiceClient(conn)
        if (node.type === "short_var_declaration") {
          const lhs = node.childForFieldName("left") || node.namedChild(0);
          const rhs = node.childForFieldName("right") || node.namedChild(1);
          if (!lhs || !rhs) return;

          const lhsNodes = namedChildren(lhs);
          const rhsNodes = namedChildren(rhs);
          if (lhsNodes.length !== 1 || rhsNodes.length !== 1) return;

          const varName = lhsNodes[0]?.text;
          const call = rhsNodes[0];
          if (!varName || !call || call.type !== "call_expression") return;

          const fn = call.childForFieldName("function") || call.namedChild(0);
          if (!fn || fn.type !== "selector_expression") return;

          const propNode = fn.childForFieldName("field") || fn.namedChild(1);
          if (!propNode) return;

          const match = propNode.text.match(/^New(.+)Client$/);
          if (match) {
            const serviceName = match[1]!;
            clientVariables.set(varName, { serviceName });
          }
        }
      });

      // To avoid duplicate consumer spec rows in the same file
      const seenConsumerCalls = new Set<string>();

      walkSourceAst(ast.tree.rootNode, (node) => {
        // Track: c.CreateOrder(ctx, &pb.CreateOrderRequest{...})
        if (node.type !== "call_expression") return;

        const fn = node.childForFieldName("function") || node.namedChild(0);
        if (!fn || fn.type !== "selector_expression") return;

        const objNode = fn.childForFieldName("operand") || fn.namedChild(0);
        const propNode = fn.childForFieldName("field") || fn.namedChild(1);
        if (!objNode || !propNode) return;

        const clientInfo = clientVariables.get(objNode.text);
        if (!clientInfo) return;

        const methodName = propNode.text;
        const fullName = `${clientInfo.serviceName}/${methodName}`;

        if (seenConsumerCalls.has(fullName)) return;
        seenConsumerCalls.add(fullName);

        const paramList = node.childForFieldName("arguments") || node.namedChild(1);
        const args = paramList ? namedChildren(paramList) : [];
        
        // request is usually the second argument if present
        const requestType = args.length >= 2 ? extractTypeName(args[1]) : undefined;

        const startLine = node.startPosition.row + 1;
        const endLine = node.endPosition.row + 1;
        const raw = node.text;

        const methodSymbol: CodeSymbol = {
          id: codeId(file.repoId, file.path, "method", `${clientInfo.serviceName}.${methodName}`, startLine),
          repoId: file.repoId,
          fileId: file.fileId,
          kind: "method",
          name: methodName,
          qualifiedName: `${clientInfo.serviceName}.${methodName}`,
          startLine,
          endLine,
          signature: `${clientInfo.serviceName}.${methodName} client call`,
          source: raw,
          hash: hashText(raw)
        };

        pushGrpcContract({
          collector,
          file,
          symbol: methodSymbol,
          fullName,
          role: "consumer",
          offset: 0,
          raw,
          rule: "go-grpc-client",
          confidence: confidenceFor("exact-parser-route"),
          service: clientInfo.serviceName,
          method: methodName,
          package: undefined, // Go side leaves package undefined to match Section 6 design
          requestType,
          responseType: undefined,
          streaming: args.length < 2 ? "bidi-stream" : "unary", // Simple heuristic for streaming client call
          framework: "grpc-go"
        });
      });
    }
  }
});
