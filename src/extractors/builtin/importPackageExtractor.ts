import type { ContractExtractor } from "../../plugins/types.js";
import { confidenceFor } from "../../confidence.js";
import {
  buildOwnership,
  contract,
  createCrossRepoExtraction,
  evidence,
  isParsedCodeFile,
  packageContractKeyForImport,
  pushContractEvidence,
  pushResolvedPackageOwner,
  readRepoPackageManifests,
  toFactBundle
} from "./shared.js";

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
 * This extractor has no `languages` or `frameworks` restriction — it runs for all repos.
 */
export const importPackageExtractor: ContractExtractor = {
  name: "builtin:import-package",
  async extract(context) {
    const result = createCrossRepoExtraction();
    const manifests = (await Promise.all(context.repos.map(readRepoPackageManifests))).flat();
    const identities = buildOwnership(context.repos, manifests, context.aliasOverrides);

    for (const file of context.parsedFiles.filter(isParsedCodeFile)) {
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
        pushContractEvidence(result, file.repoId, packageContract, "consumer", evidenceNode);
        if (file.language !== "java") pushResolvedPackageOwner(result, importRef.module, identities);
        result.packageUsages.push({ repoId: file.repoId, packageContractId: packageContract.id, packageName, evidenceId: evidenceNode.id, raw: importRef.raw, confidence: confidenceFor("strong-static-import") });
      }
    }

    return toFactBundle(result);
  }
};
