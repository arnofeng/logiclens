# @logiclens/plugin-csharp

External C# language plugin for LogicLens. This foundation release registers `.cs` as its only parseable source extension. The manifest's `.csproj`, `.sln`, `Directory.Build.props`, and `Directory.Packages.props` globs are project-detection evidence only.

## Parser compatibility

- Runtime: `tree-sitter ^0.21.1`
- Grammar: `tree-sitter-c-sharp 0.23.1` (fixed because its peer dependency supports `tree-sitter ^0.21.1`; newer `0.23.5` requires the incompatible `tree-sitter ^0.25.0`)
- Verified Node runtime: Node.js 24.14.1 on Windows
- ESM import shape: both packages are loaded with dynamic `import()` and expose their CommonJS values through `default`

The parser and native grammar binding are loaded only on the first call to `parse`. Concurrent first calls share one initialization promise. A rejected initialization is cleared so a later parse can retry.

Representative compatibility tests cover file-scoped namespaces, records, nullable reference and value types, attributes, generic methods, lambdas, and ASP.NET Core minimal-API-style syntax. This batch intentionally emits empty symbols, imports, calls, and AST facts; semantic extraction, framework detection, HTTP extraction, schema extraction, and normalization are deferred to later batches. Tree-sitter provides syntax parsing rather than Roslyn semantic compilation, and preprocessor configurations, source generators, MSBuild evaluation, and compiler-level type resolution are not supported.
