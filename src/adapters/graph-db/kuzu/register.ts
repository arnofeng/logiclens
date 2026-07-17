import { registerGraphProvider } from "../../../core/graph-model/factory.js";
import { KuzuGraphDB } from "./KuzuGraphDB.js";
import { KuzuWorkspaceLexicalStore } from "./KuzuWorkspaceLexicalStore.js";
import { BRAND_PATHS } from "../../../shared/branding.js";

registerGraphProvider("kuzu", {
  factory: {
    open: async (config) => KuzuGraphDB.open(config.path ?? BRAND_PATHS.graph)
  },
  capabilities: {
    nativeFullText: {
      scope: "workspace",
      updateConsistency: "synchronous",
      supportsFieldBoost: false,
      supportsPrefix: false
    }
  },
  bindLexical: (db) => {
    if (!(db instanceof KuzuGraphDB)) {
      throw new TypeError("Kuzu lexical binder requires the current KuzuGraphDB instance");
    }
    return new KuzuWorkspaceLexicalStore(db);
  }
});
