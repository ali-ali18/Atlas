import { describe, expect, it } from "vitest";
import { COMPUTER_USE_TOOLS } from "../../computer-use.js";
import { DEV_SESSION_TOOL_NAMES } from "../dev-session.js";
import { getToolRegistration, listRegisteredToolNames } from "./index.js";
import { getToolMeta, mcpToolEffect, TOOL_META } from "./tool-meta.js";
import type { ToolEffect } from "./types.js";

const EFFECTS: ToolEffect[] = ["read", "write_internal", "write_external", "send", "money", "public_link", "credential"];

/** "readOnly" para o governor (não conta como efeito no run), mas escrita de fato: só anotam no estado do próprio run. */
const READ_ONLY_FOR_GOVERNOR_BUT_WRITES = new Set(["notebook_write", "research_note"]);

describe("metadado das tools (effect, poll, endsTurn)", () => {
	it("toda tool registrada tem efeito válido", () => {
		for (const name of listRegisteredToolNames()) {
			expect(EFFECTS, name).toContain(getToolRegistration(name)?.effect);
		}
	});

	it("toda tool do catálogo (COMPUTER_USE_TOOLS) tem efeito", () => {
		for (const tool of COMPUTER_USE_TOOLS) {
			expect(EFFECTS, tool.function.name).toContain(getToolMeta(tool.function.name)?.effect);
		}
	});

	it("toda tool da sessão de código tem efeito", () => {
		for (const name of DEV_SESSION_TOOL_NAMES) expect(EFFECTS, name).toContain(getToolMeta(name)?.effect);
	});

	it("a tabela não guarda nome que não existe (sem lixo)", () => {
		const known = new Set<string>([...listRegisteredToolNames(), ...DEV_SESSION_TOOL_NAMES]);
		for (const name of Object.keys(TOOL_META)) expect(known.has(name), name).toBe(true);
	});

	it("tool marcada como só-leitura pelo registro tem efeito read", () => {
		for (const name of listRegisteredToolNames()) {
			const registration = getToolRegistration(name);
			if (registration?.readOnly && !READ_ONLY_FOR_GOVERNOR_BUT_WRITES.has(name)) expect(registration.effect, name).toBe("read");
		}
	});

	it("valores críticos: envio é send, leitura é read, publicação e segredo têm efeito próprio", () => {
		expect(getToolMeta("email_send")?.effect).toBe("send");
		expect(getToolMeta("email_reply")?.effect).toBe("send");
		expect(getToolMeta("notify_user")?.effect).toBe("send");
		expect(getToolMeta("page_share")?.effect).toBe("public_link");
		expect(getToolMeta("login_fill")?.effect).toBe("credential");
		expect(getToolMeta("secret_request")?.effect).toBe("credential");
		expect(getToolMeta("api_call")?.effect).toBe("write_external");
		expect(getToolMeta("send_to_bot")?.effect).toBe("write_external");
		expect(getToolMeta("dev_pr_create")?.effect).toBe("write_external");
		for (const name of ["web_search", "web_extract", "email_list", "email_read", "list_routines", "page_read", "page_list", "memory_search", "browser_snapshot", "skill_read", "current_time", "app_info"]) {
			expect(getToolMeta(name)?.effect, name).toBe("read");
		}
	});

	it("só as esperas e status de job são poll", () => {
		const polls = Object.entries(TOOL_META).filter(([, meta]) => meta.poll).map(([name]) => name).sort();
		expect(polls).toEqual(["browser_wait", "dev_ci_status", "sandbox_shell_wait", "shell_output"]);
		for (const name of polls) expect(getToolMeta(name)?.effect, name).toBe("read");
	});

	it("só veredito de alerta e pergunta ao humano encerram o turno", () => {
		const ends = Object.entries(TOOL_META).filter(([, meta]) => meta.endsTurn).map(([name]) => name).sort();
		expect(ends).toEqual(["propose_plan", "propose_questionnaire", "report_alert"]);
	});

	it("o registro entrega effect/poll/endsTurn na própria registração", () => {
		expect(getToolRegistration("email_send")).toMatchObject({ effect: "send" });
		expect(getToolRegistration("sandbox_shell_wait")).toMatchObject({ effect: "read", poll: true });
		expect(getToolRegistration("report_alert")).toMatchObject({ endsTurn: true });
	});

	it("tool de conector MCP deriva do marcador de leitura existente", () => {
		expect(mcpToolEffect(true)).toBe("read");
		expect(mcpToolEffect(false)).toBe("write_external");
		expect(getToolMeta("hasOwnProperty")).toBeUndefined();
	});
});
