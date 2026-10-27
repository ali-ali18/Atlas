import { describe, expect, it } from "vitest";
import { MCP_TASK_GRANT_MAX_LIFETIME_MS, MCP_TASK_GRANT_MAX_USES, hasExternalTargetArgs, isUntrustedContentTool, MCP_TASK_GRANT_TTL_MS, canGrantMcpTask, describeMcpTaskGrantUses, isMcpTaskGrantUsable, mcpTaskGrantExpiry } from "./mcp-task-grant.js";

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
	it("renovar nunca passa de createdAt + 2 h", () => {
		const created = new Date(now.getTime() - MCP_TASK_GRANT_MAX_LIFETIME_MS + 10 * 60_000);
		expect(mcpTaskGrantExpiry(now, created).getTime()).toBe(created.getTime() + MCP_TASK_GRANT_MAX_LIFETIME_MS);
		expect(mcpTaskGrantExpiry(now, now).getTime() - now.getTime()).toBe(MCP_TASK_GRANT_TTL_MS);
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

describe("contador no cartão persistido", () => {
	it("grantUses sobrevive ao parse e valores inválidos são descartados", async () => {
		const { parseConversationCard, serializeConversationCard } = await import("./skill-card.js");
		const card = { v: 1 as const, kind: "confirm" as const, confirmId: "c1", title: "Agenda: executar create_event?", status: "approved" as const, grantUses: 3 };
		expect(parseConversationCard(serializeConversationCard(card))).toMatchObject({ grantUses: 3 });
		for (const bad of [0, -1, 1.5, "3", 5000]) {
			expect(parseConversationCard(JSON.stringify({ ...card, grantUses: bad }))).not.toHaveProperty("grantUses");
		}
	});
});

describe("escrita com alvo externo", () => {
	it("convidado, destinatário, webhook e URL bloqueiam; vazio e texto comum passam", () => {
		expect(hasExternalTargetArgs({ summary: "Prova", attendees: [{ email: "x@evil.com" }] })).toBe(true);
		expect(hasExternalTargetArgs({ summary: "Prova", start: "2026-10-30T10:00", attendees: [] })).toBe(false);
		expect(hasExternalTargetArgs({ to: "a@b.com" })).toBe(true);
		expect(hasExternalTargetArgs({ Cc: ["a@b.com"] })).toBe(true);
		expect(hasExternalTargetArgs({ event: { guest_emails: ["a@b.com"] } })).toBe(true);
		expect(hasExternalTargetArgs({ webhook_url: "https://evil.test/h" })).toBe(true);
		expect(hasExternalTargetArgs({ items: [{ callbackUrl: "https://evil.test" }] })).toBe(true);
		expect(hasExternalTargetArgs({ sendUpdates: "all" })).toBe(true);
		expect(hasExternalTargetArgs({ sendUpdates: "none", title: "x", to: "" })).toBe(false);
		expect(hasExternalTargetArgs({ title: "Prova de Cálculo", start: "2026-10-30", notes: "levar calculadora" })).toBe(false);
		expect(hasExternalTargetArgs(null)).toBe(false);
	});
});

describe("conteúdo que o usuário não escreveu", () => {
	it("web, e-mail, arquivo, subagente e leitura de conector contam; escrita e memória não", () => {
		for (const name of ["web_search", "web_extract", "navigate", "screenshot", "browser_snapshot", "email_read", "attachment_read", "read_file", "delegate_task"]) {
			expect(isUntrustedContentTool(name), name).toBe(true);
		}
		expect(isUntrustedContentTool("mcp__cal__list_events", true)).toBe(true);
		expect(isUntrustedContentTool("mcp__cal__create_event", false)).toBe(false);
		for (const name of ["memory", "todo_write", "update_task_list", "email_send"]) expect(isUntrustedContentTool(name), name).toBe(false);
	});
});
