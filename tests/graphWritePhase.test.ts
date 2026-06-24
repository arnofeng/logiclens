import { describe, expect, it } from "vitest";
import { selectGraphWriter } from "../src/indexing/graphWrite.js";

describe("graph write phase", () => {
  it("uses bulk-copy for the first empty batched full import and append-copy afterward", () => {
    expect(selectGraphWriter({
      writeMode: "auto",
      batchedFull: true,
      graphIsEmpty: true
    })).toEqual({
      mode: "bulk-copy",
      fast: true,
      fallbackToMerge: false
    });

    expect(selectGraphWriter({
      writeMode: "auto",
      batchedFull: true,
      graphIsEmpty: false
    })).toEqual({
      mode: "append-copy",
      fast: true,
      fallbackToMerge: false
    });
  });

  it("keeps full empty graph imports on bulk-copy", () => {
    expect(selectGraphWriter({
      writeMode: "bulk",
      fullCopyBulk: true
    })).toEqual({
      mode: "bulk-copy",
      fast: true,
      fallbackToMerge: false
    });
  });

  it("uses append-copy for auto full per-repo updates with merge fallback", () => {
    expect(selectGraphWriter({
      writeMode: "auto",
      changedOnly: false
    })).toEqual({
      mode: "append-copy",
      fast: true,
      fallbackToMerge: true
    });
  });

  it("uses bulk-upsert for auto changed-only updates with merge fallback", () => {
    expect(selectGraphWriter({
      writeMode: "auto",
      changedOnly: true
    })).toEqual({
      mode: "bulk-upsert",
      fast: true,
      fallbackToMerge: true
    });
  });

  it("keeps explicit bulk-upsert as a hard-failing fast writer", () => {
    expect(selectGraphWriter({
      writeMode: "bulk-upsert",
      changedOnly: true
    })).toEqual({
      mode: "bulk-upsert",
      fast: true,
      fallbackToMerge: false
    });
  });

  it("uses merge for explicit merge mode", () => {
    expect(selectGraphWriter({
      writeMode: "merge",
      changedOnly: true
    })).toEqual({
      mode: "merge",
      fast: false,
      fallbackToMerge: false
    });
  });

  describe("non-kuzu provider forces merge mode", () => {
    it("forces merge mode for neo4j provider regardless of writeMode=auto", () => {
      expect(selectGraphWriter({
        writeMode: "auto",
        batchedFull: true,
        graphIsEmpty: true,
        provider: "neo4j"
      })).toEqual({
        mode: "merge",
        fast: false,
        fallbackToMerge: false
      });
    });

    it("forces merge mode for neo4j provider with bulk writeMode", () => {
      expect(selectGraphWriter({
        writeMode: "bulk",
        fullCopyBulk: true,
        provider: "neo4j"
      })).toEqual({
        mode: "merge",
        fast: false,
        fallbackToMerge: false
      });
    });

    it("forces merge mode for neo4j provider with changedOnly", () => {
      expect(selectGraphWriter({
        writeMode: "auto",
        changedOnly: true,
        provider: "neo4j"
      })).toEqual({
        mode: "merge",
        fast: false,
        fallbackToMerge: false
      });
    });

    it("forces merge mode for any non-kuzu provider name", () => {
      expect(selectGraphWriter({
        writeMode: "bulk",
        fullCopyBulk: true,
        provider: "custom-db"
      })).toEqual({
        mode: "merge",
        fast: false,
        fallbackToMerge: false
      });
    });

    it("does not force merge mode for kuzu provider", () => {
      expect(selectGraphWriter({
        writeMode: "auto",
        batchedFull: true,
        graphIsEmpty: true,
        provider: "kuzu"
      })).toEqual({
        mode: "bulk-copy",
        fast: true,
        fallbackToMerge: false
      });
    });

    it("does not force merge mode when provider is undefined", () => {
      expect(selectGraphWriter({
        writeMode: "auto",
        batchedFull: true,
        graphIsEmpty: true
      })).toEqual({
        mode: "bulk-copy",
        fast: true,
        fallbackToMerge: false
      });
    });
  });
});
