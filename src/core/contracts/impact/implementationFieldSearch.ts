import fs from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import { fileId, toPosixPath } from "../../../shared/path.js";
import { findTypedFieldReferences } from "./fieldSearch.js";
import type { ImpactAnalysisOptions } from "./types.js";

const SOURCE_GLOBS = [
  "**/*.java",
  "**/*.ts",
  "**/*.tsx",
  "**/*.js",
  "**/*.jsx",
  "**/*.cs",
  "**/*.go",
  "**/*.py",
];

const DEFAULT_IGNORES = [
  "**/.git/**",
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/target/**",
  "**/coverage/**",
];

export type ImplementationSearchRepo = {
  repoId: string;
  rootPath: string;
};

export async function scanImplementationFieldReferences(input: {
  repos: ImplementationSearchRepo[];
  typeNames: string[];
  fieldName: string;
  ignore?: string[];
}): Promise<NonNullable<ImpactAnalysisOptions["implementationFieldReferences"]>> {
  const matches: NonNullable<ImpactAnalysisOptions["implementationFieldReferences"]> = [];

  for (const repo of input.repos) {
    const relativePaths = await fg(SOURCE_GLOBS, {
      cwd: repo.rootPath,
      absolute: false,
      onlyFiles: true,
      unique: true,
      ignore: [...DEFAULT_IGNORES, ...(input.ignore ?? [])],
    });

    for (const relativePath of relativePaths) {
      let sourceText: string;
      try {
        sourceText = await fs.promises.readFile(path.join(repo.rootPath, relativePath), "utf-8");
      } catch {
        continue;
      }

      const normalizedPath = toPosixPath(relativePath);
      for (const reference of findTypedFieldReferences(sourceText, input.typeNames, input.fieldName, normalizedPath)) {
        matches.push({
          repoId: repo.repoId,
          filePath: fileId(repo.repoId, normalizedPath),
          line: reference.line,
          evidence: reference.raw,
          confidence: 0.9,
        });
      }
    }
  }

  return matches;
}
