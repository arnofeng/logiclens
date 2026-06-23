import { registerGraphProvider } from "../factory.js";
import { KuzuGraphDB } from "../db.js";

registerGraphProvider("kuzu", {
  open: async (config) => KuzuGraphDB.open(config.path ?? ".logiclens/graph")
});
