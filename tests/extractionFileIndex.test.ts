import { describe, expect, it } from "vitest";
import { parsedCodeFiles } from "../src/core/contracts/extraction/builtin/shared.js";
import { buildExtractionFileIndex, filesForRepoId, filesForRepoIdAndLanguages, filesForRepoIds } from "../src/core/contracts/extraction/fileIndex.js";
import type { ParsedGraphFile } from "../src/core/parsing/types.js";

function parsedFile(repoId: string, path: string, language: string): ParsedGraphFile {
  if (language === "markdown") {
    return {
      repoId,
      fileId: `${repoId}:${path}`,
      path,
      language: "markdown",
      hash: path,
      loc: 1,
      sections: [],
      links: [],
      codeBlocks: []
    };
  }
  return {
    repoId,
    fileId: `${repoId}:${path}`,
    path,
    language,
    hash: path,
    loc: 1,
    imports: [],
    symbols: [],
    calls: []
  };
}

describe("extraction file index", () => {
  it("groups parsed files by repo and language", () => {
    const files = [
      parsedFile("repo:a", "src/a.ts", "typescript"),
      parsedFile("repo:a", "README.md", "markdown"),
      parsedFile("repo:b", "src/b.py", "python")
    ];

    const index = buildExtractionFileIndex(files);

    expect(filesForRepoId(index, "repo:a").map((file) => file.path)).toEqual(["src/a.ts", "README.md"]);
    expect(filesForRepoIds(index, ["repo:a", "repo:b"], { codeOnly: true }).map((file) => file.path)).toEqual(["src/a.ts", "src/b.py"]);
    expect(filesForRepoIdAndLanguages(index, "repo:a", ["typescript"]).map((file) => file.path)).toEqual(["src/a.ts"]);
  });

  it("iterates code files without including markdown documents", () => {
    const files = [
      parsedFile("repo:a", "src/a.ts", "typescript"),
      parsedFile("repo:a", "README.md", "markdown")
    ];

    expect([...parsedCodeFiles(files)].map((file) => file.path)).toEqual(["src/a.ts"]);
  });
});
