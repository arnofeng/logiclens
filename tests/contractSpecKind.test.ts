import { describe, expect, it } from "vitest";
import { interactionStyleOfSpecKind } from "../src/core/contracts/spec.js";
import { rowToReadableContractSpec, type SpecRow } from "../src/core/contracts/specRows.js";
import { CONTRACT_SPEC_KINDS, isKnownSpecKind } from "../src/core/parsing/types.js";

describe("ContractSpecKind domain", () => {
  it("uses a runtime source of truth for known spec kinds", () => {
    expect(CONTRACT_SPEC_KINDS).toEqual(["http-endpoint", "event", "schema"]);
    expect(isKnownSpecKind("http-endpoint")).toBe(true);
    expect(isKnownSpecKind("package")).toBe(false);
    expect(isKnownSpecKind("grpc-method")).toBe(false);
  });

  it("derives interaction style from known spec kinds", () => {
    expect(interactionStyleOfSpecKind("http-endpoint")).toBe("sync-rpc");
    expect(interactionStyleOfSpecKind("event")).toBe("async-message");
    expect(interactionStyleOfSpecKind("schema")).toBe("shared-data");
  });

  it("maps unknown DB spec kinds to opaque readable specs", () => {
    const row: SpecRow = {
      id: "spec:grpc",
      contractId: "contract:api:grpc",
      specKind: "grpc-method",
      repoId: "repo:svc",
      fileId: "file:svc:proto",
      evidenceId: "ev:grpc",
      sourceSymbolId: null,
      canonicalKey: "UserService/GetUser",
      httpMethod: null,
      pathTemplate: null,
      eventTopic: null,
      framework: null,
      version: null,
      specJson: "{}",
      confidence: 0.5,
      batchId: null,
      indexedAt: null,
      active: true
    };

    const spec = rowToReadableContractSpec(row);
    expect(spec.specKind).toBe("grpc-method");
    expect("opaque" in spec && spec.opaque).toBe(true);
    expect("warning" in spec && spec.warning).toContain("grpc-method");
  });
});
