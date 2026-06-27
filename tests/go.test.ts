import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseSourceFile } from "../src/core/parsing/parserRegistry.js";
import { goExtractor } from "../src/core/contracts/extraction/builtin/goExtractor.js";
import { repoId } from "../src/shared/path.js";
import type { ExtractedRelation } from "../src/core/contracts/extraction/crossRepoContracts.js";

function isRepoContractRelation(relation: ExtractedRelation): relation is ExtractedRelation & { kind: "repo-contract" } {
  return relation.kind === "repo-contract";
}

describe("Go support", () => {
  it("parses Go files and extracts structures/methods/imports/calls", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-go-test-"));
    const sourcePath = path.join(dir, "main.go");
    await fs.writeFile(
      sourcePath,
      `package main

import (
	"fmt"
	"net/http"
)

type Server struct {
	Addr string
}

type Service interface {
	DoWork()
}

func (s *Server) Start() {
	http.HandleFunc("/api/info", s.infoHandler)
}

func (s *Server) infoHandler(w http.ResponseWriter, r *http.Request) {
	fmt.Fprintf(w, "OK")
}

func main() {
	r := gin.Default()
	r.GET("/api/users", func(c *gin.Context) {})

	// client call
	http.Get("/api/orders")
	http.Get(buildURL())
	local.Get("/api/local/cache")
}
`,
      "utf8"
    );

    const parsed = await parseSourceFile({
      repoId: repoId("go-test"),
      absolutePath: sourcePath,
      relativePath: "main.go",
      language: "go"
    });

    // 1. Verify imports
    const modules = parsed.imports.map((i) => i.module);
    expect(modules).toContain("fmt");
    expect(modules).toContain("net/http");

    // 2. Verify symbols
    const symbolNames = parsed.symbols.map((s) => s.qualifiedName);
    expect(symbolNames).toContain("Server");
    expect(symbolNames).toContain("Service");
    expect(symbolNames).toContain("Server.Start");
    expect(symbolNames).toContain("Server.infoHandler");
    expect(symbolNames).toContain("main");
    expect(parsed.symbols.find((s) => s.name === "Server")?.kind).toBe("struct");
    expect(parsed.symbols.find((s) => s.name === "Service")?.kind).toBe("interface");

    // 3. Verify calls
    const calls = parsed.calls.map((c) => c.calleeName);
    expect(calls).toContain("HandleFunc");
    expect(calls).toContain("GET");
    expect(calls).toContain("Get");

    // 4. Test Go extractor
    const context = {
      repos: [{ id: "go-test", name: "go-test", path: dir } as any],
      parsedFiles: [parsed],
      repoResolver: () => null as any
    };
    const extracted = await goExtractor.extract(context);
    
    // Check producer API contracts
    const producers = extracted.relations.filter(isRepoContractRelation).filter((r) => r.role === "producer");
    const producerContractIds = producers.map((p) => p.contractId);
    expect(producers.length).toBe(2);
    expect(producerContractIds).toContain("contract:api:api-info");
    expect(producerContractIds).toContain("contract:api:get:-api-users");

    // Check consumer API contract (http.Get)
    const consumers = extracted.relations.filter(isRepoContractRelation).filter((r) => r.role === "consumer");
    expect(consumers.length).toBe(1);
    expect(consumers[0]?.contractId).toContain("api:get:-api-orders");
    expect(extracted.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: "dynamic-unresolved", raw: expect.stringContaining("http.Get(buildURL())") })
    ]));
    expect(extracted.contracts.some((contract) => contract.kind === "api" && contract.key === "/api/local/cache")).toBe(false);

    await fs.rm(dir, { recursive: true, force: true });
  });
});
