export default {
  name: "logiclens-example-proto-parser",
  version: "0.1.0",
  pluginApiVersion: "1",
  setup(context) {
    context.registerParser({
      name: "example-proto-parser",
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
  }
};
