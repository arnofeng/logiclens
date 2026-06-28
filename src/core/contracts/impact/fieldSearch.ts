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
export function findFieldReferences(
  sourceText: string,
  fieldName: string
): { line: number; raw: string }[] {
  const results: { line: number; raw: string }[] = [];
  const escaped = fieldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const patterns = [
    // .fieldName (dot access) — case-sensitive to avoid false matches like .ID matching .id
    new RegExp(`\\.${escaped}\\b`, "g"),
    // ["fieldName"] or ['fieldName'] (bracket access)
    new RegExp(`\\[["']${escaped}["']\\]`, "g"),
    // getFieldName() / setFieldName() (Java-style accessors, case-insensitive prefix)
    new RegExp(`\\b(get|set)${escaped.charAt(0).toUpperCase()}${escaped.slice(1)}\\b`, "g"),
  ];

  const seenLines = new Set<number>();
  const lines = sourceText.split("\n");

  for (const pattern of patterns) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      // Reset lastIndex for global regex
      pattern.lastIndex = 0;
      if (pattern.test(line) && !seenLines.has(i + 1)) {
        seenLines.add(i + 1);
        results.push({ line: i + 1, raw: line.trim() });
      }
    }
  }

  return results;
}
