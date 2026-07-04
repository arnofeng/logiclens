# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **Merged `trace` and `spec-trace` into a single `trace` command**: The old single-hop reference-level `trace` command (L4, `kind:value` input) has been removed. The multi-hop semantic `spec-trace` command (L7, natural-language input, SEMANTIC_REL traversal) is now the new `trace`. The MCP tool `logiclens_semantic_trace` has been merged into `logiclens_trace`.
- **Removed `TraceResult` type** from the SDK public API. Use the new `SemanticTraceGraph` return type from `client.trace()`.

## [0.1.1-beta.14] - 2026-07-01

### Added

- **gRPC contract analysis**: Added proto extraction, Go/Java/Python/JavaScript gRPC server and client extractors, streaming-kind detection, consumer-to-producer matching, and gRPC impact rules.
- **Dubbo contract analysis**: Added Dubbo contract specs, Java annotation and XML extraction, method relation resolution, and Dubbo impact rules.
- **GraphQL contract analysis**: Added GraphQL contract specs, SDL/input parsing, client document extraction, resolver matching, schema reference resolution, and GraphQL impact rules.
- **Semantic trace improvements**: Added clearer direct traces between matched target specs and better target handling for impact analysis.

### Changed

- Removed public raw graph-query interfaces from the CLI, SDK, and MCP server; structured graph tools and SDK methods are now the supported public access surface.
- Temporarily removed the plugin mechanism and related documentation.
- Moved SDK graph-query implementation details into the graph-model query layer and shared DB initialization path.

### Fixed

- Prefer exact HTTP method and path matches over lower-confidence path-only matches.
- Reject HTTP semantic matches when producer and consumer methods conflict across static, template, or wildcard paths.
- Improve contract extraction for JavaScript/TypeScript symbols, template-string URL constants, TypeScript interfaces, and enums.
- Improve semantic trace evidence by using repo-qualified call edges and avoiding cross-repo evidence leakage.
- Preserve MCP installer migration behavior for legacy server and toolset keys.

## [0.1.1-beta.13] - 2026-06-28

### Added

- **Contract semantic layer**: Multi-phase semanticization pipeline that materializes contract specs from raw code analysis:
  - Phase 0: Contract Spec data layer with API-key method-level upgrade.
  - Phase 1: HTTP API semanticization — extract endpoints, methods, and parameters.
  - Phase 2: Extended HTTP method extraction to Python and Go parsers.
  - Phase 3: Event semanticization for message/event-driven contracts.
  - Phase 4: Dual-track semantic resolver (Phase 4.1) with rule-based SEMANTIC_REL → DEPENDS_ON materialization (Phase 4.2).
  - Language-specific schema extractors with cross-language type normalization.
  - `USES_SCHEMA` edges for Go embedded structs and Python inheritance.
- **Phase 5 Impact Analysis**: Full impact analysis with multi-hop semantic tracing.
- **`spec-trace` command**: Trace contract specs across multiple semantic hops.
- **Neo4j UNWIND batch writer**: Faster bulk writes for Neo4j graph provider.
- **Post-indexing semantic rebuild**: Cross-repo SEMANTIC_REL resolution is now deferred to a post-indexing rebuild phase for better consistency.

### Changed

- **Documentation repositioning**: Repositioned as a cross-repo contract graph that reasons about change impact.
- **Project restructure**: Reorganized source tree into `src/core/`, `src/features/`, `src/adapters/`, `src/interfaces/`, and `src/shared/` layers.
- Extracted indexing engine out of commands into a dedicated `indexing/` module.
- Moved graph DB and embedding providers into `src/adapters/`.

### Fixed

- Materialize `ContractSpec` semantic layer across all bulk writer modes.
- Produce `HttpEndpointSpec` ContractSpec nodes in HTTP extractors (was missing).
- Reject HTTP contract matches when HTTP methods differ; fix dedup key collision.
- Add missing `fileId`/`evidenceId` fields in test specs; fix `SchemaFieldSpec` optional type.
- Cap Kuzu `maxDBSize` to 128 GiB to avoid mmap failure in CI.

## [0.1.1-beta.12] - 2026-06-26

### Added

- Guard against re-indexing: refuse a full re-index of an already-indexed repo.

### Changed

- Made the SDK config-agnostic — no disk writes; init/uninit/persistence moved to the CLI.
- Renamed `providers/openaiProvider` to `resilience/providerPolicy`.

## [0.1.1-beta.11] - 2026-06-24

### Added

- Complete CLI command reference documentation.
- English README (`README.md`) alongside the Chinese version (`README-ZH.md`).

### Changed

- Consolidated and restructured the README files; trimmed the configuration guide.

### Fixed

- Aligned `importPackageExtractor` and `javaPackageExtractor` tests with updated type definitions.

## [0.1.1-beta.10] - 2026-06-24

### Added

- Neo4j graph provider.
- Graph provider factory (`createGraphDB`) and migration of consumers onto it.

### Changed

- Migrated 6 high-value queries into the `GraphDB` interface.
- Replaced `KuzuValue` with `GraphValue` in the `GraphDB` interface.
- Split Java import-to-package extraction into a dedicated `importPackageExtractor`.
- Renamed "multi-repository" to "cross-repository" throughout.

### Fixed

- Prevent double cleanup and handle stdin EOF for graceful MCP shutdown.
- Avoid segfault on multi-source rel-table DELETE-then-COPY.
- Add a languages filter and guard non-Java files in Java package extraction.
- Improve session atomicity and query safety in the graph layer.

## [0.1.1-beta.9] - 2026-06-23

### Fixed

- Pinned `tree-sitter-python` to exact version 0.23.4 and refreshed the lockfile.

## [0.1.1-beta.8] - 2026-06-23

- Initial tagged beta release.

[Unreleased]: https://github.com/logiclens/logiclens/compare/v0.1.1-beta.14...HEAD
[0.1.1-beta.14]: https://github.com/logiclens/logiclens/compare/v0.1.1-beta.13...v0.1.1-beta.14
[0.1.1-beta.13]: https://github.com/logiclens/logiclens/compare/v0.1.1-beta.12...v0.1.1-beta.13
[0.1.1-beta.12]: https://github.com/logiclens/logiclens/compare/v0.1.1-beta.11...v0.1.1-beta.12
[0.1.1-beta.11]: https://github.com/logiclens/logiclens/compare/v0.1.1-beta.10...v0.1.1-beta.11
[0.1.1-beta.10]: https://github.com/logiclens/logiclens/compare/v0.1.1-beta.9...v0.1.1-beta.10
[0.1.1-beta.9]: https://github.com/logiclens/logiclens/compare/v0.1.1-beta.8...v0.1.1-beta.9
[0.1.1-beta.8]: https://github.com/logiclens/logiclens/releases/tag/v0.1.1-beta.8
