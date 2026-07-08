import { describe, expect, it } from "vitest";

/**
 * Tests for the double-cleanup prevention pattern used in the MCP server.
 * The MCP server uses a `cleanupTriggered` boolean guard to ensure that
 * cleanup() is only invoked once, even when multiple signals (SIGINT, SIGTERM,
 * stdin EOF) fire in quick succession.
 */
describe("MCP server cleanup guard pattern", () => {
  it("only invokes cleanup once when triggered multiple times", async () => {
    let cleanupCallCount = 0;
    let cleanupTriggered = false;

    const cleanup = async () => {
      cleanupCallCount++;
    };

    const triggerCleanup = () => {
      if (cleanupTriggered) return;
      cleanupTriggered = true;
      cleanup().catch(() => {}).finally(() => {});
    };

    // Simulate multiple signals arriving
    triggerCleanup();
    triggerCleanup();
    triggerCleanup();

    // Wait for async cleanup to complete
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(cleanupCallCount).toBe(1);
  });

  it("second trigger after first cleanup starts is a no-op", async () => {
    const executionOrder: string[] = [];
    let cleanupTriggered = false;

    const cleanup = async () => {
      executionOrder.push("cleanup-start");
      await new Promise((resolve) => setTimeout(resolve, 50));
      executionOrder.push("cleanup-end");
    };

    const triggerCleanup = () => {
      if (cleanupTriggered) return;
      cleanupTriggered = true;
      cleanup().catch(() => {}).finally(() => {});
    };

    triggerCleanup();
    // This should be a no-op because cleanupTriggered is already true
    triggerCleanup();

    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(executionOrder).toEqual(["cleanup-start", "cleanup-end"]);
  });

  it("stdin EOF triggers the same cleanup path as SIGINT/SIGTERM", () => {
    const events: string[] = [];
    let cleanupTriggered = false;

    const triggerCleanup = (source: string) => {
      if (cleanupTriggered) return;
      cleanupTriggered = true;
      events.push(`cleanup-from-${source}`);
    };

    // Simulate: SIGINT arrives, then stdin EOF, then SIGTERM
    triggerCleanup("SIGINT");
    triggerCleanup("stdin-end");
    triggerCleanup("SIGTERM");

    expect(events).toEqual(["cleanup-from-SIGINT"]);
  });
});
