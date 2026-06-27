import type Parser from "tree-sitter";
import type { CodeSymbol, ParsedFile } from "../../../parsing/types.js";
import type { ContractExtractor } from "../../../../interfaces/plugins/types.js";
import { confidenceFor } from "../../../../shared/confidence.js";
import {
  createCrossRepoExtraction,
  isParsedCodeFile,
  pushApiContractFromPath,
  toFactBundle
} from "./shared.js";
import {
  callArguments,
  namedChildren,
  objectPropertyValue,
  parseJsAst,
  staticPropertyPath,
  stringLiteralValue,
  walkAst
} from "./jsAstUtils.js";

type ImportedClient = {
  localName: string;
  importedName: string;
  module: string;
  raw: string;
};

type ClientInstance = ImportedClient & {
  instanceName: string;
  raw: string;
};

type GeneratedMethodBridge = {
  className: string;
  methodName: string;
  apiPath: string;
  raw: string;
};

const CLIENT_CLASS_RE = /(?:Client|Api|ServiceClient|GrpcClient)$/;

function importedClients(file: ParsedFile): ImportedClient[] {
  return file.imports.flatMap((importRef) => (importRef.bindings ?? [])
    .filter((binding) => binding.localName && CLIENT_CLASS_RE.test(binding.localName))
    .map((binding) => ({
      localName: binding.localName,
      importedName: binding.importedName && binding.importedName !== "default" ? binding.importedName : binding.localName,
      module: importRef.module,
      raw: importRef.raw
    })));
}

function constructorName(node: Parser.SyntaxNode): string | undefined {
  if (node.type !== "new_expression") return undefined;
  return namedChildren(node).find((child) => child.type === "identifier" || child.type === "member_expression")?.text;
}

function collectClientInstances(root: Parser.SyntaxNode, importsByLocalName: Map<string, ImportedClient>): Map<string, ClientInstance> {
  const instances = new Map<string, ClientInstance>();
  walkAst(root, (node) => {
    if (node.type !== "variable_declarator" && node.type !== "public_field_definition") return;
    const nameNode = node.childForFieldName("name");
    const valueNode = node.childForFieldName("value");
    const className = valueNode ? constructorName(valueNode) : undefined;
    const imported = className ? importsByLocalName.get(className) : undefined;
    if (!nameNode || !imported) return;
    instances.set(nameNode.text, {
      ...imported,
      instanceName: nameNode.text,
      raw: node.text
    });
  });
  return instances;
}

function classNameFor(node: Parser.SyntaxNode): string | undefined {
  return node.childForFieldName("name")?.text ?? namedChildren(node).find((child) => child.type === "type_identifier" || child.type === "identifier")?.text;
}

function methodNameFor(node: Parser.SyntaxNode): string | undefined {
  return node.childForFieldName("name")?.text ?? namedChildren(node).find((child) => child.type === "property_identifier" || child.type === "identifier")?.text;
}

function grpcPath(rawMethod: string): string {
  return `/grpc/${rawMethod}`;
}

function bridgeFromMethod(className: string, methodNode: Parser.SyntaxNode): GeneratedMethodBridge | undefined {
  const methodName = methodNameFor(methodNode);
  if (!methodName) return undefined;
  let apiPath: string | undefined;

  walkAst(methodNode, (node) => {
    if (apiPath || node.type !== "call_expression") return;
    const fn = node.childForFieldName("function");
    const fnPath = fn ? staticPropertyPath(fn) : undefined;
    const args = callArguments(node);
    if (fnPath?.startsWith("grpc.")) {
      const method = args[0] ? stringLiteralValue(args[0]) : undefined;
      if (method) apiPath = grpcPath(method);
      return;
    }
    const objectArg = args.find((arg) => arg.type === "object");
    const urlNode = objectArg ? objectPropertyValue(objectArg, "url") ?? objectPropertyValue(objectArg, "path") : undefined;
    const url = urlNode ? stringLiteralValue(urlNode) : undefined;
    if (url?.startsWith("/")) apiPath = url;
  });

  return apiPath ? { className, methodName, apiPath, raw: methodNode.text } : undefined;
}

function generatedMethodBridges(file: ParsedFile): GeneratedMethodBridge[] {
  const ast = parseJsAst(file);
  if (!ast) return [];
  const bridges: GeneratedMethodBridge[] = [];
  walkAst(ast.tree.rootNode, (node) => {
    if (node.type !== "class_declaration") return;
    const className = classNameFor(node);
    if (!className || !CLIENT_CLASS_RE.test(className)) return;
    for (const method of namedChildren(node).flatMap((child) => child.type === "class_body" ? namedChildren(child) : [])) {
      if (method.type !== "method_definition") continue;
      const bridge = bridgeFromMethod(className, method);
      if (bridge) bridges.push(bridge);
    }
  });
  return bridges;
}

function bridgeLookup(files: ParsedFile[]): Map<string, GeneratedMethodBridge> {
  const bridges = new Map<string, GeneratedMethodBridge>();
  for (const file of files) {
    for (const bridge of generatedMethodBridges(file)) {
      bridges.set(`${bridge.className}.${bridge.methodName}`, bridge);
      bridges.set(`${bridge.className}::${bridge.methodName}`, bridge);
    }
  }
  return bridges;
}

function symbolForNode(file: ParsedFile, node: Parser.SyntaxNode): CodeSymbol | undefined {
  const line = node.startPosition.row + 1;
  return file.symbols
    .filter((symbol) => symbol.startLine <= line && symbol.endLine >= line)
    .sort((a, b) => (a.endLine - a.startLine) - (b.endLine - b.startLine))[0];
}

function symbolOffset(file: ParsedFile, symbol: CodeSymbol, node: Parser.SyntaxNode): number {
  const source = file.source ?? "";
  const symbolStart = source.indexOf(symbol.source);
  return symbolStart >= 0 ? Math.max(0, node.startIndex - symbolStart) : 0;
}

function sdkCallBridge(
  callNode: Parser.SyntaxNode,
  instances: Map<string, ClientInstance>,
  importsByLocalName: Map<string, ImportedClient>,
  bridges: Map<string, GeneratedMethodBridge>
): { instance: ClientInstance; bridge: GeneratedMethodBridge } | undefined {
  const fn = callNode.childForFieldName("function");
  if (!fn || fn.type !== "member_expression") return undefined;
  const methodName = fn.childForFieldName("property")?.text;
  const object = fn.childForFieldName("object");
  if (!methodName || !object) return undefined;

  const directObject = staticPropertyPath(object);
  if (directObject) {
    const instanceName = directObject.split(".").at(-1);
    const instance = instanceName ? instances.get(instanceName) : undefined;
    const bridge = instance ? bridges.get(`${instance.importedName}.${methodName}`) ?? bridges.get(`${instance.localName}.${methodName}`) : undefined;
    if (instance && bridge) return { instance, bridge };
  }

  const constructedClass = constructorName(object);
  const bridge = constructedClass ? bridges.get(`${constructedClass}.${methodName}`) : undefined;
  const imported = constructedClass ? importsByLocalName.get(constructedClass) : undefined;
  return imported && bridge
    ? { instance: { ...imported, instanceName: constructedClass!, raw: object.text }, bridge }
    : undefined;
}

export const sdkGeneratedClientExtractor: ContractExtractor = {
  name: "builtin:js-sdk-generated-client",
  languages: ["javascript", "typescript"],
  frameworks: ["js:package-json"],
  extract(context) {
    const result = createCrossRepoExtraction();
    const codeFiles = context.parsedFiles.filter(isParsedCodeFile).filter((file): file is ParsedFile =>
      file.language === "typescript" || file.language === "tsx" || file.language === "javascript" || file.language === "jsx"
    );
    const bridges = bridgeLookup(codeFiles);

    for (const file of codeFiles) {
      const ast = parseJsAst(file);
      if (!ast) continue;
      const importsByLocalName = new Map(importedClients(file).map((item) => [item.localName, item]));
      if (importsByLocalName.size === 0) continue;
      const instances = collectClientInstances(ast.tree.rootNode, importsByLocalName);

      walkAst(ast.tree.rootNode, (node) => {
        if (node.type !== "call_expression") return;
        const hit = sdkCallBridge(node, instances, importsByLocalName, bridges);
        const symbol = hit ? symbolForNode(file, node) : undefined;
        if (!hit || !symbol) return;
        // The SDK evidence chain is only accepted when import, construction,
        // method call, and generated-client bridge all agree on the same class.
        pushApiContractFromPath({
          result,
          file,
          symbol,
          apiPath: hit.bridge.apiPath,
          role: "consumer",
          offset: symbolOffset(file, symbol, node),
          raw: `${hit.instance.raw} -> ${node.text} -> ${hit.bridge.raw} via ${hit.instance.module}`,
          rule: "sdk-generated-client-consumer",
          confidence: confidenceFor("strong-static-import")
        });
      });
    }
    return toFactBundle(result);
  }
};
