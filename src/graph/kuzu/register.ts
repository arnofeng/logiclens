import { registerGraphProvider } from "../factory.js";
import { KuzuGraphDB } from "./KuzuGraphDB.js";

registerGraphProvider("kuzu", {
  open: async (config) => KuzuGraphDB.open(config.path ?? ".logiclens/graph")
});
