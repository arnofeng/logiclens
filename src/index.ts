import {
  createClient,
  createLogicLens,
  GraphClient,
  LogicLensClient,
  type ClientOptions,
  type LogicLensClientOptions,
  type TraceResult,
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
  AnnotationArgument,
  AnnotationFact,
  DecoratorFact,
  LiteralFact,
  ParsedSourceFacts
} from "./core/parsing/facts.js";
import type { CallRef, CodeSymbol, ImportRef, ParsedFile } from "./core/parsing/types.js";
import type { AppConfig, LogicLensConfig } from "./config/schema.js";

export {
  createClient,
  createLogicLens,
  GraphClient,
  LogicLensClient,
  canonicalContractKey,
  createContractId,
  createEvidenceId,
  normalizeRuleName
};

export type {
  ClientOptions,
  AppConfig,
  LogicLensConfig,
  LogicLensClientOptions,
  LanguageParser,
  ParseInput,
  ExtractContext,
  Stats,
  DependencyRow,
  ContractSummaryRow,
  RetrievalResult,
  TraceResult,
  ImpactResult,
  ParsedFile,
  ParsedSourceFacts,
  AnnotationArgument,
  AnnotationFact,
  DecoratorFact,
  LiteralFact,
  ImportRef,
  CodeSymbol,
  CallRef
};
