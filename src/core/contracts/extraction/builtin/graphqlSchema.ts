import {
  parse,
  buildASTSchema,
  GraphQLSchema,
  GraphQLType,
  isNonNullType,
  isListType
} from "graphql";

export function parseGraphQLSchema(sdl: string): GraphQLSchema | undefined {
  try {
    const document = parse(sdl);
    return buildASTSchema(document);
  } catch {
    return undefined;
  }
}

export function formatGraphQLType(type: GraphQLType): string {
  if (isNonNullType(type)) {
    return formatGraphQLType(type.ofType) + "!";
  }
  if (isListType(type)) {
    return "[" + formatGraphQLType(type.ofType) + "]";
  }
  return type.name;
}

export function getBaseTypeName(type: GraphQLType): string {
  let curr = type;
  while (isNonNullType(curr) || isListType(curr)) {
    curr = curr.ofType;
  }
  return curr.name;
}

export function getLineFromLoc(loc: any): number | undefined {
  if (!loc) return undefined;
  const textUpToStart = loc.source.body.slice(0, loc.start);
  return textUpToStart.split(/\r?\n/).length;
}

export type ExtractedClientOperation = {
  operationType: "query" | "mutation" | "subscription";
  fieldName: string;
  operationName?: string;
  line: number;
  raw: string;
};

export function extractClientOperations(source: string): ExtractedClientOperation[] {
  try {
    const doc = parse(source);
    const results: ExtractedClientOperation[] = [];
    for (const def of doc.definitions) {
      if (def.kind === "OperationDefinition") {
        const operationType = def.operation;
        const operationName = def.name?.value;
        if (def.selectionSet && def.selectionSet.selections) {
          for (const selection of def.selectionSet.selections) {
            if (selection.kind === "Field") {
              const fieldName = selection.name.value;
              const line = getLineFromLoc(selection.loc) ?? 1;
              const raw = selection.loc
                ? selection.loc.source.body.slice(selection.loc.start, selection.loc.end)
                : fieldName;
              results.push({
                operationType,
                fieldName,
                operationName,
                line,
                raw
              });
            }
          }
        }
      }
    }
    return results;
  } catch {
    return [];
  }
}

export function findGqlTemplateOccurrences(source: string): { content: string; line: number }[] {
  const occurrences: { content: string; line: number }[] = [];
  const regex = /(?:gql|graphql)\s*`([\s\S]*?)`/g;
  let match;
  while ((match = regex.exec(source)) !== null) {
    const index = match.index;
    const textBefore = source.slice(0, index);
    const line = textBefore.split(/\r?\n/).length;
    occurrences.push({
      content: match[1],
      line
    });
  }
  return occurrences;
}
