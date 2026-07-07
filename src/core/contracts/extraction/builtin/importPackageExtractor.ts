import { compatExtractor } from "./compat.js";
import type { FactCollector } from "../factCollector.js";
import { confidenceFor } from "../../../../shared/confidence.js";
import {
  buildOwnership,
  contract,
  evidence,
  parsedCodeFiles,
  packageContractKeyForImport,
  pushContractEvidence,
  pushResolvedPackageOwner,
  readRepoPackageManifests, } from "./shared.js";

/**
 * Extracts import-to-package contracts from all parsed code files.
 *
 * For every non-relative import, this extractor:
 *   1. Creates a "consumer" contract+evidence edge linking the file's repo to the imported package.
 *   2. For non-Java files, resolves the import specifier to an owning repo via
 *      `pushResolvedPackageOwner` (matches against package.json names and aliases).
 *   3. For Java files, uses `packageContractKeyForImport` to strip the class suffix
 *      from the import specifier (yielding just the package path).
 *
 * This extractor has no `languages` or `frameworks` restriction â€?it runs for all repos.
 */
export const importPackageExtractor = compatExtractor({
  name: "builtin:import-package",
  needs: {
    aliasOverrides: true
  },
  async extract(context, collector: FactCollector) {
    const manifests = (await Promise.all(context.repos.map(readRepoPackageManifests))).flat();
    const identities = buildOwnership(context.repos, manifests, context.aliasOverrides);

    for (const file of parsedCodeFiles(context.parsedFiles)) {
      for (const importRef of file.imports) {
        if (importRef.module.startsWith(".")) continue;
        const packageName = packageContractKeyForImport(file, importRef);
        const packageContract = contract("package", packageName, `Imported package ${packageName}`);
        const evidenceNode = evidence({
          repoId: file.repoId,
          fileId: file.fileId,
          filePath: file.path,
          line: importRef.line,
          raw: importRef.raw,
          rule: "import-specifier-package-owner",
          confidence: confidenceFor("strong-static-import")
        });
        pushContractEvidence(collector, file.repoId, packageContract, "consumer", evidenceNode);
        if (file.language !== "java") pushResolvedPackageOwner(collector, importRef.module, identities);
        collector.addPackageUsage({ repoId: file.repoId, packageContractId: packageContract.id, packageName, evidenceId: evidenceNode.id, raw: importRef.raw, confidence: confidenceFor("strong-static-import") });
      }
    }

  }
});
