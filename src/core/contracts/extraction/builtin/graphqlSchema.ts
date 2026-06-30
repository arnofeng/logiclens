import {
  parse,
  buildASTSchema,
  GraphQLSchema,
  GraphQLType,
  isObjectType,
  isInputObjectType,
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
