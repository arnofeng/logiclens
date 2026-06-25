# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1-beta.12] - 2026-06-26

### Added

- `logiclens plugin add/remove/list` commands for managing plugins.
- Pluggable embeddings behind an `EmbeddingProvider` extension point.
- Guard against re-indexing: refuse a full re-index of an already-indexed repo.

### Changed

- Made the SDK config-agnostic — no disk writes; init/uninit/persistence moved to the CLI.
- Renamed `providers/openaiProvider` to `resilience/providerPolicy`.

### Fixed

- Prevent plugins from overriding system CLI commands.
- Install plugins into an isolated `.logiclens/plugins` store.

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

[Unreleased]: https://github.com/logiclens/logiclens/compare/v0.1.1-beta.11...HEAD
[0.1.1-beta.11]: https://github.com/logiclens/logiclens/compare/v0.1.1-beta.10...v0.1.1-beta.11
[0.1.1-beta.10]: https://github.com/logiclens/logiclens/compare/v0.1.1-beta.9...v0.1.1-beta.10
[0.1.1-beta.9]: https://github.com/logiclens/logiclens/compare/v0.1.1-beta.8...v0.1.1-beta.9
[0.1.1-beta.8]: https://github.com/logiclens/logiclens/releases/tag/v0.1.1-beta.8
