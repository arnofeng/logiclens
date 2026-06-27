/**
 * Generated File Detection
 *
 * Identifies auto-generated source files by path pattern (no file content read).
 * Used during indexing to skip or down-weight generated artifacts (protobuf stubs,
 * gRPC scaffolding, codegen output, mocks) so they don't pollute contract evidence.
 *
 * Rules:
 * - Pattern-only, O(1) per file — never reads file content.
 * - Hard-skip: file is omitted entirely from indexing.
 * - The set covers the most common code-generation tools encountered in polyglot repos.
 */

const GENERATED_PATTERNS: ReadonlyArray<RegExp> = [
  // ── Go ──────────────────────────────────────────────────────────────────────
  // protobuf / gRPC (protoc-gen-go)
  /\.pb\.go$/,
  /\.pulsar\.go$/,
  /_grpc\.pb\.go$/,
  // mockgen — default emits `mock_<src>.go`; projects rename to `*_mock(s).go`
  /_mock\.go$/,
  /_mocks\.go$/,
  /(?:^|\/)mock_[^/]+\.go$/,

  // ── Python ───────────────────────────────────────────────────────────────────
  // protobuf / gRPC (protoc-gen-python / grpcio-tools)
  /_pb2(?:_grpc)?\.py$/,
  /_pb2\.pyi$/,

  // ── Java ────────────────────────────────────────────────────────────────────
  // protoc-gen-java emits `*OuterClass.java`; protoc-gen-grpc-java emits `*Grpc.java`
  /OuterClass\.java$/,
  /Grpc\.java$/,

  // ── TypeScript / JavaScript ──────────────────────────────────────────────────
  // Apollo / GraphQL codegen, Prisma, Hasura, ts-proto, swagger-codegen, gRPC-web
  /\.generated\.[jt]sx?$/,
  /\.gen\.[jt]sx?$/,
  /\.pb\.[jt]s$/,
  /_pb\.[jt]s$/,
  /_grpc_pb\.[jt]s$/,
  // Minified bundles vendored into the repo (docs sites, examples)
  /\.min\.m?js$/,

  // ── C# ──────────────────────────────────────────────────────────────────────
  // protobuf / gRPC (protoc-gen-csharp)
  /\.g\.cs$/,
  /Grpc\.cs$/,

  // ── C / C++ ─────────────────────────────────────────────────────────────────
  // protobuf
  /\.pb\.(?:cc|h)$/,

  // ── Swift ────────────────────────────────────────────────────────────────────
  /\.pb\.swift$/,

  // ── Dart ─────────────────────────────────────────────────────────────────────
  // build_runner / freezed / json_serializable / chopper
  /\.g\.dart$/,
  /\.freezed\.dart$/,
  /\.pb\.dart$/,
  /\.pbgrpc\.dart$/,
  /\.chopper\.dart$/,

  // ── Rust ─────────────────────────────────────────────────────────────────────
  /\.generated\.rs$/,
];

/**
 * Returns true when `filePath` looks like a tool-generated source file based
 * solely on its filename/path. Path-only — never reads file content.
 *
 * Intended as a **hard-skip** signal during indexing: generated files are
 * excluded from the file list before parsing to avoid polluting contract
 * evidence with scaffolding noise.
 */
export function isGeneratedFile(filePath: string): boolean {
  // Normalise Windows separators so all patterns can use forward slashes
  const normalised = filePath.replace(/\\/g, "/");
  return GENERATED_PATTERNS.some((p) => p.test(normalised));
}
