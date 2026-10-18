import { describe, expect, it } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { callMcpTool } from "./call.js";
import { McpClientPool, type McpClientConfig } from "./client-pool.js";
import { buildClipHint } from "../execution/pagination.js";

const big = JSON.stringify({ data: Array.from({ length: 300 }, (_, i) => ({ id: i, name: `item-${i}` })) });

function poolReplying(text: string): McpClientPool {
	const server = new Server({ name: "fake", version: "1.0.0" }, { capabilities: { tools: {} } });
	server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
	server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: "text" as const, text }] }));
	return new McpClientPool(() => {
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		void server.connect(serverTransport);
		return clientTransport;
	});
}

const config: McpClientConfig = { id: "c1", version: "v1", name: "Fake", url: "http://fake.local/mcp" };
const schema = { type: "object", properties: { page: { type: "integer" }, limit: { type: "integer" } } };

describe("callMcpTool com clipHint", () => {
	it("o corte nomeia o parâmetro de página e o próximo valor", async () => {
		const result = await callMcpTool({
			pool: poolReplying(big),
			config,
			toolName: "list_items",
			args: { page: 1 },
			maxChars: 400,
			readOnly: true,
			clipHint: (text) => ({ shownItems }) => buildClipHint({ schema, args: { page: 1 }, shownItems, text }),
		});
		expect(result.truncated).toBe(true);
		expect(result.text).toContain("page=2");
		expect(result.text).toContain("of 300 items");
	});

	it("sem clipHint o aviso é o de sempre", async () => {
		const result = await callMcpTool({ pool: poolReplying(big), config, toolName: "t", args: {}, maxChars: 400, readOnly: true });
		expect(result.truncated).toBe(true);
		expect(result.text).not.toContain("page=");
	});
});
