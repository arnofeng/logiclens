import { registerGraphProvider } from "../../../core/graph-model/factory.js";
import { KuzuGraphDB } from "./KuzuGraphDB.js";
import { BRAND_PATHS } from "../../../shared/branding.js";

registerGraphProvider("kuzu", {
  open: async (config) => KuzuGraphDB.open(config.path ?? BRAND_PATHS.graph)
});
