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

HTTP body types unwrap only semantically known single-payload task, action-result, typed-result, collection, and dictionary wrappers. `Results<...>` unions produce a body type only when all branches yield exactly one unique payload; status-only branches are ignored, while multiple payloads and unknown custom generic envelopes remain unresolved rather than selecting an arbitrary type argument.

HTTP extraction reparses source with the plugin-private tree-sitter grammar because `PluginContext` intentionally exposes only public file, source, symbol, and call views. Tree-sitter nodes and trees are not part of the package API. The extractor does not perform Roslyn type resolution, dependency injection analysis, runtime route convention evaluation, or arbitrary constant execution.

## Schema facts

The schema extractor supports records (including positional records), classes, and structs. It emits a declaration only when public HTTP request/response facts reference its simple or qualified name, the declaration has an explicit serialization attribute, or its name ends in `DTO`, `Dto`, `Request`, `Response`, `Payload`, `Contract`, or `Model`. Ordinary domain classes without one of those signals are intentionally omitted. Generic HTTP wrappers and collection wrappers are traversed when identifying referenced declarations.

Public readable instance properties and positional record members are included. Static properties and fields are excluded. Public instance fields require explicit serialization meaning such as `JsonInclude`, `JsonPropertyName`, `JsonRequired`, or `DataMember`; unannotated public fields are excluded. `IgnoreDataMember` and unconditional or `Always` `JsonIgnore` exclude a member, while `JsonIgnoreCondition.Never`, `WhenWritingNull`, and `WhenWritingDefault` retain it in the structural schema. `JsonPropertyName`, `DataMember(Name = ...)`, `JsonRequired`, `Required`, and the C# `required` modifier are handled conservatively from syntax only.

Field `nullable` describes whether the declared field value may be null (`T?` or `Nullable<T>`). Field `optional` describes whether serialized input may omit the member: it is true for nullable or default-initialized members unless `required`, `JsonRequired`, `Required`, or `DataMember(IsRequired = true)` supplies contrary evidence. A non-nullable property without required metadata remains non-optional because the plugin does not assume serializer settings, constructor flow analysis, or nullable-context defaults. Nullable element types remain visible inside normalized collection/dictionary/generic types but do not make their container field nullable. Primitive and `System.*` aliases, jagged/multidimensional arrays, common collections, dictionaries, nullable types, qualified/nested types, and other generics receive deterministic syntactic normalization. Qualified endpoint references retain their namespace/nesting; simple ambiguous references are left unresolved by the public relation resolver instead of selecting the wrong same-named schema. Partial declarations are merged deterministically by qualified identity.

## gRPC and messaging facts

gRPC extraction supports implementations that inherit generated `Service.ServiceBase` types and override methods carrying `ServerCallContext`. Unary, client-streaming, server-streaming, and bidirectional-streaming modes are derived only from stable signatures. Generated and `obj/` source is never a contract owner. Typed `Service.ServiceClient` calls are consumers. Similar ordinary `Base` and `Client` classes are ignored; reflection, interceptor routing, generated-code recovery, and Roslyn-only resolution are unsupported.

Messaging rules are isolated by framework. The first release recognizes typed Confluent Kafka producers/consumers, RabbitMQ channels, MassTransit publish endpoints and consumers, NServiceBus sessions and handlers, and Azure Service Bus sender/receiver creation. Facts require a literal broker topic or stable message type. Dynamic topics are omitted instead of marked exact. The public broker enum has no Azure, MassTransit, or NServiceBus value, so those facts use `unknown` with a precise `framework`; no public kind or broker value is added.

## Entity Framework decision

EF entities are not database schemas in this release. `DbSet<T>`, `DbContext`, `[Key]`, table/column attributes, and navigation properties do not by themselves select a schema. An entity is emitted only if existing HTTP/DTO/serialization rules independently identify it. No database fact kind is added. Public semantic relations do not express a sufficiently precise EF mapping without inventing contract identities, so EF relations remain out of scope.

## Installation and activation

Install an unpacked package directory under either `<repository>/.logiclens/plugins/<name>/` or the user directory `~/.logiclens/plugins/<name>/`. It must contain `plugin.json`, `dist/`, `package.json`, and installed production dependencies. Project plugins are repository-scoped; user plugins are available for detection in every repository. A `.cs`, `.csproj`, `.sln`, `Directory.Build.props`, or `Directory.Packages.props` signal activates the plugin, while only `.cs` is parsed. Default configuration indexes `.cs` without a root `include` override.

Bare npm specifiers in `plugins.enabled` remain legacy compatibility only. Language plugins loaded that way are deliberately not registered because activation is detection-driven; do not use this mode for new C# installations.

Published package acceptance requires `plugin.json`, compiled `dist`, this README, `tree-sitter ^0.21.1`, `tree-sitter-c-sharp 0.23.1`, and an API-compatible `@logiclens/plugin-sdk`. The manifest and exported plugin target plugin API `0.1.0`.

If native grammar installation fails, use a supported Node ABI, remove the failed installation directory, reinstall with build tools available, and verify `tree-sitter` remains on `0.21.x`; `tree-sitter-c-sharp 0.23.5+` targets the incompatible `0.25.x` line. Grammar loading is lazy and retries after failure. Non-C# repositories never invoke it.

Unsupported semantics include MSBuild evaluation, conditional compilation, source-generator output ownership, overload resolution, arbitrary dependency-injection flow, runtime route/topic construction, serializer option execution, EF database mapping, and compiler-level nullability/flow analysis.
