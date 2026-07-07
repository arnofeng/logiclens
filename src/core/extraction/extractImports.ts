import Parser from "tree-sitter";
import { isBuiltinSourceLanguage, getCachedQuery } from "../parsing/treeSitter.js";
import type { ImportBinding, ImportRef, SourceLanguage } from "../parsing/types.js";

export function extractImportsFromTreeSitter(
  tree: Parser.Tree,
  fileId: string,
  language: SourceLanguage | string,
  query?: Parser.Query,
  filePath?: string
): ImportRef[] {
  let activeQuery = query;
  if (!activeQuery) {
    if (!isBuiltinSourceLanguage(language)) {
      throw new Error(`No import query provided for language "${language}".`);
    }
    activeQuery = getCachedQuery(language, "imports");
  }

  if (language === "python") {
    const matches = activeQuery.matches(tree.rootNode);
    const imports: ImportRef[] = [];
    const processedNodes = new Set<Parser.SyntaxNode>();
    for (const match of matches) {
      let importNode: Parser.SyntaxNode | null = null;
      for (const capture of match.captures) {
        if (capture.name === "import") {
          importNode = capture.node;
        }
      }
      if (!importNode || processedNodes.has(importNode)) continue;
      processedNodes.add(importNode);

      const rawText = importNode.text;
      const startLine = importNode.startPosition.row + 1;

      if (importNode.type === "import_statement") {
        for (const child of importNode.children) {
          if (child.type === "dotted_name") {
            const moduleName = child.text;
            const localName = moduleName.split(".").at(-1) || moduleName;
            imports.push({
              fileId,
              module: moduleName,
              raw: rawText,
              line: startLine,
              bindings: [{ localName, kind: "namespace" }]
            });
          } else if (child.type === "aliased_import") {
            const nameNode = child.childForFieldName("name");
            const aliasNode = child.childForFieldName("alias");
            if (nameNode && aliasNode) {
              imports.push({
                fileId,
                module: nameNode.text,
                raw: rawText,
                line: startLine,
                bindings: [{ localName: aliasNode.text, kind: "namespace" }]
              });
            }
          }
        }
      } else if (importNode.type === "import_from_statement") {
        const moduleNode = importNode.childForFieldName("module_name");
        if (moduleNode) {
          let moduleName = moduleNode.text;
          if (moduleNode.type === "relative_import") {
            const { dotCount, suffix } = parseRelativePythonImport(moduleNode);
            moduleName = normalizePythonImportModule(filePath || "", dotCount, suffix);
          }

          if (!moduleName) continue;

          const bindings: ImportBinding[] = [];
          let afterImport = false;
          for (let i = 0; i < importNode.childCount; i++) {
            const child = importNode.child(i)!;
            if (child.type === "import") {
              afterImport = true;
              continue;
            }
            if (!afterImport) continue;

            if (child.type === "dotted_name") {
              bindings.push({
                localName: child.text,
                importedName: child.text,
                kind: "named"
              });
            } else if (child.type === "aliased_import") {
              const nameNode = child.childForFieldName("name");
              const aliasNode = child.childForFieldName("alias");
              if (nameNode && aliasNode) {
                bindings.push({
                  localName: aliasNode.text,
                  importedName: nameNode.text,
                  kind: "named"
                });
              }
            } else if (child.type === "wildcard_import") {
              bindings.push({
                localName: "*",
                importedName: "*",
                kind: "namespace"
              });
            }
          }

          imports.push({
            fileId,
            module: moduleName,
            raw: rawText,
            line: startLine,
            bindings
          });
        }
      }
    }
    return imports;
  }

  const matches = activeQuery.matches(tree.rootNode);
  const importsMap = new Map<Parser.SyntaxNode, ImportRef>();

  for (const match of matches) {
    let importNode: Parser.SyntaxNode | null = null;
    let moduleText = "";
    let rawText = "";
    let startLine = 1;

    for (const capture of match.captures) {
      if (capture.name === "import") {
        importNode = capture.node;
        rawText = capture.node.text;
        startLine = capture.node.startPosition.row + 1;
      } else if (capture.name === "import.source") {
        moduleText = capture.node.text.replace(/^["']|["']$/g, "");
      }
    }

    if (importNode && moduleText) {
      if (!importsMap.has(importNode)) {
        if (language === "java") {
          moduleText = rawText.replace(/^import\s+/, "").replace(/;$/, "").trim();
          const isStatic = /^static\s+/.test(moduleText);
          moduleText = moduleText.replace(/^static\s+/, "");
          if (isStatic) {
            if (moduleText.endsWith(".*")) {
              moduleText = moduleText.slice(0, -2);
            } else {
              const lastDot = moduleText.lastIndexOf(".");
              if (lastDot !== -1) {
                moduleText = moduleText.substring(0, lastDot);
              }
            }
            if (moduleText.endsWith(".")) {
              moduleText = moduleText.slice(0, -1);
            }
          }
        }
        importsMap.set(importNode, {
          fileId,
          module: moduleText,
          raw: rawText,
          line: startLine,
          bindings: extractImportBindings(importNode, language)
        });
      }
    }
  }

  return Array.from(importsMap.values());
}

function parseRelativePythonImport(node: Parser.SyntaxNode): { dotCount: number; suffix: string } {
  let dotCount = 0;
  let suffix = "";
  const prefixNode = node.children.find((c) => c.type === "import_prefix");
  if (prefixNode) {
    dotCount = prefixNode.children.filter((c) => c.type === ".").length;
  }
  const dottedNode = node.children.find((c) => c.type === "dotted_name");
  if (dottedNode) {
    suffix = dottedNode.text;
  }
  return { dotCount, suffix };
}

function normalizePythonImportModule(filePath: string, dotCount: number, suffix: string): string {
  const currentParts = filePath.replace(/\\/g, "/").replace(/\.py$/, "").split("/").slice(0, -1);
  const base = currentParts.slice(0, Math.max(0, currentParts.length - dotCount + 1));
  return [...base, ...suffix.split(".").filter(Boolean)].join(".");
}

function extractImportBindings(node: Parser.SyntaxNode, language: SourceLanguage | string): ImportBinding[] {
  if (!(language === "typescript" || language === "tsx" || language === "javascript" || language === "jsx")) return [];
  if (node.type === "export_statement") {
    return extractReExportBindings(node);
  }
  if (node.type !== "import_statement") {
    return [];
  }

  const bindings: ImportBinding[] = [];
  let importClause = node.childForFieldName("clause");
  if (!importClause) {
    for (let i = 0; i < node.childCount; i++) {
      if (node.child(i)!.type === "import_clause") {
        importClause = node.child(i);
        break;
      }
    }
  }

  if (!importClause) {
    return [];
  }

  for (let i = 0; i < importClause.childCount; i++) {
    const child = importClause.child(i)!;
    if (child.type === "identifier") {
      bindings.push({
        localName: child.text,
        importedName: "default",
        kind: "default"
      });
    } else if (child.type === "namespace_import") {
      let ident = child.childForFieldName("alias");
      if (!ident) {
        for (let j = 0; j < child.childCount; j++) {
          if (child.child(j)!.type === "identifier") {
            ident = child.child(j);
            break;
          }
        }
      }
      if (ident) {
        bindings.push({
          localName: ident.text,
          kind: "namespace"
        });
      }
    } else if (child.type === "named_imports") {
      for (let j = 0; j < child.childCount; j++) {
        const spec = child.child(j)!;
        if (spec.type === "import_specifier") {
          const nameNode = spec.childForFieldName("name");
          const aliasNode = spec.childForFieldName("alias");
          if (nameNode) {
            bindings.push({
              localName: aliasNode ? aliasNode.text : nameNode.text,
              importedName: nameNode.text,
              kind: "named"
            });
          }
        }
      }
    }
  }

  return bindings.filter((binding) => binding.localName.length > 0);
}

function extractReExportBindings(node: Parser.SyntaxNode): ImportBinding[] {
  const bindings: ImportBinding[] = [];
  let hasAsterisk = false;
  let namespaceExport: Parser.SyntaxNode | null = null;
  let exportClause: Parser.SyntaxNode | null = null;

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)!;
    if (child.type === "*") {
      hasAsterisk = true;
    } else if (child.type === "namespace_export") {
      namespaceExport = child;
    } else if (child.type === "export_clause") {
      exportClause = child;
    }
  }

  if (hasAsterisk && !namespaceExport) {
    return [{ localName: "*", kind: "namespace" }];
  }

  if (namespaceExport) {
    let ident = namespaceExport.childForFieldName("alias");
    if (!ident) {
      for (let j = 0; j < namespaceExport.childCount; j++) {
        if (namespaceExport.child(j)!.type === "identifier") {
          ident = namespaceExport.child(j);
          break;
        }
      }
    }
    if (ident) {
      return [{ localName: ident.text, kind: "namespace" }];
    }
  }

  if (exportClause) {
    for (let j = 0; j < exportClause.childCount; j++) {
      const spec = exportClause.child(j)!;
      if (spec.type === "export_specifier") {
        const nameNode = spec.childForFieldName("name");
        const aliasNode = spec.childForFieldName("alias");
        if (nameNode) {
          bindings.push({
            localName: aliasNode ? aliasNode.text : nameNode.text,
            importedName: nameNode.text,
            kind: "named"
          });
        }
      }
    }
  }

  return bindings.filter((binding) => binding.localName.length > 0);
}
