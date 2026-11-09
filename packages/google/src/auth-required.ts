import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";

/** Sobrevive à serialização JSON-RPC dos servidores MCP embutidos. */
export const MCP_AUTH_REQUIRED_MARKER = "ATLAS_MCP_AUTH_REQUIRED";

export function mcpAuthRequired(message: string): UnauthorizedError {
	return new UnauthorizedError(`${MCP_AUTH_REQUIRED_MARKER}: ${message}`);
}
