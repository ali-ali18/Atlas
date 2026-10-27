import { describe, expect, it } from "vitest";
import { MCP_TASK_GRANT_MAX_USES, MCP_TASK_GRANT_TTL_MS, canGrantMcpTask, describeMcpTaskGrantUses, isMcpTaskGrantUsable, mcpTaskGrantExpiry } from "./mcp-task-grant.js";

const now = new Date("2026-10-27T12:00:00Z");

describe("aprovação por tarefa", () => {
	it("só escrita reversível vira concessão", () => {
		expect(canGrantMcpTask("write")).toBe(true);
		expect(canGrantMcpTask("irreversible")).toBe(false);
		expect(canGrantMcpTask("read")).toBe(false);
		expect(canGrantMcpTask(undefined)).toBe(false);
	});
	it("vale por 30 minutos", () => {
		expect(mcpTaskGrantExpiry(now).getTime() - now.getTime()).toBe(MCP_TASK_GRANT_TTL_MS);
	});
	it("expira no tempo e no teto de usos", () => {
		const expiresAt = mcpTaskGrantExpiry(now);
		expect(isMcpTaskGrantUsable({ uses: 1, maxUses: MCP_TASK_GRANT_MAX_USES, expiresAt }, now)).toBe(true);
		expect(isMcpTaskGrantUsable({ uses: MCP_TASK_GRANT_MAX_USES, maxUses: MCP_TASK_GRANT_MAX_USES, expiresAt }, now)).toBe(false);
		expect(isMcpTaskGrantUsable({ uses: 1, maxUses: 30, expiresAt }, expiresAt)).toBe(false);
	});
	it("texto do contador", () => {
		expect(describeMcpTaskGrantUses(1)).toBe("executado 1 vez nesta tarefa");
		expect(describeMcpTaskGrantUses(3)).toBe("executado 3 vezes nesta tarefa");
	});
});
