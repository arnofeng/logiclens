# Deterministic contract-driven schema release

RepoHelix now discovers schemas from typed contract roots, not class-name suffixes. Language adapters index declarations and resolution context first; the shared bounded reachability engine then materializes only provable `SchemaSpec` instances and `REQUEST_SCHEMA`, `RESPONSE_SCHEMA`, `EVENT_PAYLOAD`, and `USES_SCHEMA` relations. Stable declaration/type-instance identities deduplicate a schema shared by multiple roots.

Built-in coverage includes TypeScript/JavaScript, Python, Go, Proto, GraphQL, and Java Spring MVC, Dubbo (annotation and XML), Spring/Kafka events, and gRPC generated-Java-to-Proto identity bridging. The plugin declaration/type-expression/shape contract supplies the same core path for C# and other language plugins. No schema YAML keys were added.

Full and changed-only indexing use the same materializer and atomic generation overlay. Public graph records, internal declaration/root/dependency/provenance/diagnostic facts, semantic relations, evidence links, and lexical documents become visible through one active generation. A source rename, package move, signature change, or removal reconciles affected roots; a shared `SchemaSpec` is collected only after its final contribution disappears.

`SchemaSpec` full-text documents use the stable schema spec ID as canonical ID and aggregate searchable shape/field data. Multiple roots do not create duplicate documents.

## Quality diagnostics

Run:

```bash
repohelix quality schemas --group-by framework
repohelix quality schemas --details unresolved,external,ambiguous,unsupported,truncated
repohelix quality schemas --group-by repo --details ambiguous,truncated --json
```

Diagnostics distinguish `unresolved`, known `external`, `ambiguous`, `unsupported`, and bounded-reachability `truncated` outcomes. Text details include owner/root/source IDs, raw symbol or type, field/type path, relation kind, candidate identities/evidence, and the applied depth/type limit. JSON keeps the same grouped summary and detail records for release review.

## Release gates and benchmark

`pnpm run test:contract-schema-release` runs the fixed offline correctness corpus as a Kuzu hard gate. The same corpus/ground truth/harness runs in the configurable Neo4j release job. `pnpm run scan:legacy-schema:artifacts` scans production output after `build:prod`.

`pnpm run benchmark:java-schema -- --fixture <path>` runs the independent trend benchmark. The checked-in manifest pins the Spring repository commit and archive SHA-256; `--archive <file>` verifies a prepared archive and `--download` explicitly downloads only that pinned archive. Normal runs use one warm-up and five samples with medians. `--smoke` is an offline one-sample timeout/OOM guard. Runtime/RSS changes are trend data, not a microperformance hard gate for ordinary pull requests, and the runner never updates its manifest or baseline.
