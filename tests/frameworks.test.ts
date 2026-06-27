import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { detectFrameworks, isExtractorEnabled } from "../src/core/frameworks/detect.js";
import type { RepoNode } from "../src/core/parsing/types.js";
import type { ContractExtractor } from "../src/core/plugins/types.js";
import { defaultConfig } from "../src/config/loadConfig.js";
import { confidenceFor } from "../src/shared/confidence.js";

function mockRepoNode(name: string, repoPath: string): RepoNode {
  return {
    id: `repo:${name}`,
    name,
    path: repoPath,
    remoteUrl: "",
    branch: "",
    commitSha: "",
    language: "typescript",
    indexedAt: new Date().toISOString()
  };
}

describe("framework detection", () => {
  it("detects package.json and axios dependency", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-frameworks-"));
    const repo = mockRepoNode("test-js", dir);
    
    // No package.json initially
    let detected = await detectFrameworks(repo);
    expect(detected).toEqual([]);

    // package.json exists but without axios
    await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "test-js", dependencies: {} }), "utf8");
    detected = await detectFrameworks(repo);
    expect(detected.map((f) => f.name)).toEqual(["js:package-json"]);

    // package.json with axios
    await fs.writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "test-js", dependencies: { axios: "^1.0.0" } }),
      "utf8"
    );
    detected = await detectFrameworks(repo);
    expect(detected.map((f) => f.name).sort()).toEqual(["js:axios", "js:package-json"]);
  });

  it("detects pom.xml and spring-mvc dependency", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-frameworks-"));
    const repo = mockRepoNode("test-java", dir);

    await fs.writeFile(
      path.join(dir, "pom.xml"),
      `
      <project>
        <dependencies>
          <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-web</artifactId>
          </dependency>
        </dependencies>
      </project>
      `,
      "utf8"
    );
    const detected = await detectFrameworks(repo);
    expect(detected.map((f) => f.name).sort()).toEqual(["java:pom", "java:spring-mvc"]);
  });

  it("detects build.gradle and spring-mvc dependency", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-frameworks-"));
    const repo = mockRepoNode("test-gradle", dir);

    await fs.writeFile(
      path.join(dir, "build.gradle"),
      `
      dependencies {
          implementation 'org.springframework.boot:spring-boot-starter-web'
      }
      `,
      "utf8"
    );
    const detected = await detectFrameworks(repo);
    expect(detected.map((f) => f.name).sort()).toEqual(["java:gradle", "java:spring-mvc"]);
  });

  it("detects go.mod and gin dependency", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-frameworks-"));
    const repo = mockRepoNode("test-go", dir);

    await fs.writeFile(
      path.join(dir, "go.mod"),
      `
      module test-go
      go 1.20
      require github.com/gin-gonic/gin v1.9.0
      `,
      "utf8"
    );
    const detected = await detectFrameworks(repo);
    expect(detected.map((f) => f.name).sort()).toEqual(["go:gin", "go:mod"]);
  });

  it("detects fastapi in requirements.txt", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-frameworks-"));
    const repo = mockRepoNode("test-py", dir);

    await fs.writeFile(
      path.join(dir, "requirements.txt"),
      `
      fastapi==0.95.0
      uvicorn
      `,
      "utf8"
    );
    const detected = await detectFrameworks(repo);
    expect(detected.map((f) => f.name)).toEqual(["python:fastapi"]);
  });

  it("detects generic Python and Go frameworks from parsed files", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-frameworks-"));
    const repo = mockRepoNode("test-source-langs", dir);

    const detected = await detectFrameworks(repo, [
      { repoId: repo.id, fileId: "py", path: "main.py", language: "python", hash: "h1", loc: 1, imports: [], symbols: [], calls: [] } as any,
      { repoId: repo.id, fileId: "go", path: "main.go", language: "go", hash: "h2", loc: 1, imports: [], symbols: [], calls: [] } as any
    ]);

    expect(detected.map((f) => f.name).sort()).toEqual(["go:generic", "python:generic"]);
    expect(detected.every((f) => f.confidence === confidenceFor("fallback-framework-language"))).toBe(true);
    expect(detected.every((f) => f.evidence.every((e) => e.confidence === f.confidence))).toBe(true);
  });

  it("enables Python and Go extractors for generic parsed source repos", () => {
    const config = defaultConfig();
    const pythonExtractor: ContractExtractor = {
      name: "test:python",
      languages: ["python"],
      frameworks: ["python:generic", "python:fastapi"],
      extract: () => ({ contracts: [], evidence: [], entities: [], operations: [], workflows: [], relations: [], contractSpecs: [], contractSpecEdges: [], semanticRelations: [] })
    };
    const goExtractor: ContractExtractor = {
      name: "test:go",
      languages: ["go"],
      frameworks: ["go:generic", "go:gin", "go:mod"],
      extract: () => ({ contracts: [], evidence: [], entities: [], operations: [], workflows: [], relations: [], contractSpecs: [], contractSpecEdges: [], semanticRelations: [] })
    };

    expect(isExtractorEnabled(pythonExtractor, [{ repoId: "r1", name: "python:generic", language: "python", confidence: 0.8, evidence: [] }], config)).toBe(true);
    expect(isExtractorEnabled(goExtractor, [{ repoId: "r1", name: "go:generic", language: "go", confidence: 0.8, evidence: [] }], config)).toBe(true);
  });

  it("evaluates isExtractorEnabled with include/exclude overrides", () => {
    const config = defaultConfig();
    config.frameworks = {
      include: ["java:spring-mvc"],
      exclude: ["js:generic-fetch"]
    };

    const springExtractor: ContractExtractor = {
      name: "spring-extractor",
      frameworks: ["java:spring-mvc"],
      extract: () => ({ contracts: [], evidence: [], entities: [], operations: [], workflows: [], relations: [], contractSpecs: [], contractSpecEdges: [], semanticRelations: [] })
    };

    const fetchExtractor: ContractExtractor = {
      name: "fetch-extractor",
      frameworks: ["js:generic-fetch"],
      extract: () => ({ contracts: [], evidence: [], entities: [], operations: [], workflows: [], relations: [], contractSpecs: [], contractSpecEdges: [], semanticRelations: [] })
    };

    const genericExtractor: ContractExtractor = {
      name: "generic-extractor",
      extract: () => ({ contracts: [], evidence: [], entities: [], operations: [], workflows: [], relations: [], contractSpecs: [], contractSpecEdges: [], semanticRelations: [] })
    };

    // Even if no frameworks are detected, config.include forces it enabled
    expect(isExtractorEnabled(springExtractor, [], config)).toBe(true);

    // If config.exclude forces it disabled, it is disabled even if detected
    const detectedFetch = [{ repoId: "r1", name: "js:generic-fetch", language: "javascript", confidence: 1, evidence: [] }];
    expect(isExtractorEnabled(fetchExtractor, detectedFetch, config)).toBe(false);

    // Extractor without frameworks is enabled by default
    expect(isExtractorEnabled(genericExtractor, [], config)).toBe(true);
  });

});
