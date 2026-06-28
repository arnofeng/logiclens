import { compatExtractor } from "./compat.js";
import type { ContractExtractor } from "../../../plugins/types.js";
import type { FactCollector } from "../factCollector.js";
import { confidenceFor } from "../../../../shared/confidence.js";
import {
  contract,
  evidence,
  isParsedCodeFile,
  javaPackageFromPath,
  pushContractEvidence, } from "./shared.js";

/**
 * Extracts Java package contracts from Java file paths.
 *
 * For each Java file, infers the package name from `facts.packageName` or
 * by parsing the file path (e.g. `src/main/java/com/example/Foo.java` → `com.example`).
 *
 * Import-to-package extraction is handled by the separate `importPackageExtractor`.
 */
export const javaPackageExtractor = compatExtractor({
  name: "builtin:java-package",
  languages: ["java"],
  async extract(context, collector: FactCollector) {

    for (const file of context.parsedFiles.filter(isParsedCodeFile)) {
      if (file.language !== "java") continue;
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
        pushContractEvidence(collector, file.repoId, packageContract, "owner", evidenceNode);
      }
    }

  }
});
