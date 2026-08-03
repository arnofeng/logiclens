import { schemaFieldTypeName, type SchemaSpec } from "../../src/core/contracts/spec.js";
import { createSchemaSpec, schemaFieldFromNormalized } from "../../src/core/schema/model.js";

export function makeTestSchema(input: {
  name: string;
  language?: string;
  repoId?: string;
  fileId?: string;
  fields?: { name: string; type: string; optional?: boolean; nullable?: boolean; sourceLine?: number }[];
}): SchemaSpec {
  const languageId = input.language ?? "typescript";
  const repoId = input.repoId ?? "repo:test";
  const fileId = input.fileId ?? `file:${repoId}:${input.name}`;
  return createSchemaSpec({
    declaration: { languageId, repoId, resolutionScopeId: "test", canonicalName: input.name },
    displayName: input.name,
    shape: {
      kind: "object",
      fields: (input.fields ?? []).map((field) => schemaFieldFromNormalized({
        languageId,
        repoId,
        fileId,
        sourceName: field.name,
        normalizedType: field.type,
        optional: field.optional ?? false,
        nullable: field.nullable,
        line: field.sourceLine
      }))
    }
  });
}

export function objectSchemaFields(spec: SchemaSpec): Array<{ name: string; type: string; optional: boolean; nullable?: boolean; sourceLine?: number }> {
  if (spec.shape.kind !== "object") throw new Error(`Expected object schema ${spec.displayName}.`);
  return spec.shape.fields.map((field) => ({
    name: field.serializedName,
    type: `${schemaFieldTypeName(field)}${field.nullable && !schemaFieldTypeName(field).endsWith("?") ? "?" : ""}`,
    optional: field.optional,
    nullable: field.nullable || undefined,
    sourceLine: field.sourceLocation.line
  }));
}
