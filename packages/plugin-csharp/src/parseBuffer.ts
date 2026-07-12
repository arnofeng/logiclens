const MIN_PARSE_BUFFER_BYTES = 64 * 1024;
const MAX_PARSE_BUFFER_BYTES = 1024 * 1024;

export function csharpParseBufferSize(source: string): number {
  return Math.min(
    MAX_PARSE_BUFFER_BYTES,
    Math.max(MIN_PARSE_BUFFER_BYTES, source.length + 1)
  );
}
