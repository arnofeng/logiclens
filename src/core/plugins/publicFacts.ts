import type { ContractRole, SemanticRelationKind } from "../parsing/types.js";
import type { GrpcStreaming, SchemaFieldSpec } from "../contracts/spec.js";
import type { EventBroker } from "../contracts/event.js";

export type PublicConfidence = "exact" | "probable" | "heuristic" | number;

export type PublicEvidence = {
  repoId: string;
  fileId?: string;
  filePath: string;
  line: number;
  raw: string;
  rule: string;
  confidence: PublicConfidence;
};

export type PublicHttpEndpointFact = {
  kind: "httpEndpoint";
  repoId: string;
  fileId?: string;
  filePath: string;
  method?: string;
  rawPath?: string;
  path: string;
  role: Extract<ContractRole, "producer" | "consumer">;
  framework?: string;
  sourceSymbolId?: string;
  requestBodyType?: string;
  responseBodyType?: string;
  evidence: PublicEvidence;
};

export type PublicSchemaFact = {
  kind: "schema";
  repoId: string;
  fileId?: string;
  filePath: string;
  name: string;
  language: string;
  fields: SchemaFieldSpec[];
  sourceSymbolId?: string;
  evidence: PublicEvidence;
};

export type PublicEventFact = {
  kind: "event";
  repoId: string;
  fileId?: string;
  filePath: string;
  topic: string;
  role: Extract<ContractRole, "producer" | "consumer">;
  broker?: EventBroker;
  framework?: string;
  payloadType?: string;
  sourceSymbolId?: string;
  evidence: PublicEvidence;
};

export type PublicGrpcMethodFact = {
  kind: "grpcMethod";
  repoId: string;
  fileId?: string;
  filePath: string;
  service: string;
  method: string;
  fullName: string;
  role: Extract<ContractRole, "producer" | "consumer">;
  package?: string;
  requestType?: string;
  responseType?: string;
  streaming?: GrpcStreaming;
  framework?: "proto" | "grpc-go" | "grpc-java" | "grpc-python" | "grpc-js";
  sourceSymbolId?: string;
  evidence: PublicEvidence;
};

export type PublicPackageUsageFact = {
  kind: "packageUsage";
  repoId: string;
  fileId?: string;
  filePath: string;
  packageName: string;
  role?: Extract<ContractRole, "owner" | "consumer">;
  evidence: PublicEvidence;
};

export type PublicSemanticRelationFact = {
  kind: "semanticRelation";
  fromSpecId: string;
  toSpecId: string;
  relation: SemanticRelationKind;
  evidence: PublicEvidence;
  reason: string;
};

export type PublicContractFact =
  | PublicHttpEndpointFact
  | PublicSchemaFact
  | PublicEventFact
  | PublicGrpcMethodFact
  | PublicPackageUsageFact
  | PublicSemanticRelationFact;
