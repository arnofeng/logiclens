import type { CrossRepoExtraction } from "../extractors/crossRepoContracts.js";
import type { ContractKind, ContractRole, RepoNode } from "../parsers/types.js";

export type GoldenContractExpectation = {
  kind: ContractKind;
  key: string;
};

export type GoldenParticipantExpectation = GoldenContractExpectation & {
  repo: string;
  role: ContractRole;
};

export type GoldenDependencyExpectation = GoldenContractExpectation & {
  fromRepo: string;
  toRepo: string;
  dependencyType: "package" | "import" | "api" | "event" | "shared-contract";
};

export type GoldenAbsentContractExpectation = GoldenContractExpectation & {
  reason: string;
};

export type GoldenCorpusExpectations = {
  contracts: GoldenContractExpectation[];
  participants: GoldenParticipantExpectation[];
  dependencies: GoldenDependencyExpectation[];
  absentContracts?: GoldenAbsentContractExpectation[];
};

export type GoldenMetric = {
  expected: number;
  actual: number;
  truePositive: number;
  falsePositive: string[];
  falseNegative: string[];
  precision: number;
  recall: number;
};

export type GoldenEvaluationReport = {
  contracts: GoldenMetric;
  participants: GoldenMetric;
  dependencies: GoldenMetric;
  absentContracts: {
    expected: number;
    violations: string[];
    passed: boolean;
  };
  passed: boolean;
};

export function evaluateGoldenCorpus(
  facts: CrossRepoExtraction,
  repos: RepoNode[],
  expectations: GoldenCorpusExpectations
): GoldenEvaluationReport {
  const repoNamesById = new Map(repos.map((repo) => [repo.id, repo.name]));
  const contractsById = new Map(facts.contracts.map((contract) => [contract.id, contract]));

  // Golden corpus assertions need stable comparison keys rather than raw
  // evidence ids because evidence ids can change when fixture line numbers move.
  const actualContracts = new Set(facts.contracts.map((contract) => contractKey(contract)));
  const actualParticipants = new Set(facts.repoContracts.flatMap((edge) => {
    const contract = contractsById.get(edge.contractId);
    const repoName = repoNamesById.get(edge.repoId);
    return contract && repoName ? [participantKey({ repo: repoName, role: edge.role, kind: contract.kind, key: contract.key })] : [];
  }));
  const actualDependencies = new Set(facts.repoDependencies.flatMap((edge) => {
    const contract = contractsById.get(edge.sourceContractId);
    const fromRepo = repoNamesById.get(edge.fromRepoId);
    const toRepo = repoNamesById.get(edge.toRepoId);
    return contract && fromRepo && toRepo
      ? [dependencyKey({ fromRepo, toRepo, dependencyType: edge.dependencyType, kind: contract.kind, key: contract.key })]
      : [];
  }));

  const expectedAbsent = expectations.absentContracts ?? [];
  const absentViolations = expectedAbsent
    .map((expectation) => contractKey(expectation))
    .filter((key) => actualContracts.has(key));

  const contracts = scoreSet(actualContracts, new Set(expectations.contracts.map(contractKey)));
  const participants = scoreSet(actualParticipants, new Set(expectations.participants.map(participantKey)));
  const dependencies = scoreSet(actualDependencies, new Set(expectations.dependencies.map(dependencyKey)));

  return {
    contracts,
    participants,
    dependencies,
    absentContracts: {
      expected: expectedAbsent.length,
      violations: absentViolations,
      passed: absentViolations.length === 0
    },
    passed: contracts.falseNegative.length === 0
      && participants.falseNegative.length === 0
      && dependencies.falseNegative.length === 0
      && absentViolations.length === 0
  };
}

export function formatGoldenEvaluationReport(report: GoldenEvaluationReport): string {
  return [
    "Golden Corpus evaluation",
    formatMetric("contracts", report.contracts),
    formatMetric("participants", report.participants),
    formatMetric("dependencies", report.dependencies),
    `absent-contracts: expected=${report.absentContracts.expected} violations=${report.absentContracts.violations.length}`
  ].join("\n");
}

function scoreSet(actual: Set<string>, expected: Set<string>): GoldenMetric {
  const falsePositive = [...actual].filter((key) => !expected.has(key)).sort();
  const falseNegative = [...expected].filter((key) => !actual.has(key)).sort();
  const truePositive = expected.size - falseNegative.length;
  return {
    expected: expected.size,
    actual: actual.size,
    truePositive,
    falsePositive,
    falseNegative,
    precision: actual.size === 0 ? 1 : truePositive / actual.size,
    recall: expected.size === 0 ? 1 : truePositive / expected.size
  };
}

function contractKey(contract: GoldenContractExpectation): string {
  return `${contract.kind}:${contract.key}`;
}

function participantKey(expectation: GoldenParticipantExpectation): string {
  return `${expectation.repo}:${expectation.role}:${expectation.kind}:${expectation.key}`;
}

function dependencyKey(expectation: GoldenDependencyExpectation): string {
  return `${expectation.fromRepo}->${expectation.toRepo}:${expectation.dependencyType}:${expectation.kind}:${expectation.key}`;
}

function formatMetric(name: string, metric: GoldenMetric): string {
  return `${name}: precision=${metric.precision.toFixed(3)} recall=${metric.recall.toFixed(3)} expected=${metric.expected} actual=${metric.actual}`;
}
