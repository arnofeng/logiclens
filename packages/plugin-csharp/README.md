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
