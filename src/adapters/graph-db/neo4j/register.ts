import { registerGraphProvider } from "../../../graph/factory.js";
import { Neo4jGraphDB } from "./Neo4jGraphDB.js";

registerGraphProvider("neo4j", {
  open: async (config) => {
    const url = config.url ?? "bolt://localhost:7687";
    const hasUsername = !!config.username;
    const hasPassword = !!config.password;
    if (hasUsername !== hasPassword) {
      throw new Error("Neo4j configuration requires both username and password, or neither (defaults to neo4j/neo4j).");
    }
    const credentials = hasUsername && hasPassword
      ? { username: config.username!, password: config.password! }
      : undefined;
    return Neo4jGraphDB.open(url, credentials);
  }
});
