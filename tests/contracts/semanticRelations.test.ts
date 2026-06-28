import { describe, expect, it } from "vitest";
import {
  SEMANTIC_REL_META,
  CONSUMER_TO_PRODUCER_KINDS,
  SCHEMA_TO_USE_KINDS
} from "../../src/core/contracts/semanticRelations.js";
import type { SemanticRelationKind } from "../../src/core/parsing/types.js";

// ---------------------------------------------------------------------------
// Equivalence snapshot tests — verify that the derived sets match the old
// hard-coded values that they replaced in impactEngine.ts and the switch
// branch in crossRepoContracts.ts.
// ---------------------------------------------------------------------------

describe("SEMANTIC_REL_META", () => {
  it("covers every SemanticRelationKind exactly once", () => {
    // The Record<SemanticRelationKind, SemanticRelMeta> type ensures this at
    // compile time; this test guards against a partial object if the type
    // constraint is bypassed.
    const expectedKinds: SemanticRelationKind[] = [
      "IMPLEMENTS",
      "CALLS_ENDPOINT",
      "PUBLISHES_EVENT",
      "SUBSCRIBES_EVENT",
      "USES_SCHEMA",
      "REQUEST_SCHEMA",
      "RESPONSE_SCHEMA",
      "EVENT_PAYLOAD",
      "COMPATIBLE_WITH",
      "BREAKS",
      "IMPACTS",
    ];
    const actualKinds = Object.keys(SEMANTIC_REL_META).sort();
    expect(actualKinds).toEqual(expectedKinds.sort());
  });

  it("has no duplicate direction/category conflicts", () => {
    // PUBLISHES_EVENT is the only "reverse" direction kind
    const reverseKinds = Object.entries(SEMANTIC_REL_META)
      .filter(([, m]) => m.direction === "reverse")
      .map(([k]) => k);
    expect(reverseKinds).toEqual(["PUBLISHES_EVENT"]);
  });
});

describe("CONSUMER_TO_PRODUCER_KINDS", () => {
  it("matches the old hard-coded set from impactEngine.ts byte-for-byte", () => {
    // Old set: CALLS_ENDPOINT, SUBSCRIBES_EVENT, PUBLISHES_EVENT
    const oldSet = new Set<SemanticRelationKind>([
      "CALLS_ENDPOINT",
      "SUBSCRIBES_EVENT",
      "PUBLISHES_EVENT",
    ]);

    // Must be byte-identical — any new member is a regression
    expect(CONSUMER_TO_PRODUCER_KINDS).toEqual(oldSet);
  });
});

describe("SCHEMA_TO_USE_KINDS", () => {
  it("matches the old hard-coded set from impactEngine.ts", () => {
    // Old set: REQUEST_SCHEMA, RESPONSE_SCHEMA, EVENT_PAYLOAD, USES_SCHEMA
    const oldSet = new Set<SemanticRelationKind>([
      "REQUEST_SCHEMA",
      "RESPONSE_SCHEMA",
      "EVENT_PAYLOAD",
      "USES_SCHEMA",
    ]);

    // Must be byte-identical
    expect(SCHEMA_TO_USE_KINDS).toEqual(oldSet);
  });
});

describe("dependencyType mapping (replaces switch in crossRepoContracts.ts)", () => {
  it("maps materializable kinds to the correct dependencyType", () => {
    expect(SEMANTIC_REL_META["CALLS_ENDPOINT"].dependencyType).toBe("api");
    expect(SEMANTIC_REL_META["SUBSCRIBES_EVENT"].dependencyType).toBe("event");
    expect(SEMANTIC_REL_META["PUBLISHES_EVENT"].dependencyType).toBe("event");
    expect(SEMANTIC_REL_META["USES_SCHEMA"].dependencyType).toBe("shared-contract");
  });

  it("marks intra-spec kinds with null dependencyType (not materialized)", () => {
    const intraSpecKinds = [
      "REQUEST_SCHEMA",
      "RESPONSE_SCHEMA",
      "EVENT_PAYLOAD",
      "IMPLEMENTS",
      "COMPATIBLE_WITH",
      "BREAKS",
      "IMPACTS",
    ] as SemanticRelationKind[];
    for (const kind of intraSpecKinds) {
      expect(SEMANTIC_REL_META[kind].dependencyType).toBeNull();
    }
  });

  it("has correct direction for all consumer-to-producer kinds", () => {
    // CALLS_ENDPOINT: fromSpec=consumer → forward
    expect(SEMANTIC_REL_META["CALLS_ENDPOINT"].direction).toBe("forward");
    // SUBSCRIBES_EVENT: fromSpec=consumer → forward
    expect(SEMANTIC_REL_META["SUBSCRIBES_EVENT"].direction).toBe("forward");
    // PUBLISHES_EVENT: fromSpec=producer → reverse
    expect(SEMANTIC_REL_META["PUBLISHES_EVENT"].direction).toBe("reverse");
  });
});
