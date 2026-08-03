import type { PluginManifest } from "@repohelix/plugin-sdk";

export const manifest = {
  name: "@repohelix/plugin-csharp",
  version: "2.0.0",
  pluginApiVersion: "2.0.0",
  capabilities: ["language", "fact-extractor", "framework-detector"],
  entry: "./dist/index.js",
  languages: [{
    id: "csharp",
    extensions: [".cs"],
    detect: {
      extensions: [".cs"],
      globs: [
        "**/*.csproj",
        "**/*.sln",
        "**/Directory.Build.props",
        "**/Directory.Packages.props"
      ]
    }
  }]
} satisfies PluginManifest;
