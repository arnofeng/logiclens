import path from "node:path";
import { runMcpServer } from "../mcp/server.js";

/**
 * CLI command action to launch the Model Context Protocol (MCP) server.
 * Note: Since MCP uses standard output (stdout) for communication, we should ensure
 * that any standard logging/debugging messages go to stderr to prevent corrupting
 * the JSON-RPC stream.
 */
export async function mcpCommand(pathArg?: string): Promise<void> {
  const cwd = pathArg ? path.resolve(pathArg) : process.cwd();
  await runMcpServer(cwd);
}
