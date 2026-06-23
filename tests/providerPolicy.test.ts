import { describe, expect, it, vi } from "vitest";
import {
  ProviderCallError,
  createProviderCallRuntime,
  runProviderCall
} from "../src/providers/openaiProvider.js";

describe("provider call policy", () => {
  it("retries 429 errors with backoff before succeeding", async () => {
    const sleep = vi.fn(async () => {});
    const runtime = createProviderCallRuntime({
      retry: { maxRetries: 2, initialDelayMs: 10, maxDelayMs: 20, jitterRatio: 0, timeoutMs: 0 }
    }, { sleep });
    const fn = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("rate limited"), { status: 429 }))
      .mockResolvedValueOnce("ok");

    await expect(runProviderCall({ label: "test", runtime, estimatedTokens: 3, fn })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(10);
    expect(runtime.stats).toMatchObject({ requests: 1, attempts: 2, retries: 1, rateLimited: 1, finalFailures: 0, estimatedTokens: 3 });
  });

  it("does not retry permanent authentication failures", async () => {
    const sleep = vi.fn(async () => {});
    const runtime = createProviderCallRuntime({
      retry: { maxRetries: 3, initialDelayMs: 10, maxDelayMs: 20, jitterRatio: 0, timeoutMs: 0 }
    }, { sleep });
    const fn = vi.fn().mockRejectedValue(Object.assign(new Error("unauthorized"), { status: 401 }));

    await expect(runProviderCall({ label: "test", runtime, estimatedTokens: 1, fn })).rejects.toMatchObject({
      kind: "permanent-failed",
      status: 401
    });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(runtime.stats).toMatchObject({ requests: 1, attempts: 1, retries: 0, permanentFailures: 1, finalFailures: 1 });
  });

  it("stops after retry budget for transient 5xx failures", async () => {
    const runtime = createProviderCallRuntime({
      retry: { maxRetries: 1, initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0, timeoutMs: 0 }
    }, { sleep: async () => {} });
    const fn = vi.fn().mockRejectedValue(Object.assign(new Error("server error"), { status: 503 }));

    await expect(runProviderCall({ label: "test", runtime, estimatedTokens: 1, fn })).rejects.toMatchObject({
      kind: "transient-failed",
      status: 503
    });
    expect(fn).toHaveBeenCalledTimes(2);
    expect(runtime.stats).toMatchObject({ requests: 1, attempts: 2, retries: 1, transientFailures: 2, finalFailures: 1 });
  });

  it("fails fast when request or token budget is exhausted", async () => {
    const runtime = createProviderCallRuntime({
      budget: { maxRequests: 1, maxEstimatedTokens: 5 },
      retry: { timeoutMs: 0 }
    });

    await expect(runProviderCall({ label: "first", runtime, estimatedTokens: 4, fn: async () => "ok" })).resolves.toBe("ok");
    await expect(runProviderCall({ label: "second", runtime, estimatedTokens: 1, fn: async () => "never" })).rejects.toBeInstanceOf(ProviderCallError);
    await expect(runProviderCall({ label: "third", runtime, estimatedTokens: 6, fn: async () => "never" })).rejects.toMatchObject({ kind: "budget-exhausted" });
    expect(runtime.stats.budgetExhausted).toBe(2);
  });

  it("serializes request starts when a minimum delay is configured", async () => {
    let now = 1000;
    const sleeps: number[] = [];
    const runtime = createProviderCallRuntime({
      retry: { timeoutMs: 0 },
      rateLimit: { minDelayMs: 50 }
    }, {
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      }
    });

    await runProviderCall({ label: "first", runtime, fn: async () => "first" });
    now += 10;
    await runProviderCall({ label: "second", runtime, fn: async () => "second" });

    expect(sleeps).toEqual([40]);
    expect(runtime.stats.requests).toBe(2);
    expect(runtime.stats.attempts).toBe(2);
  });

  it("aborts the active provider call when timeout fires", async () => {
    const runtime = createProviderCallRuntime({
      retry: { maxRetries: 0, timeoutMs: 5 }
    });
    let aborted = false;

    await expect(runProviderCall({
      label: "slow",
      runtime,
      fn: (signal) => new Promise((resolve) => {
        signal.addEventListener("abort", () => {
          aborted = true;
        });
        setTimeout(() => resolve("late"), 50);
      })
    })).rejects.toMatchObject({ kind: "transient-failed" });

    expect(aborted).toBe(true);
  });
});
