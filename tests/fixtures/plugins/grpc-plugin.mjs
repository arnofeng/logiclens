function normalizeName(input) {
  return input.trim().replace(/\\/g, "/").replace(/[^a-zA-Z0-9_.:-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
}

export default {
  name: "grpc-fixture-plugin",
  version: "1.0.0",
  pluginApiVersion: "1",
  setup(context) {
    context.registerParser({
      name: "grpc-fixture-parser",
      language: "proto",
      extensions: [".proto"],
      parse(input) {
        return {
          repoId: input.repoId,
          fileId: input.fileId,
          path: input.relativePath,
          language: "proto",
          hash: input.hash,
          loc: input.source.split(/\r?\n/).length,
          imports: [],
          symbols: [],
          calls: []
        };
      }
    });
    void normalizeName;
  }
};
