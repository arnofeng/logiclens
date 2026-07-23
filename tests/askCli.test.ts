import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ask: vi.fn(),
  close: vi.fn(),
  createClient: vi.fn(),
}));

vi.mock("../src/interfaces/sdk/client.js", () => ({ createClient: mocks.createClient }));

import { askCommand } from "../src/interfaces/cli/ask.js";

describe("ask CLI", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("keeps the default question-only call and prints citation, location, and concise diagnostics", async () => {
    const output = [
      "Diagnostics: outcome=succeeded queries=2 lexical=succeeded/1 sourceLoading=completed/1",
      "Verified evidence citations:",
      "- [C1] code repo:api/src/orders.ts:10-20 createOrder",
    ].join("\n");
    mocks.ask.mockResolvedValueOnce(output);
    mocks.close.mockResolvedValueOnce(undefined);
    mocks.createClient.mockResolvedValueOnce({ ask: mocks.ask, close: mocks.close });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await askCommand("where are orders?", "C:/workspace");

    expect(mocks.ask).toHaveBeenCalledWith("where are orders?");
    expect(log).toHaveBeenCalledWith(output);
    expect(output).toContain("[C1]");
    expect(output).toContain("repo:api/src/orders.ts:10-20");
    expect(output).not.toContain("searchableText");
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it("prints the stable refusal and closes", async () => {
    mocks.ask.mockResolvedValueOnce("no_reliable_evidence");
    mocks.close.mockResolvedValueOnce(undefined);
    mocks.createClient.mockResolvedValueOnce({ ask: mocks.ask, close: mocks.close });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await askCommand("unknown", "C:/workspace");
    expect(log).toHaveBeenCalledWith("no_reliable_evidence");
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it("closes when asking throws", async () => {
    mocks.ask.mockRejectedValueOnce(new Error("ask failed"));
    mocks.close.mockResolvedValueOnce(undefined);
    mocks.createClient.mockResolvedValueOnce({ ask: mocks.ask, close: mocks.close });
    await expect(askCommand("boom", "C:/workspace")).rejects.toThrow("ask failed");
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it("recovers a Git Bash converted API target before asking", async () => {
    mocks.ask.mockResolvedValue("answer");
    mocks.close.mockResolvedValue(undefined);
    mocks.createClient.mockResolvedValue({ ask: mocks.ask, close: mocks.close });
    vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await askCommand(
      "C:/Program Files/Git/mall/mgr/groupon/activity/createActivity",
      "C:/workspace",
      { platform: "win32", env: { MSYSTEM: "MINGW64", ProgramFiles: "C:/Program Files" } }
    );

    expect(mocks.ask).toHaveBeenCalledWith("/mall/mgr/groupon/activity/createActivity");
    expect(warn).toHaveBeenCalledWith(
      "Recovered Git Bash/MSYS path conversion as API target: /mall/mgr/groupon/activity/createActivity"
    );
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it("does not reject ordinary Windows paths or non-MSYS shells", async () => {
    mocks.ask.mockResolvedValue("ok");
    mocks.close.mockResolvedValue(undefined);
    mocks.createClient.mockResolvedValue({ ask: mocks.ask, close: mocks.close });
    vi.spyOn(console, "log").mockImplementation(() => {});

    await askCommand(
      "C:/workspace/src/createActivity.ts",
      "C:/workspace",
      { platform: "win32", env: { MSYSTEM: "MINGW64", ProgramFiles: "C:/Program Files" } }
    );
    await askCommand(
      "C:/Program Files/Git/mall/mgr/groupon/activity/createActivity",
      "C:/workspace",
      { platform: "win32", env: { ProgramFiles: "C:/Program Files" } }
    );

    expect(mocks.ask).toHaveBeenNthCalledWith(1, "C:/workspace/src/createActivity.ts");
    expect(mocks.ask).toHaveBeenNthCalledWith(2, "C:/Program Files/Git/mall/mgr/groupon/activity/createActivity");
    expect(mocks.close).toHaveBeenCalledTimes(2);
  });
});
