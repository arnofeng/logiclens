import { defineLanguage, definePlugin } from "@logiclens/plugin-sdk";
import { manifest } from "./manifest.js";
import { parseCSharp } from "./parser.js";

const csharpLanguage = defineLanguage({
  id: "csharp",
  extensions: [".cs"],
  parse: parseCSharp
});

export const plugin = definePlugin({
  manifest,
  languages: [csharpLanguage],
  factExtractors: [],
  frameworkDetectors: []
});

export default plugin;
