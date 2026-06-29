import { describe, expect, it } from "vitest";
import { interactionStyleOfSpecKind } from "../src/core/contracts/spec.js";
import { rowToReadableContractSpec, type SpecRow } from "../src/core/contracts/specRows.js";
import { CONTRACT_SPEC_KINDS, isKnownSpecKind } from "../src/core/parsing/types.js";

describe("ContractSpecKind domain", () => {
  it("uses a runtime source of truth for known spec kinds", () => {
    expect(CONTRACT_SPEC_KINDS).toEqual(["http-endpoint", "event", "schema", "grpc-method", "dubbo-method"]);
    expect(isKnownSpecKind("http-endpoint")).toBe(true);
    expect(isKnownSpecKind("grpc-method")).toBe(true);
    expect(isKnownSpecKind("dubbo-method")).toBe(true);
    expect(isKnownSpecKind("package")).toBe(false);
    expect(isKnownSpecKind("graphql-operation")).toBe(false);
  });

  it("derives interaction style from known spec kinds", () => {
    expect(interactionStyleOfSpecKind("http-endpoint")).toBe("sync-rpc");
    expect(interactionStyleOfSpecKind("grpc-method")).toBe("sync-rpc");
    expect(interactionStyleOfSpecKind("dubbo-method")).toBe("sync-rpc");
    expect(interactionStyleOfSpecKind("event")).toBe("async-message");
    expect(interactionStyleOfSpecKind("schema")).toBe("shared-data");
  });

  it("maps unknown DB spec kinds to opaque readable specs", () => {
    const row: SpecRow = {
      id: "spec:graphql",
      contractId: "contract:api:graphql",
      specKind: "graphql-operation",
      repoId: "repo:svc",
      fileId: "file:svc:graphql",
      evidenceId: "ev:graphql",
      sourceSymbolId: null,
      canonicalKey: "UserQuery/GetUser",
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
    expect(spec.specKind).toBe("graphql-operation");
    expect("opaque" in spec && spec.opaque).toBe(true);
    expect("warning" in spec && spec.warning).toContain("graphql-operation");
  });
});
