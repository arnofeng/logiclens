# Plugin Guide

RepoHelix plugins add language parsing, contract extraction, and framework detection. Installed plugins run during `index`, `watch`, SDK indexing, and indexing performed by MCP clients.

For plugin authoring and the complete TypeScript API, see the [Plugin SDK Reference](plugin-sdk.md).

## Install a Plugin

Use the plugin management CLI for npm packages, local directories, and npm package tarballs:

```bash
# Workspace scope (default)
repohelix plugin install @repohelix/plugin-csharp
repohelix plugin install ../my-plugin
repohelix plugin install ./my-plugin.tgz

# User scope
repohelix plugin install @repohelix/plugin-csharp --global
```

The default scope is the RepoHelix workspace containing `.repohelix/config.yaml`. Use `--global` to install for the current user instead. Use `--force` to atomically replace an existing plugin with the same manifest name.

RepoHelix installs the plugin and its production dependencies, then validates it before activation. Plugin installation may run npm lifecycle scripts, including native grammar builds, so install only plugins you trust.

Useful management commands:

```bash
repohelix plugin list --all
repohelix plugin list --json
repohelix plugin doctor --all
repohelix plugin remove @repohelix/plugin-csharp
```

`list` shows installed plugins and their status. `doctor` performs a full validation and exits non-zero when it finds an invalid or duplicate plugin; use it only with plugins you trust. `remove` requires confirmation unless `--yes` is supplied.

### Manual Installation Layout

A plugin installation is a directory containing `plugin.json` and a compiled JavaScript entry point. RepoHelix supports two recommended installation scopes:

| Scope | Directory | Availability |
|---|---|---|
| Workspace | `<workspace>/.repohelix/plugins/<plugin-name>/` | Repositories configured by this RepoHelix workspace |
| Global | `~/.repohelix/plugins/<plugin-name>/` | Every repository indexed by the current user |

For manual installation, copy or extract the complete published plugin directory into one of these locations, including `plugin.json`, `package.json`, compiled output, and production dependencies.

For a workspace installation:

```text
my-repohelix-workspace/
├── .repohelix/
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
mkdir -p ~/.repohelix/plugins/csharp
# Copy the complete plugin package into that directory.
```

On Windows, the equivalent global directory is `%USERPROFILE%\.repohelix\plugins\csharp`.

## Activation and Detection

When indexing starts, RepoHelix matches installed plugins to repositories using their declared file extensions, marker files, and globs. Matching plugins contribute their language parser, contract extractors, and framework detectors to the indexing run.

Workspace and global plugins are available for automatic detection in every configured repository. A language plugin activates only for repositories matching its declared extensions, markers, or detection globs.

Language detection automatically adds manifest extensions and detection globs to the scan, and an active plugin adds its source extensions to indexing. Normal `exclude` rules and `.gitignore` still apply.

Run an index to activate newly installed plugins:

```bash
repohelix index
repohelix frameworks
repohelix stats
```

The index log prints `Detected language plugins: ...`. Use `repohelix plugin list` to inspect installed plugins and `repohelix frameworks` to inspect detected frameworks.

## Configuration

Recommended language plugins use automatic discovery. `plugins.failFast` controls error handling:

```yaml
plugins:
  failFast: false
```

- `false` (default): warn and continue if a plugin cannot be discovered or loaded.
- `true`: abort the operation on the first plugin load error.

## Update or Remove a Plugin

Re-run `plugin install` with the desired source and `--force` to replace an installed plugin, then restart `watch` or the MCP process and run `repohelix index`. Keep `plugin.json`, the exported manifest, and compiled entry from the same release.

```bash
repohelix plugin install @repohelix/plugin-csharp --force
```

RepoHelix 1.x accepts Plugin API 1.x. Plugins that still declare `pluginApiVersion: 0.x` must update their SDK dependency and manifest before they can be loaded.

To remove a plugin, run `repohelix plugin remove <name>` with the same scope used for installation, stop or restart long-running RepoHelix processes, and re-index. Existing graph records are reconciled by normal indexing; use a clean full index when changing a parser or extractor substantially.

## Troubleshooting

| Symptom | Check |
|---|---|
| `Failed to discover RepoHelix plugin` | `plugin.json` is valid and its entry resolves to a real compiled file. |
| Plugin is discovered but not loaded | The repository contains a matching extension, marker, or detection glob and the file is not excluded. |
| API version error | The major version of `pluginApiVersion` matches the installed RepoHelix plugin SDK/runtime. |
| Manifest consistency error | The exported manifest and `plugin.json` have identical name, version, capabilities, language IDs, and extensions. |
| Plugin failure only emits a warning | Set `plugins.failFast: true` while diagnosing. |
| Watch does not pick up a new plugin | Restart `repohelix watch` or the MCP process after installation or replacement. |

## Included C# Plugin

The workspace contains `@repohelix/plugin-csharp` as the reference external language plugin. It detects `.cs` and common C# project files and extracts C# symbols, ASP.NET HTTP endpoints, schemas, events, gRPC methods, packages, and framework facts. See its [package README](../packages/plugin-csharp/README.md) for its exact coverage and packaging requirements.
