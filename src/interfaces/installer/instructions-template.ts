export const LOGICLENS_SECTION_START = '<!-- LOGICLENS_START -->';
export const LOGICLENS_SECTION_END = '<!-- LOGICLENS_END -->';

export const LOGICLENS_INSTRUCTIONS_BLOCK = `${LOGICLENS_SECTION_START}
## LogicLens

In workspaces configured with LogicLens (a \`.logiclens/\` directory exists at the workspace root), reach for it BEFORE grep/find or reading files when you need to understand cross-repository dependencies, contract interfaces, trace workflows, or evaluate change impact:

- **MCP tools** (when available): \`logiclens_get_stats\` reports node and relation counts. \`logiclens_list_dependencies\` and \`logiclens_list_contracts\` summarize relations and endpoints. \`logiclens_trace\` maps producers/consumers of a contract. \`logiclens_impact_analysis\` evaluates the downstream blast radius. \`logiclens_ask_question\` answers natural-language questions from the graph. If tools are deferred, load them by name.
- **Shell** (always works): \`logiclens ask "<question>"\`, \`logiclens impact <symbolOrEntity>\`, and \`logiclens trace <contractOrEntity>\` print the same output.

If there is no \`.logiclens/\` directory, skip LogicLens entirely — initialization is the user's decision.
${LOGICLENS_SECTION_END}`;
