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
  IndexResult
};
