import { BRAND, brandedMcpToolName } from '../../shared/branding.js';

export const LOGICLENS_SECTION_START = '<!-- LOGICLENS_START -->';
export const LOGICLENS_SECTION_END = '<!-- LOGICLENS_END -->';

export const LOGICLENS_INSTRUCTIONS_BLOCK = `${LOGICLENS_SECTION_START}
## ${BRAND.displayName}

In workspaces configured with ${BRAND.displayName} (a \`${BRAND.configDirName}/\` directory exists at the workspace root), reach for it BEFORE grep/find or reading files when you need to understand cross-repository dependencies, contract interfaces, trace workflows, or evaluate change impact:

- **MCP tools** (when available): \`${brandedMcpToolName("get_stats")}\` reports node and relation counts. \`${brandedMcpToolName("list_dependencies")}\` and \`${brandedMcpToolName("list_contracts")}\` summarize relations and endpoints. \`${brandedMcpToolName("trace")}\` maps producers/consumers of a contract. \`${brandedMcpToolName("impact_analysis")}\` evaluates the downstream blast radius. \`${brandedMcpToolName("ask_question")}\` answers natural-language questions from the graph. If tools are deferred, load them by name.
- **Shell** (always works): \`${BRAND.cliName} ask "<question>"\`, \`${BRAND.cliName} impact <symbolOrEntity>\`, and \`${BRAND.cliName} trace <contractOrEntity>\` print the same output.

If there is no \`${BRAND.configDirName}/\` directory, skip ${BRAND.displayName} entirely - initialization is the user's decision.
${LOGICLENS_SECTION_END}`;
