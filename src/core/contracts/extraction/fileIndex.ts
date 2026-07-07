import type { ParsedFile, ParsedGraphFile } from "../../parsing/types.js";

export type ExtractionFileIndex = {
  parsedFilesByRepoId: Map<string, ParsedGraphFile[]>;
  codeFilesByRepoId: Map<string, ParsedFile[]>;
  filesByRepoAndLanguage: Map<string, Map<string, ParsedGraphFile[]>>;
};

export function isExtractionCodeFile(file: ParsedGraphFile): file is ParsedFile {
  return file.language !== "markdown";
}

export function buildExtractionFileIndex(parsedFiles: ParsedGraphFile[]): ExtractionFileIndex {
  const parsedFilesByRepoId = new Map<string, ParsedGraphFile[]>();
  const codeFilesByRepoId = new Map<string, ParsedFile[]>();
  const filesByRepoAndLanguage = new Map<string, Map<string, ParsedGraphFile[]>>();

  for (const file of parsedFiles) {
    const repoFiles = parsedFilesByRepoId.get(file.repoId) ?? [];
    repoFiles.push(file);
    parsedFilesByRepoId.set(file.repoId, repoFiles);

    const repoLanguages = filesByRepoAndLanguage.get(file.repoId) ?? new Map<string, ParsedGraphFile[]>();
    const languageFiles = repoLanguages.get(file.language) ?? [];
    languageFiles.push(file);
    repoLanguages.set(file.language, languageFiles);
    filesByRepoAndLanguage.set(file.repoId, repoLanguages);

    if (isExtractionCodeFile(file)) {
      const codeFiles = codeFilesByRepoId.get(file.repoId) ?? [];
      codeFiles.push(file);
      codeFilesByRepoId.set(file.repoId, codeFiles);
    }
  }

  return { parsedFilesByRepoId, codeFilesByRepoId, filesByRepoAndLanguage };
}

export function filesForRepoIds(
  index: ExtractionFileIndex,
  repoIds: Iterable<string>,
  options: { codeOnly?: boolean } = {}
): ParsedGraphFile[] {
  const result: ParsedGraphFile[] = [];
  const source = options.codeOnly ? index.codeFilesByRepoId : index.parsedFilesByRepoId;
  for (const repoId of repoIds) {
    result.push(...(source.get(repoId) ?? []));
  }
  return result;
}

export function filesForRepoId(index: ExtractionFileIndex, repoId: string): ParsedGraphFile[] {
  return index.parsedFilesByRepoId.get(repoId) ?? [];
}

export function filesForRepoIdAndLanguages(
  index: ExtractionFileIndex,
  repoId: string,
  languages: readonly string[]
): ParsedGraphFile[] {
  const byLanguage = index.filesByRepoAndLanguage.get(repoId);
  if (!byLanguage) return [];
  const result: ParsedGraphFile[] = [];
  for (const language of languages) result.push(...(byLanguage.get(language) ?? []));
  return result;
}
