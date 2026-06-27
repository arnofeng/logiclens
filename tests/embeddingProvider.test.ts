import { describe, expect, it, beforeEach, vi } from "vitest";
import { NullEmbeddingProvider, resolveEmbeddingProvider, cosineSimilarity } from "../src/semantic/embeddings.js";
import { EmbeddingProviderRegistry, embeddingProviderRegistry } from "../src/plugins/registry.js";
import { loadPlugins } from "../src/plugins/loader.js";
import { OpenAIEmbeddingProvider } from "../src/adapters/embeddings/openaiEmbeddingProvider.js";
import { configSchema } from "../src/config/schema.js";
import type { EmbeddingProvider } from "../src/plugins/types.js";

describe("EmbeddingProvider abstraction", () => {
  describe("NullEmbeddingProvider", () => {
    it("returns undefined for all texts", async () => {
      const provider = new NullEmbeddingProvider();
      expect(provider.name).toBe("off");
      expect(await provider.embedText("hello")).toBeUndefined();
      expect(await provider.embedTexts(["a", "b", "c"])).toEqual([undefined, undefined, undefined]);
    });

    it("returns empty array for empty input", async () => {
      const provider = new NullEmbeddingProvider();
      expect(await provider.embedTexts([])).toEqual([]);
    });
  });

  describe("EmbeddingProviderRegistry", () => {
    let registry: EmbeddingProviderRegistry;
    const fakeProvider: EmbeddingProvider = {
      name: "fake",
      async embedTexts(texts) { return texts.map((_, i) => [i]); },
      async embedText(text) { return [text.length]; }
    };

    beforeEach(() => {
      registry = new EmbeddingProviderRegistry();
    });

    it("registers and resolves a provider by name", () => {
      registry.register(fakeProvider);
      expect(registry.resolve("fake")).toBe(fakeProvider);
    });

    it("returns undefined for unregistered names", () => {
      expect(registry.resolve("nonexistent")).toBeUndefined();
    });

    it("lists registered provider names", () => {
      registry.register(fakeProvider);
      registry.register({ ...fakeProvider, name: "another" });
      expect(registry.names().sort()).toEqual(["another", "fake"]);
    });

    it("lists all providers", () => {
      registry.register(fakeProvider);
      expect(registry.providers()).toEqual([fakeProvider]);
    });

    it("overwrites a provider with the same name and warns", () => {
      const replacement: EmbeddingProvider = {
        name: "fake",
        async embedTexts() { return []; },
        async embedText() { return undefined; }
      };
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      registry.register(fakeProvider);
      expect(warnSpy).not.toHaveBeenCalled();
      registry.register(replacement);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('"fake" is already registered'));
      warnSpy.mockRestore();
      expect(registry.resolve("fake")).toBe(replacement);
      expect(registry.providers()).toHaveLength(1);
    });
  });

  describe("built-in OpenAI provider registration via loadPlugins", () => {
    it("registers an OpenAI provider when configured", async () => {
      const config = configSchema.parse({ embedding: { provider: "openai", apiKey: "key" } });
      await loadPlugins({ config, loadConfiguredPlugins: false });
      expect(embeddingProviderRegistry.resolve("openai")).toBeInstanceOf(OpenAIEmbeddingProvider);
    });

    it("does not overwrite an already-registered openai provider", async () => {
      const custom: EmbeddingProvider = {
        name: "openai",
        async embedTexts() { return []; },
        async embedText() { return undefined; }
      };
      embeddingProviderRegistry.register(custom);
      const config = configSchema.parse({ embedding: { provider: "openai", apiKey: "key" } });
      await loadPlugins({ config, loadConfiguredPlugins: false });
      expect(embeddingProviderRegistry.resolve("openai")).toBe(custom);
    });

    it("does not register a provider when embedding is off", async () => {
      const config = configSchema.parse({ embedding: { provider: "off" } });
      await loadPlugins({ config, loadConfiguredPlugins: false });
      expect(embeddingProviderRegistry.resolve("off")).toBeUndefined();
    });
  });

  describe("resolveEmbeddingProvider", () => {
    it("returns NullEmbeddingProvider for 'off'", () => {
      const provider = resolveEmbeddingProvider("off");
      expect(provider).toBeInstanceOf(NullEmbeddingProvider);
    });

    it("throws with the no-providers hint when the registry is empty", () => {
      const empty = new EmbeddingProviderRegistry();
      expect(() => resolveEmbeddingProvider("nonexistent", empty)).toThrow(/"nonexistent" is not registered/);
      expect(() => resolveEmbeddingProvider("nonexistent", empty)).toThrow(/No embedding providers are registered/);
    });

    it("lists available providers in the error when some are registered", () => {
      const registry = new EmbeddingProviderRegistry();
      registry.register({ name: "alpha", async embedTexts() { return []; }, async embedText() { return undefined; } });
      expect(() => resolveEmbeddingProvider("nonexistent", registry)).toThrow(/Available providers: alpha/);
    });

    it("resolves a registered provider from a given registry", () => {
      const registry = new EmbeddingProviderRegistry();
      const provider = { name: "alpha", async embedTexts() { return []; }, async embedText() { return undefined; } };
      registry.register(provider);
      expect(resolveEmbeddingProvider("alpha", registry)).toBe(provider);
    });
  });

  describe("cosineSimilarity", () => {
    it("returns 1 for identical vectors", () => {
      expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1);
    });

    it("returns 0 for orthogonal vectors", () => {
      expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    });

    it("returns 0 for empty vectors", () => {
      expect(cosineSimilarity([], [])).toBe(0);
    });

    it("returns 0 for mismatched dimensions", () => {
      expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
    });

    it("returns 0 for zero vectors", () => {
      expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
    });

    it("computes correct similarity for arbitrary vectors", () => {
      const a = [1, 2, 3];
      const b = [4, 5, 6];
      const dot = 1 * 4 + 2 * 5 + 3 * 6;
      const normA = Math.sqrt(1 + 4 + 9);
      const normB = Math.sqrt(16 + 25 + 36);
      expect(cosineSimilarity(a, b)).toBeCloseTo(dot / (normA * normB));
    });
  });
});
