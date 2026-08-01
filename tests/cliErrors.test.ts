import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { formatCliError, isKuzuLockError } from "../src/interfaces/cli/errors.js";
import { BRAND_PATHS } from "../src/shared/branding.js";

const LOCKED_DATABASE = "C:\\workspace\\.repohelix\\graph\\kuzu.db";

describe("CLI database lock errors", () => {
  it("leaves unrelated errors unchanged", async () => {
    expect(isKuzuLockError(new Error("query failed"))).toBe(false);
    await expect(formatCliError(new Error("query failed"), process.cwd())).resolves.toBe("query failed");
  });

  it("identifies a live MCP owner and gives MCP-specific guidance", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "repohelix-cli-error-"));
    const pidPath = path.join(cwd, BRAND_PATHS.mcpPid);
    await fs.mkdir(path.dirname(pidPath), { recursive: true });
    await fs.writeFile(pidPath, JSON.stringify({
      pid: process.pid,
      cwd,
      version: "test",
      startedAt: Date.now(),
      rpc: { host: "127.0.0.1", port: 12345, token: "test-token" }
    }), "utf8");

    const output = await formatCliError(lockError(), cwd);

    expect(output).toContain(`MCP server (PID ${process.pid})`);
    expect(output).toContain("Use the RepoHelix MCP tools");
    expect(output).toContain(`Database: ${LOCKED_DATABASE}`);
    expect(output).not.toContain("docs.kuzudb.com");
  });

  it("reports an unknown lock holder as another process", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "repohelix-cli-error-"));

    const output = await formatCliError(lockError(), cwd);

    expect(output).toContain("currently in use by another process");
    expect(output).toContain("Close the other RepoHelix or Kuzu process and retry");
    expect(output).toContain(`Database: ${LOCKED_DATABASE}`);
  });
});

function lockError(): Error {
  return new Error(
    `IO exception: Could not set lock on file : ${LOCKED_DATABASE}\n` +
    "See the docs: https://docs.kuzudb.com/concurrency for more information."
  );
}
