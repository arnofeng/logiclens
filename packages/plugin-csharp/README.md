# @repohelix/plugin-csharp

`@repohelix/plugin-csharp` is the official C# language plugin for [RepoHelix](https://github.com/arnofeng/repohelix). It extends the RepoHelix host with C# parsing, ASP.NET Core HTTP contract extraction, schema extraction, gRPC and messaging facts, package metadata, and framework detection.

> [!IMPORTANT]
> This package runs as a RepoHelix plugin and requires a compatible RepoHelix host environment. RepoHelix discovers the plugin, supplies repository context, runs its parser and extractors, and writes the resulting facts to the code graph.

## Recommended installation

Make sure the RepoHelix CLI is installed and the target repository has been added to a RepoHelix workspace. Then install the plugin for that repository:

```bash
repohelix plugin install @repohelix/plugin-csharp
```

Then index the repository to activate its C# capabilities:

```bash
repohelix index --repo <repo>
```

The plugin parses `.cs` files. `.csproj`, `.sln`, `Directory.Build.props`, and `Directory.Packages.props` files are used to detect C# projects and extract project metadata.

## Requirements

- Node.js 20.19.0 or later

The plugin performs syntax-based static analysis. It does not run the project or provide compiler-level C# analysis.

## ASP.NET Core HTTP facts

The plugin extracts ASP.NET Core controller routes, minimal API mappings, route groups, request and response types, and statically identifiable `HttpClient` calls. Dynamic routes or types that cannot be determined reliably are omitted.

## Schema facts

Schema declaration extraction supports records, classes, structs, common collection and dictionary types, nullable types, serialization attributes, required members, and partial declarations. Public `SchemaSpec` materialization is contract-driven and suffix-independent: the host follows provable typed roots through the shared deterministic adapter/core chain.

## gRPC and messaging facts

The plugin recognizes typed gRPC services and clients, including unary and streaming methods. It also detects statically identifiable producers and consumers for Confluent Kafka, RabbitMQ, MassTransit, NServiceBus, and Azure Service Bus. Dynamic destinations that cannot be determined reliably are omitted.

## Entity Framework decision

Entity Framework entities are not treated as database schemas. They are included only when they independently qualify as an HTTP or serialized DTO contract.

## Installation scopes

For the shared discovery rules, workspace/global scope, updates, removal, and troubleshooting, see the RepoHelix [Plugin Guide](https://github.com/arnofeng/repohelix/blob/main/docs/plugins.md). Plugin authors should also read the [Plugin SDK Reference](https://github.com/arnofeng/repohelix/blob/main/docs/plugin-sdk.md).

The default installation is scoped to the current RepoHelix workspace. Use `--global` to make the plugin available to all workspaces indexed by the current user.

If native grammar installation fails, use a supported Node ABI, remove the failed installation directory, reinstall with build tools available, and verify `tree-sitter` remains on `0.21.x`; `tree-sitter-c-sharp 0.23.5+` targets the incompatible `0.25.x` line.

Known limitations include MSBuild evaluation, conditional compilation, source-generator output, overload resolution, arbitrary dependency-injection flow, runtime-generated routes or topics, serializer option execution, Entity Framework database mapping, and compiler-level nullability or flow analysis.
