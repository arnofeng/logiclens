import { afterEach, describe, expect, it } from "vitest";
import { ProgressBar } from "../src/utils/progress.js";

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
});
