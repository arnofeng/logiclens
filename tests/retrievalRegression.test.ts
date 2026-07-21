import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { RetrievalResult } from "../src/features/ask/retrieve.js";
import { NO_RELIABLE_EVIDENCE } from "../src/features/ask/answer.js";
import { handleAskQuestion } from "../src/interfaces/mcp/server.js";
import {
  createWorkspaceEvaluationFixture,
  type WorkspaceEvaluationFixture,
} from "./retrieval/workspaceEvaluationFixture.js";
import { WORKSPACE_CORPUS } from "./retrieval/workspaceCorpus.js";

const OFFLINE_ENVIRONMENT_VARIABLES = [
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "AZURE_OPENAI_API_KEY",
  "AZURE_OPENAI_ENDPOINT",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "COHERE_API_KEY",
  "VOYAGE_API_KEY",
] as const;

const EXPECTED_IDENTIFIER = WORKSPACE_CORPUS.find(({ id }) => id === "identifier")!;
const EXPECTED_CONTRACT = WORKSPACE_CORPUS.find(({ id }) => id === "english-order-api")!;
const EXPECTED_GRAPH_IMPLEMENTATION = "code:repo:api:src/routes/orders.go:function:RegisterOrderRoutes:7";

function canonicalIds(result: RetrievalResult): string[] {
  return result.loadedEvidence.map(({ candidate }) => candidate.canonicalId);
}

function assertLocatedEvidence(result: RetrievalResult, canonicalId: string): void {
  const evidence = result.loadedEvidence.find(({ candidate }) => candidate.canonicalId === canonicalId);
  expect(evidence).toBeDefined();
  expect(evidence!.document.repoId).toMatch(/^repo:/u);
  expect(evidence!.document.path).toBeTruthy();
  expect(evidence!.document.renderRef).toBeTruthy();
}

describe("final unified retrieval compatibility regression", () => {
  let fixture: WorkspaceEvaluationFixture;
  const originalEnvironment = new Map<string, string | undefined>();

  beforeAll(async () => {
    for (const name of OFFLINE_ENVIRONMENT_VARIABLES) {
      originalEnvironment.set(name, process.env[name]);
      delete process.env[name];
    }
    fixture = await createWorkspaceEvaluationFixture();
  }, 60_000);

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("../src/interfaces/sdk/client.js");
  });

  afterAll(async () => {
    try {
      await fixture?.close();
    } finally {
      for (const [name, value] of originalEnvironment) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("preserves question-only SDK retrieve and ask calls with legacy result fields", async () => {
    const result = await fixture.client.retrieve(EXPECTED_IDENTIFIER.question);

    expect(result.outcome).toBe("succeeded");
    assertLocatedEvidence(result, EXPECTED_IDENTIFIER.expectedCanonicalIds[0]!);
    expect(result).toMatchObject({
      code: expect.any(Array),
      sections: expect.any(Array),
      entities: expect.any(Array),
      contracts: expect.any(Array),
      dependencies: expect.any(Array),
      semantic: expect.any(Array),
      edges: expect.any(Array),
    });

    const answer = await fixture.client.ask(EXPECTED_IDENTIFIER.question);
    expect(answer).not.toBe(NO_RELIABLE_EVIDENCE);
    expect(answer).toContain("[C1]");
    expect(answer).toMatch(/repo:api\/src\/contracts\/orders\.ts/u);
    expect(answer).not.toMatch(/searchableText|sourceHash|batchId|\btokens\b/u);
  });

  it("preserves the CLI question-only boundary, refusal, and closing behavior", async () => {
    const ask = vi.fn()
      .mockResolvedValueOnce("Verified evidence citations:\n- [C1] code repo:api/src/contracts/orders.ts:2 CreateOrderRequest")
      .mockResolvedValueOnce(NO_RELIABLE_EVIDENCE)
      .mockRejectedValueOnce(new Error("ask failed"));
    const close = vi.fn().mockResolvedValue(undefined);
    const createClient = vi.fn().mockResolvedValue({ ask, close });
    vi.doMock("../src/interfaces/sdk/client.js", () => ({ createClient }));
    const { askCommand } = await import("../src/interfaces/cli/ask.js");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await askCommand(EXPECTED_IDENTIFIER.question, fixture.directory);
    await askCommand("Which service owns the payment ledger?", fixture.directory);
    await expect(askCommand("throw", fixture.directory)).rejects.toThrow("ask failed");

    expect(createClient).toHaveBeenCalledTimes(3);
    expect(ask).toHaveBeenNthCalledWith(1, EXPECTED_IDENTIFIER.question);
    expect(ask).toHaveBeenNthCalledWith(2, "Which service owns the payment ledger?");
    expect(ask).toHaveBeenNthCalledWith(3, "throw");
    expect(close).toHaveBeenCalledTimes(3);
    expect(log).toHaveBeenNthCalledWith(1, expect.stringContaining("[C1]"));
    expect(log).toHaveBeenNthCalledWith(2, NO_RELIABLE_EVIDENCE);
    expect(log.mock.calls.flat().join("\n")).not.toMatch(
      /searchableText|sourceHash|batchId|\btokens\b|MATCH \(|SELECT /u,
    );
  });

  it("keeps MCP retrieval options optional and projects only safe diagnostics and evidence", async () => {
    const realResult = await fixture.client.retrieve(EXPECTED_IDENTIFIER.question);
    const retrieve = vi.fn().mockResolvedValue(realResult);
    const response = await handleAskQuestion({ retrieve } as never, {
      question: EXPECTED_IDENTIFIER.question,
    });

    expect(retrieve).toHaveBeenCalledTimes(1);
    expect(retrieve).toHaveBeenCalledWith(EXPECTED_IDENTIFIER.question, {});
    expect(response).toMatchObject({
      outcome: "succeeded",
      selectedEvidence: expect.arrayContaining([
        expect.objectContaining({
          repoId: "repo:api",
          path: "src/contracts/orders.ts",
          renderRef: expect.any(String),
        }),
      ]),
      diagnostics: {
        routes: expect.any(Object),
        timings: expect.any(Object),
        queries: expect.any(Object),
        compatibility: expect.any(Object),
        sourceLoading: expect.any(Object),
        providers: {
          lexical: { status: expect.any(String) },
          semantic: expect.any(Object),
        },
      },
    });
    expect(Object.keys(response.diagnostics.providers.lexical)).toEqual(["status"]);
    const serialized = JSON.stringify(response);
    expect(serialized).not.toMatch(
      /searchableText|sourceHash|batchId|\btokens\b|providerVersion|projectionSchemaVersion|tokenizerVersion|indexStatus|MATCH \(|SELECT /u,
    );
  });

  it("preserves the exact identifier baseline without lexical or semantic retrieval", async () => {
    const expectedId = EXPECTED_IDENTIFIER.expectedCanonicalIds[0]!;
    const result = await fixture.client.retrieve(EXPECTED_IDENTIFIER.question, {
      lexical: false,
      semantic: false,
      graphHops: 0,
    });

    expect(result.outcome).toBe("succeeded");
    expect(canonicalIds(result)).toContain(expectedId);
    assertLocatedEvidence(result, expectedId);
    const candidate = result.selectedCandidates.find(({ canonicalId }) => canonicalId === expectedId);
    expect(candidate?.routes).toEqual(expect.arrayContaining([
      expect.objectContaining({ route: "exact" }),
    ]));
    expect(result.diagnostics.routes.exact).toMatchObject({ status: "succeeded", executed: true });
    expect(result.diagnostics.routes.lexical).toMatchObject({ status: "disabled", queryCount: 0 });
  });

  it("preserves the canonical API contract baseline without discovery providers", async () => {
    const expectedId = EXPECTED_CONTRACT.expectedCanonicalIds[0]!;
    const result = await fixture.client.retrieve(EXPECTED_CONTRACT.question, {
      lexical: false,
      semantic: false,
      graphHops: 0,
    });

    expect(result.outcome).toBe("succeeded");
    expect(canonicalIds(result)).toContain(expectedId);
    assertLocatedEvidence(result, expectedId);
    expect(result.selectedCandidates.find(({ canonicalId }) => canonicalId === expectedId)?.routes)
      .toEqual(expect.arrayContaining([expect.objectContaining({ route: "contract" })]));
    expect(result.diagnostics.routes.contract).toMatchObject({
      status: "succeeded",
      executed: true,
    });
    expect(result.diagnostics.routes.contract.queryCount).toBeGreaterThan(0);
    expect(result.diagnostics.routes.lexical.queryCount).toBe(0);
  });

  it("bounds graph expansion to high-confidence seeds and skips it without a seed", async () => {
    const seeded = await fixture.client.retrieve(EXPECTED_CONTRACT.question, {
      lexical: false,
      semantic: false,
      graphHops: 1,
    });
    expect(seeded.diagnostics.routes.contract).toMatchObject({ status: "succeeded", executed: true });
    expect(seeded.diagnostics.routes.graph).toMatchObject({ status: "succeeded", executed: true });
    expect(seeded.diagnostics.routes.graph.queryCount).toBeGreaterThan(0);
    expect(seeded.diagnostics.routes.graph.queryCount).toBeLessThanOrEqual(3);
    expect(seeded.code.map(({ codeId }) => codeId)).toContain(EXPECTED_GRAPH_IMPLEMENTATION);
    expect(canonicalIds(seeded)).toContain(EXPECTED_GRAPH_IMPLEMENTATION);
    expect(seeded.selectedCandidates.find(({ canonicalId }) => canonicalId === EXPECTED_GRAPH_IMPLEMENTATION)?.routes)
      .toEqual(expect.arrayContaining([expect.objectContaining({ route: "graph" })]));

    const unseeded = await fixture.client.retrieve("Which service owns the payment ledger?", {
      lexical: false,
      semantic: false,
      graphHops: 1,
    });
    expect(unseeded.outcome).toBe("no_results");
    expect(unseeded.diagnostics.routes.graph).toMatchObject({
      status: "disabled",
      executed: false,
      queryCount: 0,
    });
  });
});
