import type { ContractExtractor } from "../../plugins/types.js";
import { confidenceFor } from "../../confidence.js";
import {
  buildOwnership,
  contract,
  createCrossRepoExtraction,
  evidence,
  isParsedCodeFile,
  javaPackageFromPath,
  packageContractKeyForImport,
  pushContractEvidence,
  pushResolvedPackageOwner,
  readRepoPackageManifests,
  toFactBundle
} from "./shared.js";

export const javaPackageExtractor: ContractExtractor = {
  name: "builtin:java-package",
  async extract(context) {
    const result = createCrossRepoExtraction();
    const manifests = (await Promise.all(context.repos.map(readRepoPackageManifests))).flat();
    const identities = buildOwnership(context.repos, manifests, context.aliasOverrides);

    for (const file of context.parsedFiles.filter(isParsedCodeFile)) {
      if (file.language === "java") {
        const packageName = file.facts?.packageName ?? javaPackageFromPath(file.path);
        if (packageName) {
          const packageContract = contract("package", packageName, `Java package ${packageName}`);
          const evidenceNode = evidence({
            repoId: file.repoId,
            fileId: file.fileId,
            filePath: file.path,
            line: 1,
            raw: `package ${packageName}`,
            rule: "java-package-path",
            confidence: confidenceFor("probable-package-path")
          });
          pushContractEvidence(result, file.repoId, packageContract, "owner", evidenceNode);
        }
      }

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
