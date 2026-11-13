// Mcp falso para teste (sem rede, sem cofre). Exportado pelo pacote para o worker e os evals.
import type { Mcp, McpCallResult, McpConnectionSnapshot } from "../ports/mcp.js";

export class FakeMcp implements Mcp {
	readonly calls: Array<{ userId: string; connectionId: string; toolName: string; args: Record<string, unknown> }> = [];
	readonly listed: string[] = [];
	constructor(
		private readonly connections: readonly McpConnectionSnapshot[],
		private readonly respond: (toolName: string, args: Record<string, unknown>) => McpCallResult = (toolName) => ({ ok: true, text: `fake result of ${toolName}` }),
	) {}

	async listConnections(userId: string): Promise<readonly McpConnectionSnapshot[]> {
		this.listed.push(userId);
		return this.connections.filter((c) => c.ownerId === userId);
	}

	async call(userId: string, connectionId: string, toolName: string, args: Record<string, unknown>): Promise<McpCallResult> {
		this.calls.push({ userId, connectionId, toolName, args });
		const connection = this.connections.find((c) => c.id === connectionId && c.ownerId === userId);
		if (!connection) return { ok: false, error: "Connection not found." };
		return this.respond(toolName, args);
	}
}
