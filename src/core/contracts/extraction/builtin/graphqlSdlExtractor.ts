import { defineBuiltinExtractor } from "./defineBuiltinExtractor.js";
import type { FactCollector } from "../factCollector.js";
import { parsedCodeFiles, contract, evidence, pushContractEvidence, pushContractSpec, pushGraphqlContract } from "./shared.js";
import { parseGraphQLSchema, formatGraphQLType, getBaseTypeName, getLineFromLoc } from "./graphqlSchema.js";
import { isObjectType, isInputObjectType, isNonNullType } from "graphql";
import { createSchemaSpec, schemaFieldFromNormalized } from "../../../schema/model.js";
import { normalizePrimitiveType } from "../../spec.js";
import { resolutionScopeIdForFile } from "../../../schema/sourceScopes.js";

export const graphqlSdlExtractor = defineBuiltinExtractor({
  name: "builtin:graphql-sdl",
  languages: ["graphql"],
  extract(context, collector: FactCollector) {
    for (const file of parsedCodeFiles(context.parsedFiles)) {
      if (file.language !== "graphql") continue;
      if (!file.source) continue;

      const schema = parseGraphQLSchema(file.source);
      if (!schema) continue;

      // 1. Extract all object and input types as SchemaSpecs (including Query/Mutation/Subscription themselves!)
      const typeMap = schema.getTypeMap();
      for (const [typeName, type] of Object.entries(typeMap)) {
        if (typeName.startsWith("__")) continue;
        if (["String", "Int", "Float", "Boolean", "ID"].includes(typeName)) continue;

        if (isObjectType(type) || isInputObjectType(type)) {
          const fields = type.getFields();
          const extractedFields = Object.values(fields).map((field) => schemaFieldFromNormalized({
            languageId: "graphql",
            repoId: file.repoId,
            fileId: file.fileId,
            sourceName: field.name,
            normalizedType: normalizePrimitiveType("graphql", formatGraphQLType(field.type)),
            optional: !isNonNullType(field.type),
            nullable: !isNonNullType(field.type),
            line: getLineFromLoc(field.astNode?.loc)
          }));

          const schemaSpec = createSchemaSpec({
            declaration: { languageId: "graphql", repoId: file.repoId, resolutionScopeId: resolutionScopeIdForFile(file), canonicalName: typeName },
            displayName: typeName,
            shape: { kind: "object", fields: extractedFields }
          });

          const schemaContract = contract("schema", typeName, `GraphQL Schema ${typeName}`);
          const typeLine = getLineFromLoc(type.astNode?.loc) ?? 1;
          const raw = type.astNode?.loc
            ? type.astNode.loc.source.body.slice(type.astNode.loc.start, type.astNode.loc.end)
            : `type ${typeName}`;

          const evNode = evidence({
            repoId: file.repoId,
            fileId: file.fileId,
            filePath: file.path,
            line: typeLine,
            raw: raw.slice(0, 160),
            rule: "graphql-schema-type",
            confidence: 1.0
          });

          pushContractEvidence(collector, file.repoId, schemaContract, "shared", evNode);

          pushContractSpec({
            collector,
            contractNode: schemaContract,
            spec: schemaSpec,
            repoId: file.repoId,
            fileId: file.fileId,
            evidenceNode: evNode,
            sourceSymbolId: undefined
          });
        }
      }

      // 2. Extract root operations: Query, Mutation, Subscription
      const rootTypes = [
        { type: schema.getQueryType(), operationType: "query" as const },
        { type: schema.getMutationType(), operationType: "mutation" as const },
        { type: schema.getSubscriptionType(), operationType: "subscription" as const }
      ];

      for (const { type, operationType } of rootTypes) {
        if (!type) continue;

        for (const field of Object.values(type.getFields())) {
          const fieldName = field.name;
          const fieldLine = getLineFromLoc(field.astNode?.loc) ?? 1;
          const rawFieldText = field.astNode?.loc
            ? field.astNode.loc.source.body.slice(field.astNode.loc.start, field.astNode.loc.end)
            : `${fieldName}`;

          const requestTypes = field.args.map((argument) => getBaseTypeName(argument.type));
          const responseType = getBaseTypeName(field.type);

          pushGraphqlContract({
            collector,
            file,
            operationType,
            field: fieldName,
            role: "shared",
            line: fieldLine,
            raw: rawFieldText.slice(0, 160),
            rule: "graphql-sdl-operation",
            confidence: 1.0,
            requestTypes,
            responseType,
            source: "sdl"
          });

        }
      }
    }
  }
});
