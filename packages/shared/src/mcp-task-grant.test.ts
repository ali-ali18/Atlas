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
	it("verbo que atinge terceiros (reply, invite, share) não vira concessão mesmo classificado como write", () => {
		expect(canGrantMcpTask("write", "create_event")).toBe(true);
		expect(canGrantMcpTask("write", "GMAIL_REPLY_TO_THREAD")).toBe(false);
		expect(canGrantMcpTask("write", "calendar_invite_guest")).toBe(false);
		expect(canGrantMcpTask("write", "share-document")).toBe(false);
		expect(canGrantMcpTask("write", "forwardMessage")).toBe(false);
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
	it("chaves comuns de destinatário e sufixos address/addresses bloqueiam", () => {
		for (const key of ["participants", "members", "collaborators", "reviewers", "shareWith", "permissions", "mailing_address", "ccAddresses"]) {
			expect(hasExternalTargetArgs({ title: "x", [key]: ["alguem"] }), key).toBe(true);
			expect(hasExternalTargetArgs({ title: "x", [key]: [] }), `${key} vazio`).toBe(false);
		}
	});
	it("e-mail ou URL em qualquer valor, em qualquer profundidade, bloqueia mesmo com chave desconhecida", () => {
		// Composio calendar: convidados como objetos aninhados e chaves imprevisíveis.
		expect(hasExternalTargetArgs({ calendar_id: "primary", event: { people: [{ who: "a@evil.com", optional: false }] } })).toBe(true);
		expect(hasExternalTargetArgs({ body: { data: { nested: ["ok", { x: "Fulano <f@evil.com>" }] } } })).toBe(true);
		expect(hasExternalTargetArgs({ who: "a@b.com, c@d.org" })).toBe(true);
		expect(hasExternalTargetArgs({ meeting: { link: "https://meet.example.com/abc" } })).toBe(true);
		expect(hasExternalTargetArgs({ ref: "www.evil.test/x" })).toBe(true);
		expect(hasExternalTargetArgs(["a@b.com"])).toBe(true);
	});
	it("create_event típico de data de prova, sem convidados nem links, continua passando", () => {
		expect(hasExternalTargetArgs({
			calendar_id: "primary",
			summary: "Prova de Cálculo II",
			description: "Levar calculadora e documento. Conteúdo: integrais (cap. 5 e 6). Falar com prof@escola.com se precisar.",
			start: { dateTime: "2026-11-03T10:00:00-03:00", timeZone: "America/Sao_Paulo" },
			end: { dateTime: "2026-11-03T12:00:00-03:00", timeZone: "America/Sao_Paulo" },
			location: "Sala 204, Bloco B",
			reminders: { useDefault: true },
			attendees: [],
			sendUpdates: "none",
		})).toBe(false);
	});
});

describe("conteúdo que o usuário não escreveu", () => {
	it("web, e-mail, arquivo, subagente, busca, CI, GitHub, memória e todo conector contam", () => {
		const names = [
			"web_search", "web_extract", "navigate", "screenshot", "browser_snapshot", "email_read", "attachment_read", "read_file", "delegate_task",
			"dev_ci_logs", "dev_ci_status", "dev_pr_checkout", "github_compare", "github_list_repos", "mcp_tool_search", "session_search",
			"memory_search", "memory", "checkpoint_read", "list_routines", "send_to_bot", "page_read", "some_future_tool",
			"mcp__cal__list_events", "mcp__cal__create_event", "mcp__gmail__GMAIL_FETCH_EMAILS",
		];
		for (const name of names) expect(isUntrustedContentTool(name), name).toBe(true);
	});
	it("só as tools internas limpas (resultado feito pelo próprio Atlas) não marcam", () => {
		const clean = ["propose_routine", "propose_questionnaire", "propose_profile_update", "update_task_list", "todo_write", "notify_user", "set_autonomy", "schedule_followup", "cancel_followup", "reschedule_followup", "request_secrets"];
		for (const name of clean) expect(isUntrustedContentTool(name), name).toBe(false);
	});
});
