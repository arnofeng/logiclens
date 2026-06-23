import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseSourceFile } from "../src/parsers/parserRegistry.js";
import { pythonExtractor } from "../src/extractors/builtin/pythonExtractor.js";
import { repoId } from "../src/utils/path.js";
import type { ExtractedRelation } from "../src/extractors/crossRepoContracts.js";

function isRepoContractRelation(relation: ExtractedRelation): relation is ExtractedRelation & { kind: "repo-contract" } {
  return relation.kind === "repo-contract";
}

describe("Python support", () => {
  it("parses Python files and extracts facts/symbols/calls", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-py-test-"));
    const sourcePath = path.join(dir, "main.py");
    await fs.writeFile(
      sourcePath,
      `import sys
from fastapi import FastAPI

app = FastAPI()

class UserController:
    def __init__(self):
        pass

    @app.get("/api/users")
    def get_users(self):
        return []

def main():
    print("hello")
    # client call
    requests.get("/api/orders")
    requests.get(build_url())
    local.get("/api/local/cache")
`,
      "utf8"
    );

    const parsed = await parseSourceFile({
      repoId: repoId("py-test"),
      absolutePath: sourcePath,
      relativePath: "main.py",
      language: "python"
    });

    // 1. Verify imports
    const modules = parsed.imports.map((i) => i.module);
    expect(modules).toContain("sys");
    expect(modules).toContain("fastapi");

    // 2. Verify symbols
    const symbolNames = parsed.symbols.map((s) => s.qualifiedName);
    expect(symbolNames).toContain("UserController");
    expect(symbolNames).toContain("UserController.get_users");
    expect(symbolNames).toContain("main");

    // 3. Verify calls
    const calls = parsed.calls.map((c) => c.calleeName);
    expect(calls).toContain("print");
    expect(calls).toContain("get");

    // 4. Verify decorators
    expect(parsed.facts?.decorators).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ownerKind: "method",
          name: "app.get",
          arguments: ["/api/users"]
        })
      ])
    );

    // 5. Test Python extractor
    const context = {
      repos: [{ id: "py-test", name: "py-test", path: dir } as any],
      parsedFiles: [parsed],
      repoResolver: () => null as any
    };
    const extracted = await pythonExtractor.extract(context);
    
    // Check producer API contract
    const producers = extracted.relations.filter(isRepoContractRelation).filter((r) => r.role === "producer");
    expect(producers.length).toBe(1);
    expect(producers[0]?.contractId).toContain("api:api-users");

    // Check consumer API contract (requests.get)
    const consumers = extracted.relations.filter(isRepoContractRelation).filter((r) => r.role === "consumer");
    expect(consumers.length).toBe(1);
    expect(consumers[0]?.contractId).toContain("api:api-orders");
    expect(extracted.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: "dynamic-unresolved", raw: expect.stringContaining("requests.get(build_url())") })
    ]));
    expect(extracted.contracts.some((contract) => contract.kind === "api" && contract.key === "/api/local/cache")).toBe(false);

    await fs.rm(dir, { recursive: true, force: true });
  });
});
