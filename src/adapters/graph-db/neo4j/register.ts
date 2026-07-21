import { registerGraphProvider } from "../../../core/graph-model/factory.js";
import { Neo4jGraphDB } from "./Neo4jGraphDB.js";
import { Neo4jWorkspaceLexicalStore } from "./Neo4jWorkspaceLexicalStore.js";

registerGraphProvider("neo4j", {
  factory: {
    open: async (config) => {
      const url = config.url ?? "bolt://localhost:7687";
      const hasUsername = !!config.username;
      const hasPassword = !!config.password;
      if (hasUsername !== hasPassword) {
        throw new Error("Neo4j configuration requires both username and password, or neither (defaults to neo4j/neo4j).");
      }
      const credentials = hasUsername && hasPassword
        ? { username: config.username!, password: config.password!, database: config.database }
        : config.database
          ? { username: "neo4j", password: "neo4j", database: config.database }
          : undefined;
      return Neo4jGraphDB.open(url, credentials);
    }
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
    if (!(db instanceof Neo4jGraphDB)) {
      throw new TypeError("Neo4j lexical binder requires the current Neo4jGraphDB instance");
    }
    return new Neo4jWorkspaceLexicalStore(db);
  }
});
