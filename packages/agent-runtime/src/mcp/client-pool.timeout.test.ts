import { describe, expect, it } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { McpClientPool, McpConnectTimeoutError, isRetryableMcpError, type McpClientConfig } from "./client-pool.js";
import { callMcpTool } from "./call.js";

const config: McpClientConfig = {
	id: "stuck",
	version: "v1",
	name: "Travado",
	url: "http://stuck.local/mcp",
	headers: { authorization: "Bearer segredo-123" },
};

/** Servidor que aceita a conexão e nunca responde ao `initialize` (handshake travado). */
function stuckThenHealthyPool(stuckConnects: number, timeoutMs = 40): { pool: McpClientPool; connects: () => number; closed: () => number } {
	let count = 0;
	let closedCount = 0;
	const pool = new McpClientPool(
		() => {
			count += 1;
			const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
			const originalClose = clientTransport.close.bind(clientTransport);
			clientTransport.close = async () => {
				closedCount += 1;
				await originalClose();
			};
			if (count > stuckConnects) {
				const server = new Server({ name: "ok", version: "1" }, { capabilities: { tools: {} } });
				server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
				void server.connect(serverTransport);
			}
			return clientTransport;
		},
		{ connectTimeoutMs: timeoutMs },
	);
	return { pool, connects: () => count, closed: () => closedCount };
}

describe("McpClientPool: timeout de conexão", () => {
	it("handshake travado falha no prazo com erro honesto, sem repetir na hora", async () => {
		// Os dois transportes (streamable-http e o fallback SSE) contam no mesmo prazo.
		const { pool, connects, closed } = stuckThenHealthyPool(Number.POSITIVE_INFINITY);
		const startedAt = Date.now();
		const error = await pool.withClient(config, async () => "nunca").catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(McpConnectTimeoutError);
		expect(isRetryableMcpError(error)).toBe(false);
		expect((error as Error).message).toContain("did not finish connecting");
		expect((error as Error).message).not.toContain("segredo-123");
		expect(Date.now() - startedAt).toBeLessThan(2_000);
		// Um só handshake (o withClient não reconecta num timeout) e o cliente aberto foi fechado.
		expect(connects()).toBe(1);
		expect(closed()).toBeGreaterThanOrEqual(1);
		await pool.closeAll();
	});

	it("timeout tira a entrada do pool: a próxima chamada conecta de novo", async () => {
		const { pool, connects } = stuckThenHealthyPool(1);
		await expect(pool.get(config)).rejects.toBeInstanceOf(McpConnectTimeoutError);
		const client = await pool.get(config);
		expect(client).toBeDefined();
		expect(connects()).toBe(2);
		// Agora fica em cache.
		await pool.get(config);
		expect(connects()).toBe(2);
		await pool.closeAll();
	});

	it("o sinal de abort encerra a espera do chamador antes do timeout", async () => {
		const { pool } = stuckThenHealthyPool(Number.POSITIVE_INFINITY, 1_500);
		const controller = new AbortController();
		const pending = pool.get(config, { signal: controller.signal });
		setTimeout(() => controller.abort(), 10);
		const startedAt = Date.now();
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
		expect(Date.now() - startedAt).toBeLessThan(1_000);
		// Sinal já abortado: nem espera.
		await expect(pool.get(config, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
		await pool.closeAll();
	});

	it("callMcpTool devolve ok:false com a mensagem do timeout (sem segredo)", async () => {
		const { pool } = stuckThenHealthyPool(Number.POSITIVE_INFINITY);
		const result = await callMcpTool({ pool, config, toolName: "search", args: {}, secrets: ["segredo-123"] });
		expect(result.ok).toBe(false);
		expect(result.text).toContain("did not finish connecting");
		expect(result.text).not.toContain("segredo-123");
		await pool.closeAll();
	});
});
