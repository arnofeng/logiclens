# Plugin Guide

LogicLens plugins add language parsing, contract extraction, and framework detection. Installed plugins run during `index`, `watch`, SDK indexing, and indexing performed by MCP clients.

For plugin authoring and the complete TypeScript API, see the [Plugin SDK Reference](plugin-sdk.md).

## Install a Plugin

Use the plugin management CLI for npm packages, local directories, and npm package tarballs:

```bash
# Project scope
logiclens plugin install @logiclens/plugin-csharp --repo service-a
logiclens plugin install ../my-plugin --repo service-a
logiclens plugin install ./my-plugin.tgz --repo service-a

# User scope
logiclens plugin install @logiclens/plugin-csharp --global
```

If the workspace has one configured repository, or the current directory is a configured repository, `--repo` may be omitted. In a multi-repository workspace where the target cannot be inferred, LogicLens requires `--repo <name>` or `--global`. Use `--force` to atomically replace an existing plugin with the same manifest name.

LogicLens installs the plugin and its production dependencies, then validates it before activation. Plugin installation may run npm lifecycle scripts, including native grammar builds, so install only plugins you trust.

Useful management commands:

```bash
logiclens plugin list --all
logiclens plugin list --repo service-a --json
logiclens plugin doctor --all
logiclens plugin remove @logiclens/plugin-csharp --repo service-a
```

`list` shows installed plugins and their status. `doctor` performs a full validation and exits non-zero when it finds an invalid or duplicate plugin; use it only with plugins you trust. `remove` requires confirmation unless `--yes` is supplied.

### Manual Installation Layout

A plugin installation is a directory containing `plugin.json` and a compiled JavaScript entry point. LogicLens supports two recommended installation scopes:

| Scope | Directory | Availability |
|---|---|---|
| Project | `<repository>/.logiclens/plugins/<plugin-name>/` | Only the repository that contains the plugin |
| Global | `~/.logiclens/plugins/<plugin-name>/` | Every repository indexed by the current user |

For manual installation, copy or extract the complete published plugin directory into one of these locations, including `plugin.json`, `package.json`, compiled output, and production dependencies.

For a project-local installation:

```text
my-service/
├── .logiclens/
│   └── plugins/
│       └── csharp/
│           ├── plugin.json
│           ├── package.json
│           ├── dist/
│           └── node_modules/       # when dependencies are not bundled
└── src/
```

For a global installation on macOS/Linux:

```bash
mkdir -p ~/.logiclens/plugins/csharp
# Copy the complete plugin package into that directory.
```

On Windows, the equivalent global directory is `%USERPROFILE%\.logiclens\plugins\csharp`.

## Activation and Detection

When indexing starts, LogicLens matches installed plugins to repositories using their declared file extensions, marker files, and globs. Matching plugins contribute their language parser, contract extractors, and framework detectors to the indexing run.

A project plugin applies to its selected repository. A global plugin is available to every configured repository.

Language detection automatically adds manifest extensions and detection globs to the scan, and an active plugin adds its source extensions to indexing. Normal `exclude` rules and `.gitignore` still apply.

Run an index to activate newly installed plugins:

```bash
logiclens index
logiclens frameworks
logiclens stats
```

The index log prints `Detected language plugins: ...`. Use `logiclens plugin list` to inspect installed plugins and `logiclens frameworks` to inspect detected frameworks.

## Configuration

Recommended language plugins use automatic discovery. `plugins.failFast` controls error handling:

```yaml
plugins:
  failFast: false
```

- `false` (default): warn and continue if a plugin cannot be discovered or loaded.
- `true`: abort the operation on the first plugin load error.

## Update or Remove a Plugin

Re-run `plugin install` with the desired source and `--force` to replace an installed plugin, then restart `watch` or the MCP process and run `logiclens index`. Keep `plugin.json`, the exported manifest, and compiled entry from the same release.

To remove a plugin, run `logiclens plugin remove <name>` with the same scope used for installation, stop or restart long-running LogicLens processes, and re-index. Existing graph records are reconciled by normal indexing; use a clean full index when changing a parser or extractor substantially.

## Troubleshooting

| Symptom | Check |
|---|---|
| `Failed to discover LogicLens plugin` | `plugin.json` is valid and its entry resolves to a real compiled file. |
| Plugin is discovered but not loaded | The repository contains a matching extension, marker, or detection glob and the file is not excluded. |
| API version error | The major version of `logiclensPluginApiVersion` matches the installed LogicLens plugin SDK/runtime. |
| Manifest consistency error | The exported manifest and `plugin.json` have identical name, version, capabilities, language IDs, and extensions. |
| Plugin failure only emits a warning | Set `plugins.failFast: true` while diagnosing. |
| Watch does not pick up a new plugin | Restart `logiclens watch` or the MCP process after installation or replacement. |

## Included C# Plugin

The workspace contains `@logiclens/plugin-csharp` as the reference external language plugin. It detects `.cs` and common C# project files and extracts C# symbols, ASP.NET HTTP endpoints, schemas, events, gRPC methods, packages, and framework facts. See its [package README](../packages/plugin-csharp/README.md) for its exact coverage and packaging requirements.
