# @logiclens/plugin-csharp

External C# language plugin for LogicLens. This foundation release registers `.cs` as its only parseable source extension. The manifest's `.csproj`, `.sln`, `Directory.Build.props`, and `Directory.Packages.props` globs are project-detection evidence only.

## Parser compatibility

- Runtime: `tree-sitter ^0.21.1`
- Grammar: `tree-sitter-c-sharp 0.23.1` (fixed because its peer dependency supports `tree-sitter ^0.21.1`; newer `0.23.5` requires the incompatible `tree-sitter ^0.25.0`)
- Verified Node runtime: Node.js 24.14.1 on Windows
- ESM import shape: both packages are loaded with dynamic `import()` and expose their CommonJS values through `default`

The parser and native grammar binding are loaded only on the first call to `parse`. Concurrent first calls share one initialization promise. A rejected initialization is cleared so a later parse can retry.

The parser emits namespace-qualified symbols, all C# `using` forms, invocation facts, attributes, and string/number/template literals. Record classes use the public `class` symbol kind, record structs use `struct`, constructors use `method`, and local functions use `function`. Properties are intentionally not emitted in this batch; if later schema extraction represents them as symbols, the closest public kind is the lossy `variable` mapping. Attribute owners cannot be linked to symbols because parsed symbols deliberately have no public/core ID; annotations therefore retain syntax, arguments, and line evidence without `ownerSymbolId`.

Tree-sitter provides syntax parsing rather than Roslyn semantic compilation. Qualified names are syntactic, overload resolution is unavailable, and preprocessor configurations, source generators, MSBuild evaluation, and compiler-level type resolution are not supported. Malformed declarations are omitted while independently valid portions of a partial file continue to produce facts.

## ASP.NET Core HTTP facts

The plugin extracts controller attribute routes, minimal API mappings and route groups, and stable `HttpClient` consumer calls. It resolves string literals, same-file simple `const string` values, and deterministic concatenations. Controller/action tokens and route constraints are normalized, while absolute action routes replace controller prefixes. Dynamic route expressions are deliberately omitted, and unsupported HTTP verbs are emitted without a guessed method.

HTTP extraction reparses source with the plugin-private tree-sitter grammar because `PluginContext` intentionally exposes only public file, source, symbol, and call views. Tree-sitter nodes and trees are not part of the package API. The extractor does not perform Roslyn type resolution, dependency injection analysis, runtime route convention evaluation, or arbitrary constant execution.
