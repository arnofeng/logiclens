import { defineLanguage, definePlugin } from "@logiclens/plugin-sdk";
import { manifest } from "./manifest.js";
import { parseCSharp } from "./parser.js";
import { csharpFrameworkDetector, csharpPackageExtractor } from "./projectFacts.js";
import { csharpHttpExtractor } from "./httpFacts.js";
import { csharpSchemaExtractor } from "./schemaFacts.js";

const csharpLanguage = defineLanguage({
  id: "csharp",
  extensions: [".cs"],
  parse: parseCSharp
});

export const plugin = definePlugin({
  manifest,
  languages: [csharpLanguage],
  factExtractors: [csharpPackageExtractor, csharpHttpExtractor, csharpSchemaExtractor],
  frameworkDetectors: [csharpFrameworkDetector]
});

export default plugin;
