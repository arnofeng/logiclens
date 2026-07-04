import { BRAND, brandedInstallerSectionMarkers, brandedMcpToolName } from '../../shared/branding.js';

const sectionMarkers = brandedInstallerSectionMarkers();

export const BRANDED_SECTION_START = sectionMarkers.start;
export const BRANDED_SECTION_END = sectionMarkers.end;

export const BRANDED_INSTRUCTIONS_BLOCK = `${BRANDED_SECTION_START}
## ${BRAND.displayName}

In workspaces configured with ${BRAND.displayName} (a \`${BRAND.configDirName}/\` directory exists at the workspace root), reach for it BEFORE grep/find or reading files when you need to understand cross-repository dependencies, contract interfaces, trace workflows, or evaluate change impact:

- **MCP tools** (when available): \`${brandedMcpToolName("get_stats")}\` reports node and relation counts. \`${brandedMcpToolName("list_dependencies")}\` and \`${brandedMcpToolName("list_contracts")}\` summarize relations and endpoints. \`${brandedMcpToolName("trace")}\` traces multi-hop semantic contract connections (schemas, consumers, events). \`${brandedMcpToolName("impact_analysis")}\` evaluates the downstream blast radius. \`${brandedMcpToolName("ask_question")}\` answers natural-language questions from the graph. If tools are deferred, load them by name.
- **Shell** (always works): \`${BRAND.cliName} ask "<question>"\`, \`${BRAND.cliName} impact <symbolOrEntity>\`, and \`${BRAND.cliName} trace "<contract>"\` (e.g. \`${BRAND.cliName} trace "http POST /orders"\`, \`${BRAND.cliName} trace "event OrderCreated"\`) print the same output.

If there is no \`${BRAND.configDirName}/\` directory, skip ${BRAND.displayName} entirely - initialization is the user's decision.
${BRANDED_SECTION_END}`;
