import {
  createClient,
  GraphClient,
  AppClient,
  type ClientOptions,
  type AppClientOptions,
  type ImpactResult
} from "./interfaces/sdk/client.js";

import type {
  LanguageParser,
  ParseInput,
  ExtractContext
} from "./core/registries/types.js";

import { canonicalContractKey } from "./core/contracts/extraction/crossRepoContracts.js";
import { createContractId, createEvidenceId, normalizeRuleName } from "./core/registries/helpers.js";

import type { Stats } from "./core/graph-model/db.js";
import type { DependencyRow, ContractSummaryRow } from "./core/graph-model/queries.js";
import type { RetrievalResult } from "./features/ask/retrieve.js";
import type {
  RetrievalDiagnostics,
  RetrievalOutcome,
  RetrievalRouteDiagnostic,
  RetrievalStageDiagnostic,
  RetrievalStageStatus,
} from "./features/ask/diagnostics.js";
import type {
  AskOptions,
  RetrieveOptions,
} from "./features/ask/options.js";
import type {
  CandidateConfidence,
  CandidateSourceKind,
  CandidateLocation,
  CandidateProvenance,
  CandidateRouteMembership,
  RetrievalCandidate,
} from "./features/ask/candidates.js";
import type { FusedRetrievalCandidate } from "./features/ask/fusion.js";
import type {
  SelectionRejection,
  SelectionRejectionReason,
} from "./features/ask/selection.js";
import type {
  LoadedEvidence,
  SourceLoadRejection,
  SourceLoadRejectionReason,
  SourceLoadStatus,
} from "./features/ask/sourceLoader.js";
import type {
  RagAnswerContext,
  RagCitation,
  RagContextItem,
} from "./features/ask/context.js";
import type { QueryPlanningContext } from "./features/ask/planningContext.js";
import type {
  AnnotationArgument,
  AnnotationFact,
  DecoratorFact,
  LiteralFact,
  ParsedSourceFacts
} from "./core/parsing/facts.js";
import type { CallRef, CodeSymbol, ImportRef, ParsedFile } from "./core/parsing/types.js";
import type { AppConfig } from "./config/schema.js";
import type { SemanticTraceEdge, SemanticTraceGraph, SemanticTraceNode } from "./core/contracts/semanticTrace.js";
import type { IndexOptions, IndexResult } from "./core/indexing/types.js";
import type {
  BenchmarkOptions,
  BenchmarkQuery,
  IndexingBenchmarkReport,
  IndexingBenchmarkSample,
  PercentileSummary,
  RetrievalBenchmarkReport,
  StageBenchmark,
  StageSample,
  WorkspaceBenchmarkReport,
} from "./core/retrieval/benchmark.js";
export {
  DEFAULT_RETRIEVE_OPTIONS,
  RETRIEVE_OPTION_LIMITS,
  normalizeRetrieveOptions,
} from "./features/ask/options.js";
export {
  assertLexicalProviderReady,
  resolveLexicalProvider,
  summarizeLexicalProviderGate,
} from "./core/retrieval/provider.js";
export type {
  LexicalProviderGateReasonCode,
  LexicalProviderGateResult,
  LexicalProviderGateStatus,
  LexicalProviderGateSummary,
  LexicalProviderReadyResult,
  LexicalProviderUnavailableResult,
  ResolveLexicalProviderInput,
} from "./core/retrieval/provider.js";

export {
  createClient,
  GraphClient,
  AppClient,
  canonicalContractKey,
  createContractId,
  createEvidenceId,
  normalizeRuleName
};

export type {
  ClientOptions,
  AppConfig,
  AppClientOptions,
  LanguageParser,
  ParseInput,
  ExtractContext,
  Stats,
  DependencyRow,
  ContractSummaryRow,
  RetrievalResult,
  RetrievalDiagnostics,
  RetrievalOutcome,
  RetrievalRouteDiagnostic,
  RetrievalStageDiagnostic,
  RetrievalStageStatus,
  RetrieveOptions,
  AskOptions,
  RetrievalCandidate,
  FusedRetrievalCandidate,
  CandidateRouteMembership,
  CandidateProvenance,
  CandidateLocation,
  CandidateConfidence,
  CandidateSourceKind,
  SelectionRejection,
  SelectionRejectionReason,
  LoadedEvidence,
  SourceLoadRejection,
  SourceLoadRejectionReason,
  SourceLoadStatus,
  RagAnswerContext,
  RagCitation,
  RagContextItem,
  QueryPlanningContext,
  ImpactResult,
  SemanticTraceGraph,
  SemanticTraceEdge,
  SemanticTraceNode,
  ParsedFile,
  ParsedSourceFacts,
  AnnotationArgument,
  AnnotationFact,
  DecoratorFact,
  LiteralFact,
  ImportRef,
  CodeSymbol,
  CallRef,
  IndexOptions,
  IndexResult,
  BenchmarkOptions,
  BenchmarkQuery,
  IndexingBenchmarkReport,
  IndexingBenchmarkSample,
  PercentileSummary,
  RetrievalBenchmarkReport,
  StageBenchmark,
  StageSample,
  WorkspaceBenchmarkReport
};
