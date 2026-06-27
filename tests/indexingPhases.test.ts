import { describe, expect, it } from "vitest";
import { IndexPhaseError, runIndexPhase } from "../src/core/indexing/phases.js";

describe("indexing phases", () => {
  it("returns a phase result with duration for successful work", async () => {
    const result = await runIndexPhase({ phase: "scan", repoName: "service-a" }, () => {
      return { files: 3 };
    });

    expect(result.phase).toBe("scan");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.result).toEqual({ files: 3 });
  });

  it("wraps failures in IndexPhaseError with phase context", async () => {
    await expect(
      runIndexPhase({ phase: "parse", repoName: "service-a", filePath: "src/OrderService.ts" }, () => {
        throw new Error("syntax exploded");
      })
    ).rejects.toThrow(IndexPhaseError);

    await expect(
      runIndexPhase({ phase: "parse", repoName: "service-a", filePath: "src/OrderService.ts" }, () => {
        throw new Error("syntax exploded");
      })
    ).rejects.toThrow(/phase=parse/);
  });

  it("preserves repo, file, writer mode, and batch scope on failures", async () => {
    try {
      await runIndexPhase({
        phase: "graph-write",
        repoName: "service-b",
        batchId: "batch:1",
        filePath: "src/PaymentService.ts",
        writerMode: "bulk-upsert"
      }, async () => {
        throw new Error("write failed");
      });
      throw new Error("expected phase failure");
    } catch (error) {
      expect(error).toBeInstanceOf(IndexPhaseError);
      const phaseError = error as IndexPhaseError;
      expect(phaseError.scope).toEqual({
        phase: "graph-write",
        repoName: "service-b",
        batchId: "batch:1",
        filePath: "src/PaymentService.ts",
        writerMode: "bulk-upsert"
      });
      expect(phaseError.message).toContain("phase=graph-write");
      expect(phaseError.message).toContain("repo=service-b");
      expect(phaseError.message).toContain("batchId=batch:1");
      expect(phaseError.message).toContain("file=src/PaymentService.ts");
      expect(phaseError.message).toContain("writerMode=bulk-upsert");
    }
  });
});
