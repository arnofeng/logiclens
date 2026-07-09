import { entityId, fileId, normalizeName } from "../../shared/path.js";
import { canonicalEventContractKey } from "../contracts/event.js";
import type { ContractSpec, EventSpec, GrpcMethodSpec, HttpEndpointSpec, SchemaSpec } from "../contracts/spec.js";
import type { ContractNode, ContractRole } from "../parsing/types.js";
import { apiPathParams, apiPathTemplate, contract, evidence, grpcContract, httpApiContract, operationVerb, pushContractEvidence, toBusinessEntityName } from "../contracts/extraction/builtin/shared.js";
import type { FactCollector } from "../contracts/extraction/factCollector.js";
import type { PublicConfidence, PublicContractFact, PublicEvidence } from "./publicFacts.js";

export function normalizePublicFacts(facts: readonly PublicContractFact[], collector: FactCollector): void {
  for (const fact of facts) {
    switch (fact.kind) {
      case "httpEndpoint":
        emitHttpEndpoint(fact, collector);
        break;
      case "schema":
        emitSchema(fact, collector);
        break;
      case "event":
        emitEvent(fact, collector);
        break;
      case "grpcMethod":
        emitGrpcMethod(fact, collector);
        break;
      case "packageUsage":
        emitPackageUsage(fact, collector);
        break;
      case "semanticRelation":
        collector.addSemanticRelation({
          fromSpecId: fact.fromSpecId,
          toSpecId: fact.toSpecId,
          kind: fact.relation,
          evidenceId: toEvidenceNode(fact.evidence).id,
          reason: fact.reason,
          confidence: confidenceValue(fact.evidence.confidence)
        });
        collector.addEvidence(toEvidenceNode(fact.evidence));
        break;
      default:
        assertNever(fact);
    }
  }
}

function emitHttpEndpoint(fact: Extract<PublicContractFact, { kind: "httpEndpoint" }>, collector: FactCollector): void {
  const method = fact.method?.trim().toUpperCase();
  const path = normalizeHttpPath(fact.path);
  const contractNode = httpApiContract(method, path, `HTTP API ${path}`);
  const evidenceNode = toEvidenceNode({ ...fact.evidence, repoId: fact.repoId, fileId: fact.fileId, filePath: fact.filePath });
  pushContractEvidence(collector, fact.repoId, contractNode, fact.role, evidenceNode);
  pushOperationFacts(collector, fact.repoId, contractNode, fact.role, evidenceNode.id, evidenceNode.confidence);
  const spec: HttpEndpointSpec = {
    kind: "http-endpoint",
    method: method as HttpEndpointSpec["method"],
    path,
    pathTemplate: apiPathTemplate(contractNode.key),
    pathParams: apiPathParams(apiPathTemplate(contractNode.key)),
    requestBodyType: fact.requestBodyType,
    responseBodyType: fact.responseBodyType,
    auth: "unknown"
  };
  pushSpec(collector, fact, contractNode.id, contractNode.key, spec, evidenceNode.id, evidenceNode.confidence, fact.framework, method, apiPathTemplate(contractNode.key));
}

function emitSchema(fact: Extract<PublicContractFact, { kind: "schema" }>, collector: FactCollector): void {
  const contractNode = contract("schema", fact.name);
  const evidenceNode = toEvidenceNode({ ...fact.evidence, repoId: fact.repoId, fileId: fact.fileId, filePath: fact.filePath });
  pushContractEvidence(collector, fact.repoId, contractNode, "shared", evidenceNode);
  const spec: SchemaSpec = {
    kind: "schema",
    name: fact.name,
    language: fact.language,
    fields: fact.fields
  };
  pushSpec(collector, fact, contractNode.id, contractNode.key, spec, evidenceNode.id, evidenceNode.confidence);
}

function emitEvent(fact: Extract<PublicContractFact, { kind: "event" }>, collector: FactCollector): void {
  const contractNode = contract("event", fact.topic);
  const evidenceNode = toEvidenceNode({ ...fact.evidence, repoId: fact.repoId, fileId: fact.fileId, filePath: fact.filePath });
  pushContractEvidence(collector, fact.repoId, contractNode, fact.role, evidenceNode);
  pushOperationFacts(collector, fact.repoId, contractNode, fact.role, evidenceNode.id, evidenceNode.confidence);
  const spec: EventSpec = {
    kind: "event",
    topic: canonicalEventContractKey(fact.topic),
    payloadType: fact.payloadType,
    broker: fact.broker ?? "unknown"
  };
  pushSpec(collector, fact, contractNode.id, contractNode.key, spec, evidenceNode.id, evidenceNode.confidence, fact.framework, undefined, undefined, contractNode.key);
}

function emitGrpcMethod(fact: Extract<PublicContractFact, { kind: "grpcMethod" }>, collector: FactCollector): void {
  const contractNode = grpcContract(fact.fullName, `gRPC ${fact.fullName}`);
  const evidenceNode = toEvidenceNode({ ...fact.evidence, repoId: fact.repoId, fileId: fact.fileId, filePath: fact.filePath });
  pushContractEvidence(collector, fact.repoId, contractNode, fact.role, evidenceNode);
  pushOperationFacts(collector, fact.repoId, contractNode, fact.role, evidenceNode.id, evidenceNode.confidence);
  const spec: GrpcMethodSpec = {
    kind: "grpc-method",
    service: fact.service,
    method: fact.method,
    package: fact.package,
    fullName: fact.fullName,
    requestType: fact.requestType,
    responseType: fact.responseType,
    streaming: fact.streaming ?? "unary",
    framework: fact.framework
  };
  pushSpec(collector, fact, contractNode.id, contractNode.key, spec, evidenceNode.id, evidenceNode.confidence, fact.framework);
}

function emitPackageUsage(fact: Extract<PublicContractFact, { kind: "packageUsage" }>, collector: FactCollector): void {
  const contractNode = contract("package", fact.packageName, `Package ${fact.packageName}`);
  const evidenceNode = toEvidenceNode({ ...fact.evidence, repoId: fact.repoId, fileId: fact.fileId, filePath: fact.filePath });
  pushContractEvidence(collector, fact.repoId, contractNode, fact.role ?? "consumer", evidenceNode);
  collector.addPackageUsage({
    repoId: fact.repoId,
    packageContractId: contractNode.id,
    packageName: fact.packageName,
    evidenceId: evidenceNode.id,
    raw: evidenceNode.raw,
    confidence: evidenceNode.confidence
  });
}

function pushSpec(
  collector: FactCollector,
  fact: { repoId: string; fileId?: string; filePath: string; sourceSymbolId?: string },
  contractId: string,
  canonicalKey: string,
  spec: ContractSpec,
  evidenceIdValue: string,
  confidence: number,
  framework?: string,
  httpMethod?: string,
  pathTemplate?: string,
  eventTopic?: string
): void {
  const specId = `spec:${normalizeName(`${contractId}:${evidenceIdValue}`)}`;
  collector.addContractSpec({
    id: specId,
    contractId,
    specKind: spec.kind,
    repoId: fact.repoId,
    fileId: fact.fileId ?? fileId(fact.repoId, fact.filePath),
    evidenceId: evidenceIdValue,
    sourceSymbolId: fact.sourceSymbolId,
    canonicalKey,
    httpMethod,
    pathTemplate,
    eventTopic,
    framework,
    specJson: JSON.stringify(spec),
    confidence
  });
  collector.addContractSpecEdge({
    contractId,
    specId,
    evidenceId: evidenceIdValue,
    confidence
  });
}

function pushOperationFacts(
  collector: FactCollector,
  repoId: string,
  contractNode: ContractNode,
  role: ContractRole,
  evidenceIdValue: string,
  confidence: number
): void {
  const entityName = toBusinessEntityName(contractNode);
  if (!entityName) return;
  collector.addEntity({ id: entityId(entityName), name: entityName, kind: "domain", description: "Domain entity inferred from plugin facts" });
  collector.addContractEntity({ contractId: contractNode.id, entityId: entityId(entityName), evidenceId: evidenceIdValue, confidence });
  const verb = operationVerb(contractNode, role);
  const operationId = `operation:${normalizeName(`${verb}:${entityName}:${contractNode.key}:${repoId}`)}`;
  collector.addOperation({ id: operationId, verb, entityName, description: `${role} ${contractNode.kind} ${contractNode.key}` });
  collector.addOperationRepo({ operationId, repoId, role, evidenceId: evidenceIdValue, confidence });
}

function toEvidenceNode(input: PublicEvidence) {
  return evidence({
    repoId: input.repoId,
    fileId: input.fileId ?? fileId(input.repoId, input.filePath),
    filePath: input.filePath,
    line: input.line,
    raw: input.raw,
    rule: input.rule,
    confidence: confidenceValue(input.confidence)
  });
}

function confidenceValue(value: PublicConfidence): number {
  if (typeof value === "number") return Math.max(0, Math.min(1, value));
  if (value === "exact") return 0.95;
  if (value === "probable") return 0.8;
  return 0.6;
}

function normalizeHttpPath(value: string): string {
  const normalized = value.trim().replace(/\\/g, "/").replace(/\/+/g, "/");
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled public fact kind: ${JSON.stringify(value)}`);
}
