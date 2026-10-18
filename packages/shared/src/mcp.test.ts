import { describe, expect, it } from "vitest";
import {
	MCP_TOOL_NAME_MAX_CHARS,
	isMcpToolName,
	isReadOnlyMcpTool,
	mcpToolName,
	slugifyConnectorName,
} from "./mcp.js";

describe("slugifyConnectorName", () => {
	it("normaliza acentos, espaços e caixa", () => {
		expect(slugifyConnectorName("Google Drive")).toBe("google_drive");
		expect(slugifyConnectorName("Calendário Pessoal")).toBe("calendario_pessoal");
		expect(slugifyConnectorName("  !!  ")).toBe("mcp");
	});
});

describe("mcpToolName", () => {
	it("monta mcp__<slug>__<tool> sanitizado", () => {
		expect(mcpToolName("notion", "notion-search")).toBe("mcp__notion__notion-search");
		expect(mcpToolName("GitHub", "list issues")).toBe("mcp__github__list_issues");
		expect(isMcpToolName(mcpToolName("x", "y"))).toBe(true);
		expect(isMcpToolName("navigate")).toBe(false);
	});

	it("respeita 64 chars e não colide quando corta", () => {
		const a = mcpToolName("github", `${"a".repeat(80)}_one`);
		const b = mcpToolName("github", `${"a".repeat(80)}_two`);
		expect(a.length).toBeLessThanOrEqual(MCP_TOOL_NAME_MAX_CHARS);
		expect(b.length).toBeLessThanOrEqual(MCP_TOOL_NAME_MAX_CHARS);
		expect(a).not.toBe(b);
		expect(a).toMatch(/^[a-zA-Z0-9_-]+$/);
	});
});

describe("isReadOnlyMcpTool", () => {
	it("só readOnlyHint explícito conta como leitura", () => {
		expect(isReadOnlyMcpTool({ annotations: { readOnlyHint: true } })).toBe(true);
		expect(isReadOnlyMcpTool({})).toBe(false);
		expect(
			isReadOnlyMcpTool({ annotations: { readOnlyHint: true, destructiveHint: true } }),
		).toBe(false);
	});
});
