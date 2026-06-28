import { compatExtractor } from "./compat.js";
import type { ContractExtractor } from "../../../plugins/types.js";
import type { FactCollector } from "../factCollector.js";
import { confidenceFor } from "../../../../shared/confidence.js";
import {
  buildOwnership,
  contract,
  dependencyEntries,
  dependencyLine,
  evidence,
  pushContractEvidence,
  pushResolvedPackageOwner,
  readRepoPackageManifests, } from "./shared.js";

export const packageJsonExtractor = compatExtractor({
  name: "builtin:package-json",
  languages: ["javascript", "typescript"],
  frameworks: ["js:package-json"],
  needs: {
    parsedFiles: false,
    aliasOverrides: true
  },
  async extract(context, collector: FactCollector) {
    const manifests = (await Promise.all(context.repos.map(readRepoPackageManifests))).flat();
    const identities = buildOwnership(context.repos, manifests, context.aliasOverrides);

    for (const identity of identities) {
      for (const ownership of identity.packages.values()) {
        const packageContract = contract("package", ownership.name, `Package owned by ${identity.repo.name}`);
        const evidenceNode = evidence({
          repoId: identity.repo.id,
          fileId: ownership.fileId,
          filePath: ownership.manifestPath,
          line: ownership.line,
          raw: ownership.name,
          rule: "package-json-name",
          confidence: confidenceFor("exact-manifest")
        });
        pushContractEvidence(collector, identity.repo.id, packageContract, "owner", evidenceNode);
      }
    }

    for (const manifest of manifests) {
      for (const [packageName, versionRange] of dependencyEntries(manifest.packageJson)) {
        const packageContract = contract("package", packageName, `Package dependency ${packageName}`);
        const raw = `"${packageName}": "${versionRange}"`;
        const evidenceNode = evidence({
          repoId: manifest.repo.id,
          fileId: manifest.fileId,
          filePath: manifest.manifestPath,
          line: dependencyLine(manifest.raw, packageName),
          raw,
          rule: "package-json-dependency",
          confidence: confidenceFor("exact-manifest")
        });
        pushContractEvidence(collector, manifest.repo.id, packageContract, "consumer", evidenceNode);
        pushResolvedPackageOwner(collector, packageName, identities);
        collector.addPackageUsage({ repoId: manifest.repo.id, packageContractId: packageContract.id, packageName, evidenceId: evidenceNode.id, raw: evidenceNode.raw, confidence: confidenceFor("exact-manifest") });
      }
    }

  }
});
