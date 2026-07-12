#!/usr/bin/env sh

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
WORKSPACE_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
PLUGIN_DIR="$WORKSPACE_ROOT/packages/plugin-csharp"
SDK_DIR="$WORKSPACE_ROOT/packages/plugin-sdk"
RUN_INDEX=false

if [ "${1:-}" = "--index" ]; then
  RUN_INDEX=true
elif [ "$#" -gt 0 ]; then
  echo "Usage: $0 [--index]" >&2
  exit 2
fi

if [ ! -d "$PLUGIN_DIR" ]; then
  echo "C# plugin directory does not exist: $PLUGIN_DIR" >&2
  exit 1
fi

TEMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/logiclens-csharp-dev.XXXXXX")
STAGING_DIR="$TEMP_DIR/plugin-csharp"

cleanup() {
  rm -rf -- "$TEMP_DIR"
}
trap cleanup EXIT HUP INT TERM

cd "$WORKSPACE_ROOT"

echo "Building the plugin SDK and C# plugin..."
pnpm --filter '@logiclens/plugin-sdk' build
pnpm --filter '@logiclens/plugin-csharp' build

echo "Preparing a local development package..."
mkdir -p "$STAGING_DIR"
cp -R "$PLUGIN_DIR/dist" "$STAGING_DIR/dist"
cp "$PLUGIN_DIR/plugin.json" "$PLUGIN_DIR/package.json" "$PLUGIN_DIR/README.md" "$STAGING_DIR/"
if [ -f "$WORKSPACE_ROOT/LICENSE" ]; then
  cp "$WORKSPACE_ROOT/LICENSE" "$STAGING_DIR/LICENSE"
fi

node --input-type=module - "$STAGING_DIR/package.json" "$SDK_DIR" <<'NODE'
import fs from "node:fs";

const packageJsonPath = process.argv[2];
const sdkDirectory = process.argv[3].replace(/\\/g, "/");
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
packageJson.dependencies["@logiclens/plugin-sdk"] = `file:${sdkDirectory}`;
fs.writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
NODE

echo "Installing the local development package into the current LogicLens workspace..."
npm run dev -- plugin install "$STAGING_DIR" --force

if [ "$RUN_INDEX" = true ]; then
  echo "Indexing configured repositories..."
  npm run dev -- index
else
  echo "Plugin installed. Run 'npm run dev -- index' when you are ready to re-index."
fi
