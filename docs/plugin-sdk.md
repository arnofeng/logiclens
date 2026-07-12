# Plugin SDK Reference

`@logiclens/plugin-sdk` is the public TypeScript contract for LogicLens plugins. `@logiclens/plugin-runtime` discovers plugin directories, resolves their compiled entry points, imports their exports, and validates API compatibility.

Read the [Plugin Guide](plugins.md) first for installation, discovery, activation, and troubleshooting.

## Package Setup

Plugins are ESM packages and must ship compiled JavaScript. Add the SDK as a dependency and make the package entry point resolvable:

```json
{
  "name": "@example/logiclens-plugin-example",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "dependencies": {
    "@logiclens/plugin-sdk": "^0.1.0"
  },
  "files": ["dist", "plugin.json", "README.md"]
}
```

Every installed plugin directory also needs `plugin.json`:

```json
{
  "name": "@example/logiclens-plugin-example",
  "version": "0.1.0",
  "logiclensPluginApiVersion": "0.1.0",
  "capabilities": ["language", "fact-extractor", "framework-detector"],
  "entry": "./dist/index.js",
  "languages": [
    {
      "id": "example",
      "extensions": [".example"],
      "detect": {
        "extensions": [".example"],
        "markers": ["example.project"],
        "globs": ["**/*.example-project"]
      }
    }
  ]
}
```

`entry` is optional when `package.json` provides `exports["."].import`, `exports["."].default`, `module`, or `main`. An explicit `entry` is easiest to audit.

The exported plugin manifest must match `plugin.json` for name, version, capabilities, language IDs, and extensions. Runtime compatibility is checked by the major plugin API version.

## Minimal Plugin

```ts
import {
  defineFactExtractor,
  defineLanguage,
  definePlugin,
  type PluginManifest
} from "@logiclens/plugin-sdk";

const manifest = {
  name: "@example/logiclens-plugin-example",
  version: "0.1.0",
  logiclensPluginApiVersion: "0.1.0",
  capabilities: ["language", "fact-extractor"],
  languages: [{
    id: "example",
    extensions: [".example"],
    detect: { extensions: [".example"] }
  }]
} satisfies PluginManifest;

const language = defineLanguage({
  id: "example",
  extensions: [".example"],
  parse({ source }) {
    return {
      symbols: [{
        kind: "class",
        name: "Example",
        startLine: 1,
        endLine: source.split(/\r?\n/).length
      }]
    };
  }
});

const extractor = defineFactExtractor({
  name: "example-http",
  languages: ["example"],
  extract(context) {
    for (const file of context.files.byLanguage("example")) {
      context.emit.httpEndpoint({
        repoId: file.repoId,
        filePath: file.path,
        method: "GET",
        path: "/example",
        role: "producer",
        evidence: {
          filePath: file.path,
          line: 1,
          raw: "GET /example",
          rule: "example.route",
          confidence: "exact"
        }
      });
    }
  }
});

export const plugin = definePlugin({
  manifest,
  languages: [language],
  factExtractors: [extractor]
});

export default plugin;
```

The runtime accepts a default export, a named `plugin` export, or a module whose namespace is itself the plugin object. A default export is recommended.

## Manifest and Capabilities

| Capability | Exported payload | Purpose |
|---|---|---|
| `language` | `languages` | Parse source and optionally emit AST facts. |
| `fact-extractor` | `factExtractors` | Emit normalized contract and relation facts. |
| `framework-detector` | `frameworkDetectors` | Emit framework facts from repository evidence. |
| `resolver` | `resolvers` | Public SDK shape for reference resolution; the current host does not execute plugin resolvers yet. |

If a capability is declared, its matching exported array is required. A language capability also requires non-empty `manifest.languages`, and exported language IDs/extensions must match the manifest.

`requiresLanguages` activates prerequisite languages. For example, a component language can declare that JavaScript or TypeScript parsing is also needed.

## Language Plugins

`defineLanguage()` accepts:

- `id` and `extensions`: required identity and source extensions.
- `parse(input)`: a custom parser returning symbols, imports, calls, and optional AST facts.
- `treeSitter.queries` and `facts`: reserved public SDK shapes for query-driven parsing and AST fact extraction. The current host adapter does not execute these fields for external plugins; provide `parse(input)` today.

`PluginParseInput` contains `repoId`, absolute and relative paths, language ID, and source. A parse result can contain `symbols`, `imports`, `calls`, and `facts`. Line numbers are 1-based.

## Extractors and Context

`defineFactExtractor()` provides `extract(context)` and optional `postExtract(context)` phases. Filter work with `languages` and `frameworks` metadata.

The context exposes read-only repository, file, symbol, import, and call views. `context.files` supports `all()`, `byLanguage()`, `byRepo()`, and `get(repoId, path)`.

Emit facts through `context.emit`:

- `httpEndpoint`, `schema`, `event`, `grpcMethod`, `packageUsage`, and `framework`
- `semanticRelation` to connect stable contract spec keys
- `fact` for a complete discriminated `PluginContractFact`

`postExtract` additionally receives `context.facts`, which can query facts emitted earlier in the extraction pass. Use it when one fact depends on endpoints, schemas, events, packages, or frameworks already collected.

Every emitted fact must belong to the current context and include evidence with a repository-relative `filePath`, 1-based line, raw source description, stable rule name, and confidence (`exact`, `probable`, `heuristic`, or a numeric value).

## Framework Detectors

`defineFrameworkDetector()` receives the same base `PluginContext`. Inspect files, imports, calls, or repository metadata and emit one framework fact per detected framework. Include all supporting evidence entries when several files contribute to the detection.

## Utilities

Import helpers from `@logiclens/plugin-sdk/utils`:

```ts
import {
  joinHttpPaths,
  lineOfOffset,
  normalizeHttpPath,
  normalizeRouteParam,
  normalizeRouteTemplate,
  safeJsonParse,
  sourceLine
} from "@logiclens/plugin-sdk/utils";
```

These helpers keep line calculation, route normalization, and defensive JSON parsing consistent across plugins.

## Build and Verify

Before installing or publishing a plugin:

1. Compile the ESM entry and declarations.
2. Ensure the published directory contains `plugin.json`, compiled output, runtime dependencies, and README.
3. Keep `plugin.json` and the exported manifest synchronized.
4. Install the packed artifact with `logiclens plugin install ./plugin.tgz --repo <fixture-repo>`.
5. Run `logiclens index` with `plugins.failFast: true`, then inspect `logiclens frameworks`, `logiclens contracts`, and `logiclens quality` as applicable.
6. Test absent markers, excluded files, malformed source, and multiple repositories as well as the happy path.

The repository's [`@logiclens/plugin-csharp`](../packages/plugin-csharp/README.md) package is the canonical implementation example.
