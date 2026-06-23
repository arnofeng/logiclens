const FORBIDDEN_KEYWORDS = [
  "ALTER",
  "ATTACH",
  "COPY",
  "CREATE",
  "DELETE",
  "DETACH",
  "DROP",
  "INSTALL",
  "LOAD",
  "MERGE",
  "REMOVE",
  "SET"
];

const ALLOWED_START_KEYWORDS = ["MATCH", "OPTIONAL", "RETURN", "UNWIND", "WITH"];

function maskNonCode(input: string): string {
  let output = "";
  let index = 0;
  while (index < input.length) {
    const char = input[index];
    const next = input[index + 1];

    if (char === "/" && next === "/") {
      output += "  ";
      index += 2;
      while (index < input.length && input[index] !== "\n") {
        output += " ";
        index += 1;
      }
      continue;
    }

    if (char === "/" && next === "*") {
      output += "  ";
      index += 2;
      while (index < input.length) {
        if (input[index] === "*" && input[index + 1] === "/") {
          output += "  ";
          index += 2;
          break;
        }
        output += input[index] === "\n" ? "\n" : " ";
        index += 1;
      }
      continue;
    }

    if (char === "'" || char === "\"" || char === "`") {
      const quote = char;
      output += " ";
      index += 1;
      while (index < input.length) {
        const current = input[index];
        output += current === "\n" ? "\n" : " ";
        index += 1;
        if (current === "\\") {
          if (index < input.length) {
            output += input[index] === "\n" ? "\n" : " ";
            index += 1;
          }
          continue;
        }
        if (current === quote) break;
      }
      continue;
    }

    output += char;
    index += 1;
  }
  return output;
}

export function assertReadOnlyCypher(cypher: string): void {
  const masked = maskNonCode(cypher).trim();
  if (!masked) throw new Error("Cypher query is empty.");

  if (/;[\s\S]*\S/.test(masked.replace(/;\s*$/, ""))) {
    throw new Error("MCP Cypher query accepts one read-only statement at a time.");
  }

  const firstKeyword = masked.match(/^[A-Za-z]+/)?.[0]?.toUpperCase();
  if (!firstKeyword || !ALLOWED_START_KEYWORDS.includes(firstKeyword)) {
    throw new Error(`MCP Cypher query must start with one of: ${ALLOWED_START_KEYWORDS.join(", ")}.`);
  }

  const forbidden = new RegExp(`\\b(${FORBIDDEN_KEYWORDS.join("|")})\\b`, "i").exec(masked);
  if (forbidden) {
    throw new Error(`Unsafe Cypher keyword "${forbidden[1]?.toUpperCase()}" is disabled for MCP by default.`);
  }
}

export function isReadOnlyCypher(cypher: string): boolean {
  try {
    assertReadOnlyCypher(cypher);
    return true;
  } catch {
    return false;
  }
}
