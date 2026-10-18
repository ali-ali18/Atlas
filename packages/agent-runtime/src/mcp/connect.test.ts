import { describe, expect, it, vi } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { McpClientPool } from "./client-pool.js";
import { probeMcpServer } from "./connect.js";

function serverPool(onList?: () => Promise<never>): McpClientPool {
	return new McpClientPool(() => {
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const server = new Server(
			{ name: "probe-test", version: "1.0.0" },
			{ capabilities: { tools: {} } },
		);
		server.setRequestHandler(ListToolsRequestSchema, async () => {
			if (onList) return onList();
			return { tools: [{ name: "search", inputSchema: { type: "object" as const } }] };
		});
		void server.connect(serverTransport);
		return clientTransport;
	});
}

describe("probeMcpServer", () => {
	it("lista as tools e fecha o pool descartável", async () => {
		const pool = serverPool();
		const close = vi.spyOn(pool, "closeAll");
		const tools = await probeMcpServer({ url: "https://example.com/mcp", pool });
		expect(tools.map((tool) => tool.name)).toEqual(["search"]);
		expect(close).toHaveBeenCalledOnce();
	});

	it("converte 401 em erro de credencial sem ecoar token", async () => {
		const token = "segredo-da-chave-123";
		const pool = serverPool(async () => { throw new Error(`HTTP 401: ${token}`); });
		await expect(probeMcpServer({
			url: "https://example.com/mcp",
			headers: { Authorization: `Bearer ${token}` },
			pool,
		})).rejects.toThrow("credencial recusada pelo servidor");
	});

	it("redige chave na URL em falhas comuns", async () => {
		const token = "segredo-na-url-123";
		const pool = serverPool(async () => { throw new Error(`falhou: ${token}`); });
		await expect(probeMcpServer({
			url: `https://example.com/${token}/v2/mcp`,
			pool,
		})).rejects.toThrow("falhou: [redacted]");
	});
});
