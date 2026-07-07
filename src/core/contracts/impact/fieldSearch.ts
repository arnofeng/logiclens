// ---------------------------------------------------------------------------
// File-based field search (memory-level, avoids SchemaField node explosion)
//
// Searches source text for references to a field name using regex patterns
// for dot access, bracket access, and Java-style getter/setter accessors.
// ---------------------------------------------------------------------------

/**
 * Searches source text for references to a field name.
 * Uses regex to find field access patterns like `.fieldName`, `["fieldName"]`,
 * `getFieldName()`, `setFieldName(...)`.
 */
export function stripCommentsAndStrings(sourceText: string, filePath?: string): { noComments: string; noCommentsOrStrings: string } {
  let inSingleLineComment = false;
  let inBlockComment = false;
  let inString: '"' | "'" | "`" | null = null;
  let isEscape = false;
  const isJsOrTs = filePath ? /\.[jt]sx?$/i.test(filePath) : false;

  const charsNoComments = sourceText.split("");
  const charsNoCommentsOrStrings = sourceText.split("");

  for (let i = 0; i < sourceText.length; i++) {
    const char = sourceText[i]!;
    const next = sourceText[i + 1] || "";

    if (inSingleLineComment) {
      if (char === "\n") {
        inSingleLineComment = false;
      } else {
        charsNoComments[i] = " ";
        charsNoCommentsOrStrings[i] = " ";
      }
      continue;
    }

    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        charsNoComments[i] = " ";
        charsNoComments[i + 1] = " ";
        charsNoCommentsOrStrings[i] = " ";
        charsNoCommentsOrStrings[i + 1] = " ";
        i++; // skip /
      } else if (char !== "\n") {
        charsNoComments[i] = " ";
        charsNoCommentsOrStrings[i] = " ";
      }
      continue;
    }

    if (inString) {
      if (isEscape) {
        isEscape = false;
        if (char !== "\n") {
          charsNoCommentsOrStrings[i] = " ";
        }
      } else if (char === "\\") {
        isEscape = true;
        charsNoCommentsOrStrings[i] = " ";
      } else if (char === inString) {
        inString = null;
      } else if (char !== "\n") {
        charsNoCommentsOrStrings[i] = " ";
      }
      continue;
    }

    // Check for comment starts
    if (char === "/" && next === "/") {
      inSingleLineComment = true;
      charsNoComments[i] = " ";
      charsNoComments[i + 1] = " ";
      charsNoCommentsOrStrings[i] = " ";
      charsNoCommentsOrStrings[i + 1] = " ";
      i++;
      continue;
    }
    if (char === "/" && next === "*") {
      inBlockComment = true;
      charsNoComments[i] = " ";
      charsNoComments[i + 1] = " ";
      charsNoCommentsOrStrings[i] = " ";
      charsNoCommentsOrStrings[i + 1] = " ";
      i++;
      continue;
    }
    if (char === "#" && !isJsOrTs) {
      inSingleLineComment = true;
      charsNoComments[i] = " ";
      charsNoCommentsOrStrings[i] = " ";
      continue;
    }

    // Check for string starts
    if (char === '"' || char === "'" || char === "`") {
      inString = char;
      continue;
    }
  }

  return {
    noComments: charsNoComments.join(""),
    noCommentsOrStrings: charsNoCommentsOrStrings.join("")
  };
}

export function findFieldReferences(
  sourceText: string,
  fieldName: string,
  filePath?: string
): { line: number; raw: string }[] {
  const results: { line: number; raw: string }[] = [];
  const escaped = fieldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const dotPattern = new RegExp(`\\.${escaped}\\b`, "g");
  const bracketPattern = new RegExp(`\\[["']${escaped}["']\\]`, "g");
  const accessorPattern = new RegExp(`\\b(get|set)${escaped.charAt(0).toUpperCase()}${escaped.slice(1)}\\b`, "g");

  const { noComments, noCommentsOrStrings } = stripCommentsAndStrings(sourceText, filePath);

  const originalLines = sourceText.split("\n");
  const noCommentsLines = noComments.split("\n");
  const noCommentsOrStringsLines = noCommentsOrStrings.split("\n");

  const seenLines = new Set<number>();

  for (let i = 0; i < originalLines.length; i++) {
    const orig = originalLines[i]!;
    const nc = noCommentsLines[i]!;
    const ncos = noCommentsOrStringsLines[i]!;

    // 1. Bracket access pattern runs on comment-stripped lines (where strings are preserved)
    bracketPattern.lastIndex = 0;
    if (bracketPattern.test(nc) && !seenLines.has(i + 1)) {
      seenLines.add(i + 1);
      results.push({ line: i + 1, raw: orig.trim() });
      continue;
    }

    // 2. Dot access and accessors run on comment-and-string-stripped lines
    dotPattern.lastIndex = 0;
    if (dotPattern.test(ncos) && !seenLines.has(i + 1)) {
      seenLines.add(i + 1);
      results.push({ line: i + 1, raw: orig.trim() });
      continue;
    }

    accessorPattern.lastIndex = 0;
    if (accessorPattern.test(ncos) && !seenLines.has(i + 1)) {
      seenLines.add(i + 1);
      results.push({ line: i + 1, raw: orig.trim() });
      continue;
    }
  }

  return results;
}
