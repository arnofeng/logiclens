import { describe, expect, it } from "vitest";
import { parseFileId, repoNameFromId } from "../src/shared/path.js";

describe("shared path identities", () => {
  it("parses canonical file and repository IDs", () => {
    expect(repoNameFromId("repo:mp-groupon-center")).toBe("mp-groupon-center");
    expect(parseFileId(
      "file:repo:mp-groupon-center:src/main/java/ActivityCreateDTO.java",
      "repo:mp-groupon-center"
    )).toEqual({
      repoName: "mp-groupon-center",
      filePath: "src/main/java/ActivityCreateDTO.java",
    });
  });

  it("accepts legacy file IDs and relative paths", () => {
    expect(parseFileId("file:orders:src/order.ts", "repo:orders")).toEqual({
      repoName: "orders",
      filePath: "src/order.ts",
    });
    expect(parseFileId("src/order.ts", "repo:orders")).toEqual({
      repoName: "orders",
      filePath: "src/order.ts",
    });
  });
});
