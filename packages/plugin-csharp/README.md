# @logiclens/plugin-csharp

`@logiclens/plugin-csharp` is the official C# language plugin for [LogicLens](https://github.com/arnofeng/logiclens). It extends the LogicLens host with C# parsing, ASP.NET Core HTTP contract extraction, schema extraction, gRPC and messaging facts, package metadata, and framework detection.

> [!IMPORTANT]
> This package runs as a LogicLens plugin and requires a compatible LogicLens host environment. LogicLens discovers the plugin, supplies repository context, runs its parser and extractors, and writes the resulting facts to the code graph.

## Recommended installation

Make sure the LogicLens CLI is installed and the target repository has been added to a LogicLens workspace. Then install the plugin for that repository:

```bash
logiclens plugin install @logiclens/plugin-csharp
```

Then index the repository to activate its C# capabilities:

```bash
logiclens index --repo <repo>
```

The plugin parses `.cs` files. `.csproj`, `.sln`, `Directory.Build.props`, and `Directory.Packages.props` files are used to detect C# projects and extract project metadata.

## Compatibility

- LogicLens 1.x
- Node.js 20.19.0 or later

The plugin performs syntax-based static analysis. It does not run the project or provide compiler-level C# analysis.

## ASP.NET Core HTTP facts

The plugin extracts ASP.NET Core controller routes, minimal API mappings, route groups, request and response types, and statically identifiable `HttpClient` calls. Dynamic routes or types that cannot be determined reliably are omitted.

## Schema facts

Schema extraction supports records, classes, structs, common collection and dictionary types, nullable types, serialization attributes, required members, and partial declarations. It focuses on DTOs and types referenced by public contracts; ordinary domain classes are not treated as schemas automatically.

## gRPC and messaging facts

The plugin recognizes typed gRPC services and clients, including unary and streaming methods. It also detects statically identifiable producers and consumers for Confluent Kafka, RabbitMQ, MassTransit, NServiceBus, and Azure Service Bus. Dynamic destinations that cannot be determined reliably are omitted.

## Entity Framework decision

Entity Framework entities are not treated as database schemas. They are included only when they independently qualify as an HTTP or serialized DTO contract.

## Installation scopes

For the shared discovery rules, workspace/global scope, updates, removal, and troubleshooting, see the LogicLens [Plugin Guide](https://github.com/arnofeng/logiclens/blob/main/docs/plugins.md). Plugin authors should also read the [Plugin SDK Reference](https://github.com/arnofeng/logiclens/blob/main/docs/plugin-sdk.md).

The default installation is scoped to the current LogicLens workspace. Use `--global` to make the plugin available to all workspaces indexed by the current user.

This release targets Plugin API `1.0.0`; Plugin API 0.x is not compatible with LogicLens 1.x.

If native grammar installation fails, use a supported Node ABI, remove the failed installation directory, reinstall with build tools available, and verify `tree-sitter` remains on `0.21.x`; `tree-sitter-c-sharp 0.23.5+` targets the incompatible `0.25.x` line.

Known limitations include MSBuild evaluation, conditional compilation, source-generator output, overload resolution, arbitrary dependency-injection flow, runtime-generated routes or topics, serializer option execution, Entity Framework database mapping, and compiler-level nullability or flow analysis.
