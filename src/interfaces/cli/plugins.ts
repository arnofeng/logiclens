import { loadConfig } from "../../config/loadConfig.js";
import { loadConfiguredPlugins } from "../../core/plugins/loader.js";
import { parserRegistry } from "../../core/plugins/registry.js";

export async function pluginsCommand(cwd = process.cwd()): Promise<void> {
  const config = await loadConfig(cwd);
  const result = await loadConfiguredPlugins({ cwd, config });
  console.log(`Configured plugins: ${config.plugins.length}`);
  for (const plugin of result.loaded) {
    console.log(`- ${plugin.name}@${plugin.version} ${plugin.resolvedPath} setup=${plugin.setupMs}ms`);
  }
  console.log(`Parsers: ${parserRegistry.parsers().map((parser) => parser.name).sort().join(", ") || "(none)"}`);
}
