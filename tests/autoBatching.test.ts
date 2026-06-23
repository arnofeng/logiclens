import { describe, expect, it } from "vitest";
import { runIndexing } from "../src/commands/index.js";
import { defaultConfig } from "../src/config/loadConfig.js";

describe("index auto batching", () => {
  it("automatically uses a batch size of 10 if there are more than 10 repositories and batchSize is 0", async () => {
    const repos = Array.from({ length: 11 }, (_, i) => `repo-${i}`);
    const config = {
      ...defaultConfig(),
      repos: repos.map((name) => ({ name, path: "dummy-path" })),
      indexing: { ...defaultConfig().indexing, batchSize: 0 }
    };
    const mockDb = {
      query: async () => [{ count: 0 }],
      repoCount: async () => 0
    } as any;

    let success = false;
    try {
      await runIndexing(mockDb, config, {
        cwd: ".",
        writeMode: "auto",
        logger: {
          log: (message) => {
            if (message.includes("Batched indexing: batches=2 batchSize=10")) {
              success = true;
              throw new Error("ABORT_TEST_SUCCESS");
            }
          }
        }
      });
    } catch (err: any) {
      if (err.message !== "ABORT_TEST_SUCCESS") {
        throw err;
      }
    }
    expect(success).toBe(true);
  });
});
