import { describe, expect, it } from "vitest";
import { connectedItems, resolveIconUri } from "./apps";
import { customMcpIcon, parseMcpConnections } from "./apps-parse";

// Regra do web: apps/web/components/ai-elements/connectors/custom-mcp-icon.tsx (customMcpHost + customMcpIconPath).
describe("logo do conector que o usuário adicionou", () => {
	it("o host da url vira /v1/mcp/icon/<host>", () => {
		expect(customMcpIcon("https://MCP.Exemplo.com.br/sse?x=1")).toBe("/v1/mcp/icon/mcp.exemplo.com.br");
		expect(customMcpIcon("http://api.exemplo.com/mcp")).toBe("/v1/mcp/icon/api.exemplo.com");
	});

	it("sem url válida, host sem ponto, IP ou esquema estranho cai no fallback (inicial)", () => {
		for (const url of ["", "não é url", "ftp://a.com/x", "javascript:alert(1)", "http://localhost:3000", "http://[::1]/x", "https://exemplo_.com"]) {
			expect(customMcpIcon(url)).toBeNull();
		}
	});

	it("parseMcpConnections lê a url da conexão e deriva o icon", () => {
		const [custom, sem] = parseMcpConnections({
			connections: [
				{ id: "1", catalogId: null, name: "Meu", status: "connected", url: "https://mcp.foo.dev/x" },
				{ id: "2", name: "Sem url", status: "connected" },
			],
		})!;
		expect(custom!.icon).toBe("/v1/mcp/icon/mcp.foo.dev");
		expect(sem!.icon).toBeNull();
	});

	it("connectedItems usa o logo da conexão e cai em null sem ele; o caminho resolve no servidor salvo", () => {
		const mk = (id: string, icon: string | null) => ({ id, catalogId: null, name: id, authType: "oauth", status: "connected" as const, accountLabel: "", icon });
		const items = connectedItems({ entries: [], connections: [mk("a", "/v1/mcp/icon/mcp.foo.dev"), mk("b", null)], composioConnections: [] });
		expect(items.map((item) => item.icon)).toEqual(["/v1/mcp/icon/mcp.foo.dev", null]);
		expect(resolveIconUri("/v1/mcp/icon/mcp.foo.dev", "https://atlas.example")).toBe("https://atlas.example/v1/mcp/icon/mcp.foo.dev");
		expect(resolveIconUri("/v1/mcp/icon/mcp.foo.dev", null)).toBeNull();
	});
});
