import { hashText } from "../../../shared/hash.js";
import { sectionId } from "../../../shared/path.js";
import type { DocLink, DocSection, MarkdownCodeBlock, ParsedDocument } from "../types.js";

type Heading = {
  heading: string;
  level: number;
  line: number;
};

function extractLinks(lines: string[], baseLine: number): DocLink[] {
  const links: DocLink[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    for (const match of line.matchAll(/(?<!!)\[([^\]]+)\]\(([^)\s#]+)(?:#[^)]+)?\)/g)) {
      links.push({ text: match[1], target: match[2], line: baseLine + index });
    }
  }
  return links;
}

function extractCodeBlocks(lines: string[], baseLine: number): MarkdownCodeBlock[] {
  const blocks: MarkdownCodeBlock[] = [];
  let fence: string | undefined;
  let language = "";
  let start = 0;
  let body: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const opening = line.match(/^(\s*)(`{3,}|~{3,})\s*([A-Za-z0-9_-]+)?\s*$/);
    if (!fence && opening) {
      fence = opening[2][0];
      language = opening[3] ?? "";
      start = baseLine + index;
      body = [];
      continue;
    }
    if (fence && line.match(new RegExp(`^\\s*\\${fence}{3,}\\s*$`))) {
      blocks.push({ language, startLine: start, endLine: baseLine + index, text: body.join("\n") });
      fence = undefined;
      language = "";
      body = [];
      continue;
    }
    if (fence) body.push(line);
  }

  if (fence) blocks.push({ language, startLine: start, endLine: baseLine + lines.length - 1, text: body.join("\n") });
  return blocks;
}

function stripHeading(line: string): Heading | undefined {
  const match = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
  if (!match) return undefined;
  return { level: match[1].length, heading: match[2].trim(), line: 0 };
}

export function parseMarkdownDocument(input: {
  repoId: string;
  fileId: string;
  relativePath: string;
  source: string;
  hash?: string;
}): ParsedDocument {
  const lines = input.source.split(/\r?\n/);
  const headings: Heading[] = [];
  lines.forEach((line, index) => {
    const heading = stripHeading(line);
    if (heading) headings.push({ ...heading, line: index + 1 });
  });

  const ranges = headings.length > 0
    ? headings.map((heading, index) => ({
      heading: heading.heading,
      level: heading.level,
      startLine: heading.line,
      endLine: (headings[index + 1]?.line ?? lines.length + 1) - 1
    }))
    : [{ heading: input.relativePath, level: 0, startLine: 1, endLine: Math.max(lines.length, 1) }];

  const sections: DocSection[] = ranges.map((range) => {
    const sectionLines = lines.slice(range.startLine - 1, range.endLine);
    const text = sectionLines.join("\n").trim();
    const links = extractLinks(sectionLines, range.startLine);
    const codeBlocks = extractCodeBlocks(sectionLines, range.startLine);
    return {
      id: sectionId(input.repoId, input.relativePath, range.heading, range.startLine),
      repoId: input.repoId,
      fileId: input.fileId,
      heading: range.heading,
      level: range.level,
      startLine: range.startLine,
      endLine: range.endLine,
      text,
      hash: hashText(text),
      links,
      codeBlocks
    };
  });

  return {
    repoId: input.repoId,
    fileId: input.fileId,
    path: input.relativePath,
    language: "markdown",
    hash: input.hash ?? hashText(input.source),
    loc: lines.length,
    sections,
    links: sections.flatMap((section) => section.links),
    codeBlocks: sections.flatMap((section) => section.codeBlocks)
  };
}
