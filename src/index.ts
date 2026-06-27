import { createLogicLens, LogicLensClient, type LogicLensClientOptions, type TraceResult, type ImpactResult } from "./interfaces/sdk/client.js";
import { definePlugin } from "./core/plugins/index.js";
import { loadConfiguredPlugins } from "./core/plugins/loader.js";

import type {
  LogicLensPlugin,
  PluginContext,
  LanguageParser,
  ParseInput,
  ExtractContext
} from "./core/plugins/types.js";

import { canonicalContractKey } from "./core/contracts/extraction/crossRepoContracts.js";
import { createContractId, createEvidenceId, normalizePluginRuleName } from "./core/plugins/helpers.js";

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

export {
  createLogicLens,
  LogicLensClient,
  definePlugin,
  loadConfiguredPlugins,
  canonicalContractKey,
  createContractId,
  createEvidenceId,
  normalizePluginRuleName
};

export type {
  LogicLensClientOptions,
  LogicLensPlugin,
  PluginContext,
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
