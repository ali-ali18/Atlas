import { beforeEach, describe, expect, it, vi } from "vitest";
import { getStrictMcpConnection, loadEffectiveAutonomy } from "@workspace/db";
import { callMcpTool } from "./call.js";
import { executeConfirmedMcpCall } from "./runtime.js";

vi.mock("@workspace/db", async (importOriginal) => ({
	...(await importOriginal<typeof import("@workspace/db")>()),
	getStrictMcpConnection: vi.fn(),
	loadEffectiveAutonomy: vi.fn(),
}));
vi.mock("./call.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./call.js")>()),
	callMcpTool: vi.fn(),
}));

const call = { userId: "user-a", botId: "bot-a", connectionId: "conn-a", toolName: "link_child", exposedName: "mcp__tracker__link_child", args: { parent: "x", child_id: 269 } };
const record = {
	id: "conn-a", slug: "tracker", name: "Tracker", url: "https://example.com/mcp",
	catalogId: null, authType: "none", status: "connected", secretsEnc: null,
	disabledTools: [], tools: [{ name: "link_child", inputSchema: { type: "object", properties: { parent: { type: "string" }, child_id: { type: "integer", description: "ID is not the same as the number" } } }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } }],
	updatedAt: new Date(),
};

describe("dica de id interno no caminho de chamada MCP", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(getStrictMcpConnection).mockResolvedValue(record as never);
		vi.mocked(loadEffectiveAutonomy).mockResolvedValue({ policy: { level: "autonomous", exceptions: [] } } as never);
	});

	it("404 com *_id pequeno anexa a dica ao resultado, inclusive na ação confirmada", async () => {
		vi.mocked(callMcpTool).mockResolvedValue({ ok: false, text: "404 Not Found []", truncated: false });
		const result = await executeConfirmedMcpCall(call);
		expect(result.ok).toBe(false);
		expect(result.text).toContain("404 Not Found []");
		expect(result.text).toContain('The argument "child_id" expects an internal resource id');
	});

	it("falha que não é 404 fica sem dica", async () => {
		vi.mocked(callMcpTool).mockResolvedValue({ ok: false, text: "403 Forbidden", truncated: false });
		expect((await executeConfirmedMcpCall(call)).text).toBe("403 Forbidden");
	});
});
