import { describe, expect, it } from "vitest";
import { createRenderRef, parseRenderRef, RenderRefError, type RenderRefInput } from "../src/core/retrieval/renderRef.js";

function expectCode(action: () => unknown, code: RenderRefError["code"]): void {
  try {
    action();
    throw new Error("Expected render reference validation to fail.");
  } catch (error) {
    expect(error).toBeInstanceOf(RenderRefError);
    expect((error as RenderRefError).code).toBe(code);
  }
}

function rawRenderRef(payload: Record<string, unknown>): string {
  return `repohelix-render-ref:v1:${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}`;
}

describe("render references", () => {
  it("round-trips repository and Unicode file references", () => {
    const repo = createRenderRef({ workspaceId: "workspace:测试", repoId: "repo:目录", kind: "repo", canonicalId: "repo:目录" });
    expect(parseRenderRef(repo, "workspace:测试")).toEqual({ version: "v1", workspaceId: "workspace:测试", repoId: "repo:目录", kind: "repo", canonicalId: "repo:目录" });

    const file = createRenderRef({ workspaceId: "workspace:测试", repoId: "repo:目录", kind: "file", canonicalId: "file:订单", fileId: "file:订单", path: "src\\订单\\Order.ts", startLine: 3, endLine: 8 });
    expect(parseRenderRef(file, "workspace:测试")).toEqual({ version: "v1", workspaceId: "workspace:测试", repoId: "repo:目录", kind: "file", canonicalId: "file:订单", fileId: "file:订单", path: "src/订单/Order.ts", startLine: 3, endLine: 8 });
  });

  it("rejects cross-workspace references and unsafe paths", () => {
    const value = createRenderRef({ workspaceId: "workspace:a", repoId: "repo:a", kind: "repo", canonicalId: "repo:a" });
    expectCode(() => parseRenderRef(value, "workspace:b"), "workspace_mismatch");
    for (const unsafePath of ["../secret.ts", "/root/secret.ts", "C:\\secret.ts", "\\\\server\\share\\secret.ts"]) {
      expectCode(() => createRenderRef({ workspaceId: "workspace:a", repoId: "repo:a", kind: "file", canonicalId: "file:a", fileId: "file:a", path: unsafePath }), "field_invalid");
    }
  });

  it("rejects corrupt payloads, unknown versions and invalid fields", () => {
    expectCode(() => parseRenderRef("garbage", "workspace:a"), "format_invalid");
    expectCode(() => parseRenderRef("repohelix-render-ref:v1:not+base64", "workspace:a"), "format_invalid");
    expectCode(() => parseRenderRef("repohelix-render-ref:v2:e30", "workspace:a"), "version_unsupported");
    expectCode(() => createRenderRef({ workspaceId: "", repoId: "repo:a", kind: "repo", canonicalId: "repo:a" }), "field_invalid");
    expectCode(() => createRenderRef({ workspaceId: "workspace:a", repoId: "", kind: "repo", canonicalId: "repo:a" }), "field_invalid");
    expectCode(() => createRenderRef({ workspaceId: "workspace:a", repoId: "repo:a", kind: "file", canonicalId: "file:a" }), "field_invalid");
    expectCode(() => createRenderRef({ workspaceId: "workspace:a", repoId: "repo:a", kind: "repo", canonicalId: "repo:a", startLine: 0 }), "field_invalid");
    expectCode(() => createRenderRef({ workspaceId: "workspace:a", repoId: "repo:a", kind: "unknown", canonicalId: "x" } as unknown as RenderRefInput), "field_invalid");
  });

  it("enforces repository and file identity invariants on create and parse", () => {
    const inconsistentRepo = { workspaceId: "workspace:a", repoId: "repo:a", kind: "repo", canonicalId: "repo:b" } as const;
    const repoWithFile = { workspaceId: "workspace:a", repoId: "repo:a", kind: "repo", canonicalId: "repo:a", fileId: "file:a", path: "src/a.ts" } as const;
    const inconsistentFile = { workspaceId: "workspace:a", repoId: "repo:a", kind: "file", canonicalId: "file:a", fileId: "file:b", path: "src/b.ts" } as const;

    for (const input of [inconsistentRepo, repoWithFile, inconsistentFile]) {
      expectCode(() => createRenderRef(input), "field_invalid");
      expectCode(() => parseRenderRef(rawRenderRef(input), "workspace:a"), "field_invalid");
    }
  });

  it("rejects control characters and bounded fields before source loading", () => {
    for (const identity of ["repo:\u0000a", "repo:a\r\nforged"]) {
      expectCode(() => createRenderRef({ workspaceId: "workspace:a", repoId: identity, kind: "repo", canonicalId: identity }), "field_invalid");
    }
    for (const unsafePath of ["src/\u0000.ts", "src/a\r\nforged.ts"]) {
      expectCode(() => createRenderRef({ workspaceId: "workspace:a", repoId: "repo:a", kind: "file", canonicalId: "file:a", fileId: "file:a", path: unsafePath }), "field_invalid");
    }
    expectCode(() => createRenderRef({ workspaceId: `workspace:${"a".repeat(513)}`, repoId: "repo:a", kind: "repo", canonicalId: "repo:a" }), "field_invalid");
    expectCode(() => createRenderRef({ workspaceId: "workspace:a", repoId: "repo:a", kind: "file", canonicalId: "file:a", fileId: "file:a", path: `src/${"a".repeat(4096)}` }), "field_invalid");
    expectCode(() => parseRenderRef(`repohelix-render-ref:v1:${"a".repeat(10_001)}`, "workspace:a"), "format_invalid");

    const controlledPayload = { workspaceId: "workspace:a", repoId: "repo:a", kind: "file", canonicalId: "file:a", fileId: "file:a", path: "src/\u0000.ts" };
    expectCode(() => parseRenderRef(rawRenderRef(controlledPayload), "workspace:a"), "field_invalid");
  });

  it("is stable across create, parse and create", () => {
    const original = createRenderRef({ workspaceId: "workspace:a", repoId: "repo:a", kind: "code", canonicalId: "code:a", fileId: "file:a", path: "src/a.ts", startLine: 10 });
    const parsed = parseRenderRef(original, "workspace:a");
    expect(createRenderRef(parsed)).toBe(original);
  });
});
