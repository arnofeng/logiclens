import { afterEach, describe, expect, it, vi } from "vitest";
import { ProgressBar, RepositoryPreparationProgress } from "../src/shared/progress.js";

describe("ProgressBar", () => {
  const originalWrite = process.stderr.write;
  const originalIsTTY = process.stderr.isTTY;
  const originalColumns = process.stderr.columns;
  const originalCI = process.env.CI;

  afterEach(() => {
    process.stderr.write = originalWrite;
    Object.defineProperty(process.stderr, "isTTY", { configurable: true, value: originalIsTTY });
    Object.defineProperty(process.stderr, "columns", { configurable: true, value: originalColumns });
    if (originalCI === undefined) {
      delete process.env.CI;
    } else {
      process.env.CI = originalCI;
    }
    vi.useRealTimers();
  });

  it("keeps interactive progress rendering on one terminal line", () => {
    delete process.env.CI;
    const writes: string[] = [];
    process.stderr.write = ((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    Object.defineProperty(process.stderr, "isTTY", { configurable: true, value: true });
    Object.defineProperty(process.stderr, "columns", { configurable: true, value: 72 });

    const bar = new ProgressBar("Files bos-fe-kraken-ec-goodsv2", 100);
    bar.update(9, "src/pages/goods/detail/components/very/deep/path/router.tsx");

    const rendered = writes.at(-1)?.replace(/^\r\x1b\[2K/, "") ?? "";
    expect(rendered.length).toBeLessThanOrEqual(71);
    expect(rendered).toContain("...");
    expect(rendered).not.toContain("\n");
  });

  it("freezes elapsed time once progress reaches completion", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    delete process.env.CI;
    const writes: string[] = [];
    process.stderr.write = ((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    Object.defineProperty(process.stderr, "isTTY", { configurable: true, value: true });
    Object.defineProperty(process.stderr, "columns", { configurable: true, value: 120 });

    const bar = new ProgressBar("Resolve calls", 2);
    vi.setSystemTime(1200);
    bar.update(2, "resolved");
    vi.setSystemTime(9900);
    bar.complete("done");

    const rendered = writes[0]?.replace(/^\r\x1b\[2K/, "") ?? "";
    expect(rendered).toContain("1.2s resolved");
    expect(writes).toHaveLength(2);
    expect(writes[1]).toBe("\n");
  });

  it("finalizes completed interactive bars before later bars render", () => {
    delete process.env.CI;
    const writes: string[] = [];
    process.stderr.write = ((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    Object.defineProperty(process.stderr, "isTTY", { configurable: true, value: true });
    Object.defineProperty(process.stderr, "columns", { configurable: true, value: 120 });

    const first = new ProgressBar("Resolve calls", 1);
    const second = new ProgressBar("Framework detection", 1);
    first.update(1, "resolved");
    second.update(1, "detected");
    first.complete("done");
    second.complete("done");

    const renderedLines = writes
      .filter((write) => write !== "\n")
      .map((write) => write.replace(/^\r\x1b\[2K/, ""));
    expect(renderedLines).toHaveLength(2);
    expect(renderedLines[0]).toContain("Resolve calls");
    expect(renderedLines[1]).toContain("Framework detection");
  });

  it("renders concurrent repository preparation through one aggregate terminal line", () => {
    delete process.env.CI;
    const writes: string[] = [];
    process.stderr.write = ((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    Object.defineProperty(process.stderr, "isTTY", { configurable: true, value: true });
    Object.defineProperty(process.stderr, "columns", { configurable: true, value: 120 });

    const preparation = new RepositoryPreparationProgress(
      (label, total) => new ProgressBar(label, total),
      ["service-a", "service-b"]
    );
    const serviceA = preparation.startRepo("service-a")("Files service-a", 2);
    const serviceB = preparation.startRepo("service-b")("Files service-b", 3);
    serviceA.tick("a.ts");
    serviceB.tick("b.ts");
    serviceA.complete();
    preparation.completeRepo("service-a");
    serviceB.complete();
    preparation.completeRepo("service-b");

    const renderedLines = writes
      .filter((write) => write !== "\n")
      .map((write) => write.replace(/^\r\x1b\[2K/, ""));
    expect(renderedLines.length).toBeGreaterThan(2);
    expect(renderedLines.every((line) => line.startsWith("Repository preparation"))).toBe(true);
    expect(renderedLines.every((line) => !line.includes("service-a") && !line.includes("service-b"))).toBe(true);
    expect(renderedLines.at(-1)).toContain("2/2 100%");
    expect(writes.filter((write) => write === "\n")).toHaveLength(1);
  });
});
