import { createLogicLens, LogicLensClient, type LogicLensClientOptions, type TraceResult, type ImpactResult } from "./sdk/client.js";
import { definePlugin } from "./plugins/index.js";
import { loadConfiguredPlugins } from "./plugins/loader.js";

import type {
  LogicLensPlugin,
  PluginContext,
  LanguageParser,
  ParseInput,
  ExtractContext
} from "./plugins/types.js";

import { canonicalContractKey } from "./extractors/crossRepoContracts.js";
import { createContractId, createEvidenceId, normalizePluginRuleName } from "./plugins/helpers.js";

import type { Stats } from "./graph/db.js";
import type { DependencyRow, ContractSummaryRow } from "./graph/queries.js";
import type { RetrievalResult } from "./rag/retrieve.js";
import type {
  AnnotationArgument,
  AnnotationFact,
  DecoratorFact,
  LiteralFact,
  ParsedSourceFacts
} from "./parsers/facts.js";
import type { CallRef, CodeSymbol, ImportRef, ParsedFile } from "./parsers/types.js";

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
