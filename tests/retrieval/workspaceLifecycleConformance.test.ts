import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("Kuzu workspace lifecycle conformance", () => {
  it("runs the shared graph-facts lifecycle in an isolated native process", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-lifecycle-"));
    try {
      const { stdout } = await execFileAsync(process.execPath, [
        path.resolve("node_modules/tsx/dist/cli.mjs"),
        path.resolve("tests/helpers/kuzuWorkspaceLifecycleScenario.ts"),
        directory
      ], {
        cwd: path.resolve("."),
        env: { ...process.env, LOGICLENS_KUZU_CLOSE_MODE: "managed" },
        timeout: 120000
      });
      expect(stdout).toContain("kuzu workspace lifecycle scenario passed");
    } finally {
      // The child has exited, so Windows no longer has an open native Kuzu
      // handle and the complete test database can be removed deterministically.
      await fs.rm(directory, { recursive: true, force: true });
    }
  }, 130000);
});
