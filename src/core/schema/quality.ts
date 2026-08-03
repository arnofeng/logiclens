import type { GraphDB } from "../graph-model/db.js";
import { SchemaGenerationStore, type OwnedSchemaFact } from "./generationStore.js";
import {
  canonicalSerialize,
  type SchemaDiagnosticFact,
  type SchemaRelationProvenance,
  type SchemaRootReference,
  type TypeDeclarationFact,
  type TypeDeclarationIdentity,
  type TypeExpression
} from "./model.js";

export const SCHEMA_OUTCOMES = [
  "resolved",
  "unresolved",
  "external",
  "ambiguous",
  "unsupported",
  "truncated"
] as const;

export type SchemaOutcome = typeof SCHEMA_OUTCOMES[number];
export type SchemaQualityGroupBy = "language" | "framework" | "relation-kind" | "repo";

export interface SchemaRootOutcomeCounts {
  roots: number;
  resolved: number;
  unresolved: number;
  external: number;
  ambiguous: number;
  unsupported: number;
  truncated: number;
}

export interface SchemaDiagnosticEntryCounts {
  total: number;
  unresolved: number;
  external: number;
  ambiguous: number;
  unsupported: number;
  truncated: number;
}

export interface SchemaQualitySummary {
  rootOutcomes: SchemaRootOutcomeCounts;
  diagnosticEntries: SchemaDiagnosticEntryCounts;
}

export interface SchemaCandidateEvidence {
  identity: TypeDeclarationIdentity;
  declarationId?: string;
  fileId?: string;
  filePath?: string;
  sourceSymbolId?: string;
  line?: number;
  raw?: string;
  rule?: string;
}

export interface SchemaQualityDetail {
  outcome: Exclude<SchemaOutcome, "resolved">;
  diagnosticId?: string;
  diagnosticCode: SchemaDiagnosticFact["code"] | "missing-outcome";
  repoId?: string;
  languageId?: string;
  frameworkId?: string;
  relationKind?: SchemaRootReference["relationKind"];
  rootReferenceId?: string;
  ownerSpecId?: string;
  sourceFileId?: string;
  sourceSymbolId?: string;
  symbol?: string;
  rawTypeExpression?: string;
  typePath: TypeExpression[];
  fieldPath: string[];
  candidates: SchemaCandidateEvidence[];
  limit?: { kind: "depth" | "types"; value: number };
}

export interface SchemaQualityGroup {
  value: string;
  summary: SchemaQualitySummary;
}

export interface SchemaQualityReport {
  workspaceId: string;
  generation: string | null;
  groupBy: SchemaQualityGroupBy | null;
  summary: SchemaQualitySummary;
  groups: SchemaQualityGroup[];
  details: SchemaQualityDetail[];
}

type RootFact = SchemaRootReference & OwnedSchemaFact;
type DiagnosticFact = SchemaDiagnosticFact & OwnedSchemaFact;
type ProvenanceFact = SchemaRelationProvenance & OwnedSchemaFact;
type DeclarationFact = TypeDeclarationFact & OwnedSchemaFact;

type QualityFacts = {
  roots: RootFact[];
  diagnostics: DiagnosticFact[];
  provenance: ProvenanceFact[];
  declarations: DeclarationFact[];
};

const OUTCOME_PRIORITY: readonly Exclude<SchemaOutcome, "resolved">[] = [
  "truncated",
  "ambiguous",
  "unsupported",
  "unresolved",
  "external"
];

export async function querySchemaQuality(
  db: GraphDB,
  workspaceId: string,
  options: {
    groupBy?: SchemaQualityGroupBy;
    details?: readonly Exclude<SchemaOutcome, "resolved">[];
  } = {}
): Promise<SchemaQualityReport> {
  const read = async (): Promise<SchemaQualityReport> => {
    const store = new SchemaGenerationStore(db, workspaceId);
    const generation = await store.activeGeneration();
    if (!generation) return emptySchemaQualityReport(workspaceId, options.groupBy);
    const roots = await store.facts<RootFact>("roots", generation);
    const diagnostics = await store.facts<DiagnosticFact>("diagnostics", generation);
    const provenance = await store.facts<ProvenanceFact>("provenance", generation);
    const declarations = await store.facts<DeclarationFact>("declarations", generation);
    return buildSchemaQualityReport({
      workspaceId,
      generation,
      facts: { roots, diagnostics, provenance, declarations },
      groupBy: options.groupBy,
      details: options.details ?? []
    });
  };
  return db.readTransaction ? db.readTransaction(read) : read();
}

export function emptySchemaQualityReport(
  workspaceId: string,
  groupBy?: SchemaQualityGroupBy
): SchemaQualityReport {
  return {
    workspaceId,
    generation: null,
    groupBy: groupBy ?? null,
    summary: emptySummary(),
    groups: [],
    details: []
  };
}

export function buildSchemaQualityReport(input: {
  workspaceId: string;
  generation: string;
  facts: QualityFacts;
  groupBy?: SchemaQualityGroupBy;
  details?: readonly Exclude<SchemaOutcome, "resolved">[];
}): SchemaQualityReport {
  const roots = uniqueById(input.facts.roots);
  const diagnostics = uniqueById(input.facts.diagnostics);
  const provenance = uniqueById(input.facts.provenance);
  const declarations = uniqueById(input.facts.declarations);
  const diagnosticsByRoot = groupByKey(diagnostics.filter((fact) => fact.rootReferenceId), (fact) => fact.rootReferenceId!);
  const provenanceByRoot = groupByKey(provenance, (fact) => fact.rootReferenceId);
  const rootOutcomes = new Map(roots.map((root) => [
    root.id,
    rootOutcome(diagnosticsByRoot.get(root.id) ?? [], provenanceByRoot.get(root.id) ?? [])
  ]));
  const rootById = new Map(roots.map((root) => [root.id, root]));
  const summary = summarize(roots, diagnostics, rootOutcomes);
  const groups = input.groupBy
    ? groupedSummaries(input.groupBy, roots, diagnostics, rootOutcomes, rootById)
    : [];
  const requestedDetails = new Set(input.details ?? []);
  const declarationByIdentity = groupByKey(declarations, (fact) => canonicalSerialize(fact.identity));
  const details = requestedDetails.size === 0 ? [] : diagnosticDetails({
    roots,
    diagnostics,
    rootById,
    rootOutcomes,
    provenanceByRoot,
    declarationByIdentity,
    requestedDetails
  });
  return {
    workspaceId: input.workspaceId,
    generation: input.generation,
    groupBy: input.groupBy ?? null,
    summary,
    groups,
    details
  };
}

function groupedSummaries(
  dimension: SchemaQualityGroupBy,
  roots: RootFact[],
  diagnostics: DiagnosticFact[],
  outcomes: ReadonlyMap<string, SchemaOutcome>,
  rootById: ReadonlyMap<string, RootFact>
): SchemaQualityGroup[] {
  const values = new Set<string>();
  for (const root of roots) values.add(groupValue(dimension, root));
  for (const diagnostic of diagnostics) values.add(groupValue(dimension, rootForDiagnostic(diagnostic, rootById), diagnostic));
  return [...values].sort((left, right) => left.localeCompare(right)).map((value) => {
    const groupRoots = roots.filter((root) => groupValue(dimension, root) === value);
    const groupRootIds = new Set(groupRoots.map((root) => root.id));
    const groupDiagnostics = diagnostics.filter((diagnostic) => {
      const diagnosticRoot = rootForDiagnostic(diagnostic, rootById);
      return diagnosticRoot
        ? groupRootIds.has(diagnosticRoot.id)
        : groupValue(dimension, undefined, diagnostic) === value;
    });
    return { value, summary: summarize(groupRoots, groupDiagnostics, outcomes) };
  });
}

function summarize(
  roots: readonly RootFact[],
  diagnostics: readonly DiagnosticFact[],
  outcomes: ReadonlyMap<string, SchemaOutcome>
): SchemaQualitySummary {
  const summary = emptySummary();
  summary.rootOutcomes.roots = roots.length;
  for (const root of roots) summary.rootOutcomes[outcomes.get(root.id) ?? "unresolved"]++;
  for (const diagnostic of diagnostics) {
    summary.diagnosticEntries.total++;
    summary.diagnosticEntries[diagnostic.code]++;
  }
  return summary;
}

function rootOutcome(
  diagnostics: readonly DiagnosticFact[],
  provenance: readonly ProvenanceFact[]
): SchemaOutcome {
  const codes = new Set(diagnostics.map((fact) => fact.code));
  for (const outcome of OUTCOME_PRIORITY) if (codes.has(outcome)) return outcome;
  return provenance.some((fact) => fact.resolution === "resolved") ? "resolved" : "unresolved";
}

function diagnosticDetails(input: {
  roots: RootFact[];
  diagnostics: DiagnosticFact[];
  rootById: ReadonlyMap<string, RootFact>;
  rootOutcomes: ReadonlyMap<string, SchemaOutcome>;
  provenanceByRoot: ReadonlyMap<string, ProvenanceFact[]>;
  declarationByIdentity: ReadonlyMap<string, DeclarationFact[]>;
  requestedDetails: ReadonlySet<Exclude<SchemaOutcome, "resolved">>;
}): SchemaQualityDetail[] {
  const details: SchemaQualityDetail[] = [];
  for (const diagnostic of input.diagnostics) {
    if (!input.requestedDetails.has(diagnostic.code)) continue;
    const root = rootForDiagnostic(diagnostic, input.rootById);
    details.push(detailFromDiagnostic(diagnostic, root, input.declarationByIdentity));
  }
  if (input.requestedDetails.has("unresolved")) {
    for (const root of input.roots) {
      if (input.rootOutcomes.get(root.id) !== "unresolved") continue;
      if ((input.diagnostics.filter((fact) => fact.rootReferenceId === root.id)).length > 0) continue;
      if ((input.provenanceByRoot.get(root.id) ?? []).some((fact) => fact.resolution === "resolved")) continue;
      details.push({
        outcome: "unresolved",
        diagnosticCode: "missing-outcome",
        repoId: root.repoId,
        languageId: root.languageId,
        frameworkId: root.frameworkId,
        relationKind: root.relationKind,
        rootReferenceId: root.id,
        ownerSpecId: root.ownerSpecId,
        sourceFileId: root.ownerFileId,
        rawTypeExpression: root.rawTypeExpression,
        typePath: [],
        fieldPath: [],
        candidates: []
      });
    }
  }
  return details.sort((left, right) => detailSortKey(left).localeCompare(detailSortKey(right)));
}

function detailFromDiagnostic(
  diagnostic: DiagnosticFact,
  root: RootFact | undefined,
  declarationByIdentity: ReadonlyMap<string, DeclarationFact[]>
): SchemaQualityDetail {
  return {
    outcome: diagnostic.code,
    diagnosticId: diagnostic.id,
    diagnosticCode: diagnostic.code,
    repoId: diagnostic.repoId ?? root?.repoId ?? diagnostic.scope?.repoId,
    languageId: root?.languageId ?? diagnostic.scope?.languageId,
    frameworkId: root?.frameworkId,
    relationKind: root?.relationKind,
    rootReferenceId: diagnostic.rootReferenceId,
    ownerSpecId: diagnostic.ownerSpecId ?? root?.ownerSpecId,
    sourceFileId: diagnostic.sourceFileId ?? root?.ownerFileId,
    sourceSymbolId: diagnostic.sourceSymbolId,
    symbol: diagnostic.symbol,
    rawTypeExpression: root?.rawTypeExpression,
    typePath: diagnostic.typePath ?? [],
    fieldPath: diagnostic.fieldPath ?? [],
    candidates: (diagnostic.candidates ?? []).flatMap((identity) => {
      const matches = declarationByIdentity.get(canonicalSerialize(identity)) ?? [];
      if (matches.length === 0) return [{ identity }];
      return matches.map((fact) => ({
        identity,
        declarationId: fact.id,
        fileId: fact.fileId,
        filePath: fact.candidate?.filePath,
        sourceSymbolId: fact.candidate?.sourceSymbolId,
        line: fact.candidate?.evidence.line,
        raw: fact.candidate?.evidence.raw,
        rule: fact.candidate?.evidence.rule
      }));
    }).sort((left, right) => candidateSortKey(left).localeCompare(candidateSortKey(right))),
    limit: diagnostic.limit
  };
}

function groupValue(
  dimension: SchemaQualityGroupBy,
  root?: RootFact,
  diagnostic?: DiagnosticFact
): string {
  if (dimension === "language") return root?.languageId ?? diagnostic?.scope?.languageId ?? "(unscoped)";
  if (dimension === "framework") return root?.frameworkId ?? "(unscoped)";
  if (dimension === "relation-kind") return root?.relationKind ?? "(unscoped)";
  return root?.repoId ?? diagnostic?.repoId ?? diagnostic?.scope?.repoId ?? "(unscoped)";
}

function rootForDiagnostic(
  diagnostic: DiagnosticFact,
  roots: ReadonlyMap<string, RootFact>
): RootFact | undefined {
  return diagnostic.rootReferenceId ? roots.get(diagnostic.rootReferenceId) : undefined;
}

function emptySummary(): SchemaQualitySummary {
  return {
    rootOutcomes: {
      roots: 0,
      resolved: 0,
      unresolved: 0,
      external: 0,
      ambiguous: 0,
      unsupported: 0,
      truncated: 0
    },
    diagnosticEntries: {
      total: 0,
      unresolved: 0,
      external: 0,
      ambiguous: 0,
      unsupported: 0,
      truncated: 0
    }
  };
}

function uniqueById<T extends { id: string }>(facts: readonly T[]): T[] {
  return [...new Map(facts.map((fact) => [fact.id, fact])).values()]
    .sort((left, right) => left.id.localeCompare(right.id));
}

function groupByKey<T>(values: readonly T[], key: (value: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const group = groups.get(key(value)) ?? [];
    group.push(value);
    groups.set(key(value), group);
  }
  return groups;
}

function detailSortKey(detail: SchemaQualityDetail): string {
  return [detail.outcome, detail.repoId, detail.rootReferenceId, detail.sourceFileId, detail.symbol,
    detail.fieldPath.join("."), detail.diagnosticId].map((value) => value ?? "").join("\u0000");
}

function candidateSortKey(candidate: SchemaCandidateEvidence): string {
  return [canonicalSerialize(candidate.identity), candidate.declarationId, candidate.fileId, candidate.line]
    .map((value) => value === undefined ? "" : String(value)).join("\u0000");
}
