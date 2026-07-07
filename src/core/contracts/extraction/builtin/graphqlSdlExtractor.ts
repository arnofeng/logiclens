import { compatExtractor } from "./compat.js";
import type { FactCollector } from "../factCollector.js";
import { parsedCodeFiles, contract, evidence, pushContractEvidence, pushContractSpec, pushGraphqlContract } from "./shared.js";
import { parseGraphQLSchema, formatGraphQLType, getBaseTypeName, getLineFromLoc } from "./graphqlSchema.js";
import { isObjectType, isInputObjectType, isNonNullType } from "graphql";
import { normalizeName } from "../../../../shared/path.js";

export const graphqlSdlExtractor = compatExtractor({
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
          const extractedFields = Object.values(fields).map((field) => ({
            name: field.name,
            type: formatGraphQLType(field.type),
            optional: !isNonNullType(field.type),
            nullable: !isNonNullType(field.type),
            sourceLine: getLineFromLoc(field.astNode?.loc)
          }));

          const schemaSpec = {
            kind: "schema" as const,
            name: typeName,
            language: "graphql",
            fields: extractedFields
          };

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

          const requestType = field.args.length > 0 ? getBaseTypeName(field.args[0].type) : undefined;
          const responseType = getBaseTypeName(field.type);

          const { contractNode: opContract, evidenceNode: opEvidence } = pushGraphqlContract({
            collector,
            file,
            operationType,
            field: fieldName,
            role: "shared",
            line: fieldLine,
            raw: rawFieldText.slice(0, 160),
            rule: "graphql-sdl-operation",
            confidence: 1.0,
            requestType,
            responseType,
            source: "sdl"
          });

          const opSpecId = `spec:${normalizeName(`${opContract.id}:${opEvidence.id}`)}`;

          // Connect operation to response type
          collector.addSemanticRelation({
            fromSpecId: opSpecId,
            toSpecId: `schema-ref:${responseType}`,
            kind: "RESPONSE_SCHEMA",
            evidenceId: opEvidence.id,
            reason: `GraphQL operation response schema: ${responseType}`,
            confidence: 1.0
          });

          // Connect operation to all argument types
          for (const arg of field.args) {
            const argBaseType = getBaseTypeName(arg.type);
            collector.addSemanticRelation({
              fromSpecId: opSpecId,
              toSpecId: `schema-ref:${argBaseType}`,
              kind: "REQUEST_SCHEMA",
              evidenceId: opEvidence.id,
              reason: `GraphQL operation request schema for arg ${arg.name}: ${argBaseType}`,
              confidence: 1.0
            });
          }
        }
      }
    }
  }
});
