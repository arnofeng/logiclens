import { describe, it, expect } from "vitest";
import { builtinContractExtractors } from "../../src/core/contracts/extraction/builtin/index.js";
import { ExtractionBuilder } from "../../src/core/contracts/extraction/extractionBuilder.js";
import type { ExtractContext } from "../../src/core/registries/types.js";

// ---------------------------------------------------------------------------
// Phase E guard — declarative extractor dependencies.
//
// `buildExtractContext` only passes `repoResolver` / `aliasOverrides` to
// extractors that opt in via `needs`. An extractor that reads one of these
// fields WITHOUT declaring the matching `needs` silently receives `undefined`,
// which is a hard-to-spot behavior bug. These tests pin that invariant.
// ---------------------------------------------------------------------------

/**
 * Runs an extractor against a context that records whether it touched the
 * optional `repoResolver` / `aliasOverrides` fields. Empty repos/files keep
 * most extractors as no-ops; consumers that read these fields unconditionally
 * (e.g. via buildOwnership) are still detected. Errors are ignored — access is
 * tracked at property-read time, before any downstream failure.
 */
async function detectOptionalAccess(extractor: (typeof builtinContractExtractors)[number]) {
  const accessed = { repoResolver: false, aliasOverrides: false };
  const ctx = {
    repos: [],
    parsedFiles: [],
    get repoResolver() {
      accessed.repoResolver = true;
      return () => undefined;
    },
    get aliasOverrides() {
      accessed.aliasOverrides = true;
      return [];
    },
  } as unknown as ExtractContext;

  try {
    await extractor.extract(ctx, new ExtractionBuilder());
  } catch {
    // ignore — we only care which optional fields were read
  }
  return accessed;
}

describe("extractor declarative needs (Phase E guard)", () => {
  it("any extractor that reads an optional field declares the matching needs", async () => {
    for (const extractor of builtinContractExtractors) {
      const accessed = await detectOptionalAccess(extractor);
      if (accessed.repoResolver) {
        expect(
          extractor.needs?.repoResolver,
          `${extractor.name} reads context.repoResolver but does not declare needs.repoResolver`
        ).toBe(true);
      }
      if (accessed.aliasOverrides) {
        expect(
          extractor.needs?.aliasOverrides,
          `${extractor.name} reads context.aliasOverrides but does not declare needs.aliasOverrides`
        ).toBe(true);
      }
    }
  });

  // Explicit pin for consumers whose access is conditional (e.g. inside a
  // parsedFiles loop) and therefore not exercised by the empty-context probe
  // above. Update this list when a consumer is added or renamed.
  const REQUIRES_REPO_RESOLVER = ["builtin:env-config"];
  const REQUIRES_ALIAS_OVERRIDES = ["builtin:import-package", "builtin:package-json"];

  it("named consumers exist and declare the right needs", () => {
    const byName = new Map(builtinContractExtractors.map((e) => [e.name, e]));
    for (const name of REQUIRES_REPO_RESOLVER) {
      const ext = byName.get(name);
      expect(ext, `${name} not found in builtinContractExtractors`).toBeDefined();
      expect(ext!.needs?.repoResolver, `${name} must declare needs.repoResolver`).toBe(true);
    }
    for (const name of REQUIRES_ALIAS_OVERRIDES) {
      const ext = byName.get(name);
      expect(ext, `${name} not found in builtinContractExtractors`).toBeDefined();
      expect(ext!.needs?.aliasOverrides, `${name} must declare needs.aliasOverrides`).toBe(true);
    }
  });
});
