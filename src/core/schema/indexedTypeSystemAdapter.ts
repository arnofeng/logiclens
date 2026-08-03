import type {
  CanonicalTypeExpression,
  ResolutionContextFact,
  SchemaDiagnosticFact,
  SchemaFieldSpec,
  TypeDeclarationFact,
  TypeExpression,
  TypeInstanceIdentity,
  SchemaFieldType
} from "./model.js";
import { createTypeInstanceIdentity, stableFactId, typeDeclarationIdentityId, typeInstanceIdentityId } from "./model.js";
import type { ParsedSourceSet, ResolutionResult, SchemaShape, TypeProjection, TypeSystemAdapter } from "./typeSystem.js";

export type BuiltinTypeRule = {
  canonicalSymbol: string;
  sourceSymbols?: readonly string[];
  behavior: "transparent" | "collection" | "map-value" | "materialized";
  argumentIndexes?: readonly number[];
};

export interface IndexedTypeSystemRules {
  languageId: string;
  adapterVersion: string;
  ruleSetVersion: string;
  serializationVersion: string;
  maxDepth: number;
  maxTypesPerRoot: number;
  scalars: Readonly<Record<string, string>>;
  externalSymbols: readonly string[];
  wrappers: readonly BuiltinTypeRule[];
}

export interface IndexedSchemaDeclaration {
  fact: TypeDeclarationFact;
  shape: { kind: "object"; fields: SchemaFieldSpec[]; baseTypes?: TypeExpression[] } | { kind: "enum"; values: string[] };
}

export class IndexedTypeSystemAdapter implements TypeSystemAdapter {
  readonly languageId: string;
  readonly adapterVersion: string;
  readonly ruleSetVersion: string;
  readonly serializationVersion: string;
  readonly maxDepth: number;
  readonly maxTypesPerRoot: number;
  private readonly declarations: TypeDeclarationFact[];
  private readonly declarationsById: Map<string, IndexedSchemaDeclaration>;
  private readonly wrapperRules: Map<string, BuiltinTypeRule>;
  private readonly wrapperSourceSymbols: Map<string, string>;

  constructor(private readonly rules: IndexedTypeSystemRules, declarations: readonly IndexedSchemaDeclaration[]) {
    this.languageId = rules.languageId;
    this.adapterVersion = rules.adapterVersion;
    this.ruleSetVersion = rules.ruleSetVersion;
    this.serializationVersion = rules.serializationVersion;
    this.maxDepth = rules.maxDepth;
    this.maxTypesPerRoot = rules.maxTypesPerRoot;
    this.declarations = declarations.map((item) => item.fact);
    this.declarationsById = new Map(declarations.map((item) => [item.fact.id, item]));
    this.wrapperRules = new Map(rules.wrappers.map((rule) => [rule.canonicalSymbol, rule]));
    this.wrapperSourceSymbols = new Map(rules.wrappers.flatMap((rule) => (rule.sourceSymbols ?? []).map((source) => [source, rule.canonicalSymbol] as const)));
  }

  indexDeclarations(_input: ParsedSourceSet): TypeDeclarationFact[] {
    return [...this.declarations];
  }

  parseTypeExpression(raw: string, _context: ResolutionContextFact): TypeExpression {
    return parseTypeExpression(raw, this.languageId);
  }

  resolveType(expression: TypeExpression, context: ResolutionContextFact): ResolutionResult {
    const canonical = this.canonicalize(expression, context);
    if (canonical.kind === "diagnostic") return canonical.result;
    if (canonical.expression.kind === "scalar") {
      return { kind: "scalar", scalar: canonical.expression.name, expression: canonical.expression };
    }
    if (canonical.expression.kind !== "type-instance") {
      return { kind: "unsupported", diagnostic: this.diagnostic("unsupported", expression, context) };
    }
    const identity = createTypeInstanceIdentity(canonical.expression.declarationId, canonical.expression.arguments);
    if (!identity) return { kind: "unsupported", diagnostic: this.diagnostic("unsupported", expression, context) };
    const declaration = this.declarationsById.get(identity.declarationId)?.fact;
    if (!declaration || declaration.typeParameters.length !== identity.canonicalTypeArguments.length) {
      return { kind: "unsupported", diagnostic: this.diagnostic("unsupported", expression, context) };
    }
    return { kind: "resolved", instance: identity, expression: canonical.expression };
  }

  resolveFieldType(expression: TypeExpression, context: ResolutionContextFact): SchemaFieldType {
    const canonical = this.canonicalize(expression, context);
    if (canonical.kind === "canonical") return { kind: "resolved", expression: canonical.expression };
    const result = canonical.result;
    if (result.kind === "external") {
      return {
        kind: "external-symbol",
        symbol: { languageId: result.languageId, canonicalName: result.canonicalName },
        normalizedExpression: expression,
        diagnosticId: result.diagnostic.id
      };
    }
    return { kind: result.kind, normalizedExpression: expression, diagnosticId: result.diagnostic.id };
  }

  projectType(expression: TypeExpression, context: ResolutionContextFact): TypeProjection {
    if (expression.kind === "array") return { kind: "transparent", expressions: [expression.element], ruleId: `${this.ruleSetVersion}:array` };
    if (expression.kind === "map") {
      return this.resolveType(expression.key, context).kind === "scalar"
        ? { kind: "transparent", expressions: [expression.value], ruleId: `${this.ruleSetVersion}:map-value` }
        : { kind: "stop", reason: "unsupported" };
    }
    if (expression.kind === "nullable") return { kind: "transparent", expressions: [expression.inner], ruleId: `${this.ruleSetVersion}:nullable` };
    if (expression.kind === "union" || expression.kind === "intersection") {
      return { kind: "transparent", expressions: expression.members, ruleId: `${this.ruleSetVersion}:${expression.kind}` };
    }
    if (expression.kind === "application" && expression.target.kind === "reference") {
      const rule = this.wrapperRule(expression.target.name, context);
      if (rule && rule.behavior !== "materialized") {
        if (rule.behavior === "map-value") {
          const key = expression.arguments[0];
          const value = expression.arguments[1];
          return key && value && this.resolveType(key, context).kind === "scalar"
            ? { kind: "transparent", expressions: [value], ruleId: `${this.ruleSetVersion}:${rule.canonicalSymbol}` }
            : { kind: "stop", reason: "unsupported" };
        }
        const indexes = rule.argumentIndexes ?? [0];
        const expressions = indexes.flatMap((index) => expression.arguments[index] ? [expression.arguments[index]!] : []);
        return expressions.length > 0
          ? { kind: "transparent", expressions, ruleId: `${this.ruleSetVersion}:${rule.canonicalSymbol}` }
          : { kind: "stop", reason: "unsupported" };
      }
    }
    if (expression.kind === "reference") {
      const scalar = this.rules.scalars[expression.name];
      if (scalar) return { kind: "stop", reason: "scalar" };
      if (this.isExternal(expression.name)) return { kind: "stop", reason: "external" };
    }
    if (expression.kind === "opaque" || expression.kind === "variable" || expression.kind === "wildcard" || expression.kind === "literal") {
      return { kind: "stop", reason: "unsupported" };
    }
    return { kind: "materialized", expression };
  }

  inspectSchemaShape(instance: TypeInstanceIdentity): SchemaShape {
    const declaration = this.declarationsById.get(instance.declarationId);
    if (!declaration || declaration.fact.typeParameters.length !== instance.canonicalTypeArguments.length) return {
      kind: "unsupported",
      diagnostic: {
        id: stableFactId("schema-diagnostic", { code: "unsupported", instance: typeInstanceIdentityId(instance) }),
        generation: "",
        code: "unsupported"
      }
    };
    const bindings = new Map(declaration.fact.typeParameters.map((name, index) => [
      name,
      canonicalToTypeExpression(instance.canonicalTypeArguments[index]!)
    ]));
    if (declaration.shape.kind === "enum" || bindings.size === 0) return declaration.shape;
    return {
      kind: "object",
      fields: declaration.shape.fields.map((field) => substituteSchemaField(field, bindings)),
      baseTypes: declaration.shape.baseTypes?.map((expression) => substituteTypeExpression(expression, bindings))
    };
  }

  private canonicalize(expression: TypeExpression, context: ResolutionContextFact):
    | { kind: "canonical"; expression: CanonicalTypeExpression }
    | { kind: "diagnostic"; result: Exclude<ResolutionResult, { kind: "resolved" | "scalar" }> } {
    switch (expression.kind) {
      case "reference": {
        const scalar = this.rules.scalars[expression.name];
        if (scalar) return { kind: "canonical", expression: { kind: "scalar", name: scalar } };
        if (this.isExternal(expression.name)) {
          return { kind: "diagnostic", result: {
            kind: "external", languageId: this.languageId, canonicalName: expression.name,
            diagnostic: this.diagnostic("external", expression, context)
          } };
        }
        if (this.declarationsById.has(expression.name)) {
          return { kind: "canonical", expression: { kind: "type-instance", declarationId: expression.name, arguments: [] } };
        }
        const candidates = this.visibleDeclarations(expression.name, context);
        if (candidates.length === 0) return { kind: "diagnostic", result: { kind: "unresolved", diagnostic: this.diagnostic("unresolved", expression, context) } };
        if (candidates.length > 1) return { kind: "diagnostic", result: {
          kind: "ambiguous",
          diagnostic: this.diagnostic("ambiguous", expression, context, candidates)
        } };
        return { kind: "canonical", expression: { kind: "type-instance", declarationId: candidates[0]!.id, arguments: [] } };
      }
      case "application": {
        if (expression.target.kind === "reference") {
          const wrapper = this.wrapperRule(expression.target.name, context);
          if (wrapper && wrapper.behavior !== "materialized") {
            if (wrapper.behavior === "map-value") {
              const key = expression.arguments[0];
              const value = expression.arguments[1];
              if (!key || !value) return { kind: "diagnostic", result: { kind: "unsupported", diagnostic: this.diagnostic("unsupported", expression, context) } };
              const canonicalKey = this.canonicalize(key, context);
              if (canonicalKey.kind === "diagnostic" || canonicalKey.expression.kind !== "scalar") {
                return { kind: "diagnostic", result: { kind: "unsupported", diagnostic: this.diagnostic("unsupported", expression, context) } };
              }
              const canonicalValue = this.canonicalize(value, context);
              if (canonicalValue.kind === "diagnostic") return canonicalValue;
              return { kind: "canonical", expression: { kind: "map", key: canonicalKey.expression, value: canonicalValue.expression } };
            }
            const indexes = wrapper.argumentIndexes ?? [0];
            const selected: CanonicalTypeExpression[] = [];
            for (const index of indexes) {
              const argument = expression.arguments[index];
              if (!argument) return { kind: "diagnostic", result: { kind: "unsupported", diagnostic: this.diagnostic("unsupported", expression, context) } };
              const resolved = this.canonicalize(argument, context);
              if (resolved.kind === "diagnostic") return resolved;
              selected.push(resolved.expression);
            }
            if (selected.length !== 1) return { kind: "diagnostic", result: { kind: "unsupported", diagnostic: this.diagnostic("unsupported", expression, context) } };
            return wrapper.behavior === "collection"
              ? { kind: "canonical", expression: { kind: "array", element: selected[0]! } }
              : { kind: "canonical", expression: selected[0]! };
          }
        }
        const target = this.canonicalize(expression.target, context);
        if (target.kind === "diagnostic") return target;
        if (target.expression.kind !== "type-instance") {
          return { kind: "diagnostic", result: { kind: "unsupported", diagnostic: this.diagnostic("unsupported", expression, context) } };
        }
        const args: CanonicalTypeExpression[] = [];
        for (const argument of expression.arguments) {
          const resolved = this.canonicalize(argument, context);
          if (resolved.kind === "diagnostic") return resolved;
          args.push(resolved.expression);
        }
        return { kind: "canonical", expression: { kind: "type-instance", declarationId: target.expression.declarationId, arguments: args } };
      }
      case "array": return this.canonicalContainer("array", expression.element, context);
      case "map": {
        const key = this.canonicalize(expression.key, context);
        if (key.kind === "diagnostic" || key.expression.kind !== "scalar") {
          return { kind: "diagnostic", result: { kind: "unsupported", diagnostic: this.diagnostic("unsupported", expression, context) } };
        }
        const value = this.canonicalize(expression.value, context);
        if (value.kind === "diagnostic") return value;
        return { kind: "canonical", expression: { kind: "map", key: key.expression, value: value.expression } };
      }
      case "nullable": return this.canonicalContainer("nullable", expression.inner, context);
      case "union": return this.canonicalMembers("union", expression.members, context);
      case "intersection": return this.canonicalMembers("intersection", expression.members, context);
      case "literal": return { kind: "canonical", expression };
      case "opaque":
      case "variable":
      case "wildcard": return { kind: "diagnostic", result: { kind: "unsupported", diagnostic: this.diagnostic("unsupported", expression, context) } };
    }
  }

  private canonicalContainer(kind: "array" | "nullable", value: TypeExpression, context: ResolutionContextFact): ReturnType<IndexedTypeSystemAdapter["canonicalize"]> {
    const inner = this.canonicalize(value, context);
    if (inner.kind === "diagnostic") return inner;
    return kind === "array"
      ? { kind: "canonical", expression: { kind: "array", element: inner.expression } }
      : { kind: "canonical", expression: { kind: "nullable", inner: inner.expression } };
  }

  private canonicalMembers(kind: "union" | "intersection", members: TypeExpression[], context: ResolutionContextFact): ReturnType<IndexedTypeSystemAdapter["canonicalize"]> {
    const canonical: CanonicalTypeExpression[] = [];
    for (const member of members) {
      const resolved = this.canonicalize(member, context);
      if (resolved.kind === "diagnostic") return resolved;
      canonical.push(resolved.expression);
    }
    canonical.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    return kind === "union"
      ? { kind: "canonical", expression: { kind: "union", members: canonical } }
      : { kind: "canonical", expression: { kind: "intersection", members: canonical } };
  }

  private visibleDeclarations(name: string, context: ResolutionContextFact): TypeDeclarationFact[] {
    const exact = this.declarations.filter((fact) => fact.identity.languageId === this.languageId
      && fact.identity.repoId === context.repoId
      && fact.identity.resolutionScopeId === context.resolutionScopeId
      && fact.identity.canonicalName === name);
    if (exact.length > 0) return exact;
    const localIds = new Set(context.imports
      .filter((binding) => binding.localName === name && binding.resolutionScopeId === context.resolutionScopeId)
      .map((binding) => binding.declarationId));
    const local = this.declarations.filter((fact) => fact.identity.languageId === this.languageId
      && fact.identity.repoId === context.repoId
      && localIds.has(fact.id));
    if (local.length > 0) return local;
    const importedIds = new Set(context.imports
      .filter((binding) => binding.localName === name)
      .map((binding) => binding.declarationId));
    return this.declarations.filter((fact) => fact.identity.languageId === this.languageId
      && fact.identity.repoId === context.repoId
      && importedIds.has(fact.id));
  }

  private wrapperRule(sourceSymbol: string, context: ResolutionContextFact): BuiltinTypeRule | undefined {
    const direct = this.wrapperRules.get(sourceSymbol);
    if (direct) return direct;
    if (this.visibleDeclarations(sourceSymbol, context).length > 0) return undefined;
    const canonicalSymbol = this.wrapperSourceSymbols.get(sourceSymbol);
    if (!canonicalSymbol) return undefined;
    return this.wrapperRules.get(canonicalSymbol);
  }

  private isExternal(name: string): boolean {
    return this.rules.externalSymbols.some((symbol) => name === symbol || name.startsWith(`${symbol}.`));
  }

  private diagnostic(code: SchemaDiagnosticFact["code"], expression: TypeExpression, context: ResolutionContextFact, candidates: TypeDeclarationFact[] = []): SchemaDiagnosticFact {
    const identities = candidates.map((candidate) => candidate.identity);
    return {
      id: stableFactId("schema-diagnostic", { code, expression, scope: { languageId: context.languageId, repoId: context.repoId, resolutionScopeId: context.resolutionScopeId }, candidates: identities }),
      generation: context.generation,
      repoId: context.repoId,
      sourceFileId: context.fileId,
      scope: { languageId: context.languageId, repoId: context.repoId, resolutionScopeId: context.resolutionScopeId },
      code,
      symbol: expression.kind === "reference" ? expression.name : undefined,
      candidates: identities.length > 0 ? identities : undefined
    };
  }
}

export function parseTypeExpression(raw: string, languageId: string): TypeExpression {
  const value = raw.trim();
  if (!value) return { kind: "opaque", languageId, canonicalText: value };
  if (value.endsWith("?")) return { kind: "nullable", inner: parseTypeExpression(value.slice(0, -1), languageId) };
  if (value.endsWith("[]")) return { kind: "array", element: parseTypeExpression(value.slice(0, -2), languageId) };
  const union = splitTopLevel(value, "|");
  if (union.length > 1) return { kind: "union", members: union.map((member) => parseTypeExpression(member, languageId)) };
  const intersection = splitTopLevel(value, "&");
  if (intersection.length > 1) return { kind: "intersection", members: intersection.map((member) => parseTypeExpression(member, languageId)) };
  const genericStart = value.indexOf("<");
  if (genericStart > 0 && value.endsWith(">")) {
    return {
      kind: "application",
      target: { kind: "reference", name: value.slice(0, genericStart).trim() },
      arguments: splitTopLevel(value.slice(genericStart + 1, -1), ",").map((argument) => parseTypeExpression(argument, languageId))
    };
  }
  return { kind: "reference", name: value.replace(/^global::/u, "").replace(/^\./u, "") };
}

function substituteSchemaField(field: SchemaFieldSpec, bindings: ReadonlyMap<string, TypeExpression>): SchemaFieldSpec {
  if (field.type.kind === "resolved") return field;
  return {
    ...field,
    type: {
      ...field.type,
      normalizedExpression: substituteTypeExpression(field.type.normalizedExpression, bindings)
    }
  };
}

function substituteTypeExpression(expression: TypeExpression, bindings: ReadonlyMap<string, TypeExpression>): TypeExpression {
  switch (expression.kind) {
    case "reference": return bindings.get(expression.name) ?? expression;
    case "variable": return bindings.get(expression.name) ?? expression;
    case "application": return {
      kind: "application",
      target: substituteTypeExpression(expression.target, bindings),
      arguments: expression.arguments.map((argument) => substituteTypeExpression(argument, bindings))
    };
    case "array": return { kind: "array", element: substituteTypeExpression(expression.element, bindings) };
    case "map": return {
      kind: "map",
      key: substituteTypeExpression(expression.key, bindings),
      value: substituteTypeExpression(expression.value, bindings)
    };
    case "union": return { kind: "union", members: expression.members.map((member) => substituteTypeExpression(member, bindings)) };
    case "intersection": return { kind: "intersection", members: expression.members.map((member) => substituteTypeExpression(member, bindings)) };
    case "wildcard": return {
      kind: "wildcard",
      bound: expression.bound,
      type: expression.type ? substituteTypeExpression(expression.type, bindings) : undefined
    };
    case "nullable": return { kind: "nullable", inner: substituteTypeExpression(expression.inner, bindings) };
    case "literal":
    case "opaque": return expression;
  }
}

function canonicalToTypeExpression(expression: CanonicalTypeExpression): TypeExpression {
  switch (expression.kind) {
    case "type-instance": return expression.arguments.length === 0
      ? { kind: "reference", name: expression.declarationId }
      : {
        kind: "application",
        target: { kind: "reference", name: expression.declarationId },
        arguments: expression.arguments.map(canonicalToTypeExpression)
      };
    case "scalar": return { kind: "reference", name: expression.name };
    case "array": return { kind: "array", element: canonicalToTypeExpression(expression.element) };
    case "map": return { kind: "map", key: canonicalToTypeExpression(expression.key), value: canonicalToTypeExpression(expression.value) };
    case "union": return { kind: "union", members: expression.members.map(canonicalToTypeExpression) };
    case "intersection": return { kind: "intersection", members: expression.members.map(canonicalToTypeExpression) };
    case "wildcard": return {
      kind: "wildcard",
      bound: expression.bound,
      type: expression.type ? canonicalToTypeExpression(expression.type) : undefined
    };
    case "nullable": return { kind: "nullable", inner: canonicalToTypeExpression(expression.inner) };
    case "literal": return expression;
  }
}

function splitTopLevel(value: string, separator: string): string[] {
  const result: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (character === "<" || character === "(" || character === "[") depth++;
    else if (character === ">" || character === ")" || character === "]") depth--;
    else if (character === separator && depth === 0) {
      result.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  result.push(value.slice(start).trim());
  return result.filter(Boolean);
}

export function declarationIdFor(fact: TypeDeclarationFact): string {
  return fact.id || typeDeclarationIdentityId(fact.identity);
}
