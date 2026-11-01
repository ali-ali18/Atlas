import type { SandboxManager } from "@workspace/sandbox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COMPUTER_USE_TOOLS } from "../../computer-use.js";
import { DEV_SESSION_TOOL_NAMES } from "../dev-session.js";
import { TOOL_FAMILIES, TOOL_RESOLVERS } from "./handlers/index.js";
import { declareToolFamilies } from "./registry.js";
import {
	attachToolDefinitions,
	executeRegisteredTool,
	getToolRegistration,
	hasRegisteredTool,
	listRegisteredToolNames,
} from "./index.js";
import type { ToolContext } from "./types.js";

/** Contexto mínimo: cada teste só preenche o que o handler sob teste lê. */
function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
	return {
		manager: {} as SandboxManager,
		getSessionId: async () => "sessao-1",
		botId: "bot-1",
		userId: "user-1",
		...overrides,
	};
}

afterEach(() => {
	declareToolFamilies(TOOL_FAMILIES, TOOL_RESOLVERS);
});

describe("registro de tools", () => {
	it("lista as tools de cada família", () => {
		const names = new Set(listRegisteredToolNames());
		for (const expected of [
			"navigate", "browser_snapshot", "browser_tabs", "sandbox_shell", "sandbox_release", "web_search", "web_extract",
			"attachment_read", "generate_image", "create_file", "run_code", "memory", "session_search", "memory_search",
			"artifact_read", "secret_request", "login_fill", "skill_read", "email_send", "schedule_followup", "notify_user",
			"propose_connector", "api_call", "mcp_tool_search", "list_routines", "propose_routine", "report_alert",
			"propose_bot", "propose_profile_update", "delegate_task", "propose_questionnaire", "propose_plan",
			"update_task_list", "track_items", "research_note", "page_create", "page_share", "app_info", "current_time",
		]) {
			expect(names, expected).toContain(expected);
		}
	});

	it("toda tool registrada tem handler e grupo", () => {
		for (const name of listRegisteredToolNames()) {
			const registration = getToolRegistration(name);
			expect(typeof registration?.handler, name).toBe("function");
			expect(registration?.group, name).toBeTruthy();
		}
	});

	it("nenhuma tool de nome fixo repete nome da sessão de código", () => {
		const names = new Set(listRegisteredToolNames());
		for (const dev of DEV_SESSION_TOOL_NAMES) expect(names.has(dev), dev).toBe(false);
	});

	it("tool do modelo com definição em COMPUTER_USE_TOOLS tem o mesmo schema no registro", () => {
		attachToolDefinitions(COMPUTER_USE_TOOLS);
		const memory = COMPUTER_USE_TOOLS.find((tool) => tool.function.name === "memory");
		expect(memory).toBeTruthy();
		expect(getToolRegistration("memory")?.definition).toBe(memory);
	});

	it("tool sem handler dá erro honesto", async () => {
		await expect(executeRegisteredTool("ferramenta_que_nao_existe", {}, makeCtx())).rejects.toThrow(
			"Ferramenta desconhecida: ferramenta_que_nao_existe",
		);
		expect(hasRegisteredTool("ferramenta_que_nao_existe")).toBe(false);
	});

	it("executeRegisteredTool chama o handler com os mesmos args e o mesmo ctx", async () => {
		const handler = vi.fn(async () => ({ summary: "feito" }));
		declareToolFamilies([() => ({ tool_falsa: { group: "misc", handler } })]);
		const ctx = makeCtx();
		const args = { a: 1 };
		await expect(executeRegisteredTool("tool_falsa", args, ctx)).resolves.toEqual({ summary: "feito" });
		expect(handler).toHaveBeenCalledWith(args, ctx);
	});

	it("nome repetido entre famílias é erro", () => {
		const handler = async () => ({ summary: "" });
		declareToolFamilies([() => ({ x: { group: "misc", handler } }), () => ({ x: { group: "web", handler } })]);
		expect(() => listRegisteredToolNames()).toThrow("Tool registrada duas vezes: x");
	});

	it("resolvedor `before` vence o mapa; `after` só entra no que o mapa não conhece", async () => {
		const handler = async () => ({ summary: "mapa" });
		declareToolFamilies([() => ({ x: { group: "misc", handler } })], {
			before: [() => (name) => (name === "x" ? async () => ({ summary: "antes" }) : undefined)],
			after: [() => (name) => (name === "y" ? async () => ({ summary: "depois" }) : undefined)],
		});
		expect((await executeRegisteredTool("x", {}, makeCtx())).summary).toBe("antes");
		expect((await executeRegisteredTool("y", {}, makeCtx())).summary).toBe("depois");
	});
});

describe("handlers com ctx simulado", () => {
	it("checkpoint_read lê o estado operacional do ctx", async () => {
		const getOperationalSnapshot = vi.fn(() => ({ step: 3, model: "m", messages: 7, consumedInputs: ["a"] }));
		const result = await executeRegisteredTool("checkpoint_read", {}, makeCtx({ getOperationalSnapshot }));
		expect(result.summary).toContain("Passo atual: 3 (modelo m).");
		expect(result.summary).toContain("Mensagens acumuladas: 7.");
		expect(getOperationalSnapshot).toHaveBeenCalledOnce();
	});

	it("checkpoint_read sem estado diz que está indisponível", async () => {
		await expect(executeRegisteredTool("checkpoint_read", {}, makeCtx())).resolves.toEqual({
			summary: "Estado operacional indisponível.",
		});
	});

	it("navigate abre a URL na sessão do ctx", async () => {
		const execNavigate = vi.fn(async () => ({ url: "https://exemplo.test/", title: "Exemplo", ready: true }));
		const manager = { execNavigate } as unknown as SandboxManager;
		const result = await executeRegisteredTool("navigate", { url: " https://exemplo.test/ " }, makeCtx({ manager }));
		expect(execNavigate).toHaveBeenCalledWith("sessao-1", "https://exemplo.test/");
		expect(result.summary).toContain("Abriu https://exemplo.test/ (título: Exemplo)");
	});

	it("navigate sem url falha com a mensagem de sempre", async () => {
		await expect(executeRegisteredTool("navigate", {}, makeCtx())).rejects.toThrow("url vazia");
	});

	it("api_call sem API conectada falha dizendo como seguir", async () => {
		await expect(executeRegisteredTool("api_call", {}, makeCtx())).rejects.toThrow("No API is connected");
	});

	it("report_alert fora de rotina de alerta falha", async () => {
		await expect(executeRegisteredTool("report_alert", {}, makeCtx())).rejects.toThrow(
			"report_alert só existe em execução de rotina de alerta.",
		);
	});

	it("tool da sessão de código sem runtime ligado falha em vez de cair em 'desconhecida'", async () => {
		const [devTool] = DEV_SESSION_TOOL_NAMES;
		await expect(executeRegisteredTool(devTool as string, {}, makeCtx())).rejects.toThrow(
			"Sessões de desenvolvimento não estão habilitadas neste run.",
		);
	});

	it("nome de conector MCP sem o conector no run cai no resolvedor de conectores", async () => {
		await expect(executeRegisteredTool("mcp__github__list_issues", {}, makeCtx())).rejects.toThrow(/Ferramenta desconhecida/);
		expect(hasRegisteredTool("mcp__github__list_issues")).toBe(true);
	});
});
