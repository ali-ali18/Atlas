import { describe, expect, it } from "vitest";
import { z } from "zod";
import { APP_INFO_TOOL, appInfoTool } from "./app-info.js";
import { CURRENT_TIME_TOOL, currentTimeTool } from "./current-time.js";
import { defineRawTool, defineTool } from "./define-tool.js";
import { toolCallTool, toolSearchTool } from "./tool-bridge.js";
import { getToolMeta, isDefinedTool, TOOL_META } from "./registry/tool-meta.js";
import { getToolRegistration, listRegisteredToolNames } from "./registry/index.js";
import { DEV_SESSION_TOOL_NAMES } from "./dev-session.js";
import type { ToolContext, ToolEffect } from "./registry/types.js";

const EFFECTS: ToolEffect[] = ["read", "write_internal", "write_external", "send", "money", "public_link", "credential"];
const ctx = { timeZone: "America/Sao_Paulo" } as unknown as ToolContext;

/**
 * Nomes que já estavam na tabela `TOOL_META` quando o `defineTool` nasceu (PR5). A lista só pode encolher: tool
 * nova vai para `defineTool` (com `effect` obrigatório pelo tipo), nunca para a tabela.
 */
const LEGACY_TABLE = new Set(
	"api_call api_search artifact_read attachment_list attachment_read attachment_to_computer browser_act browser_click browser_find browser_links browser_read browser_snapshot browser_tabs browser_text browser_type browser_wait cancel_followup checkpoint_read click computer create_file decide_bot_pending delegate delegate_task delete_skill dev_ci_logs dev_ci_status dev_environment_get dev_environment_update dev_pr_checkout dev_pr_create dev_session_start edit_file email_create_mailbox email_list email_read email_reply email_send find_page_value generate_image github_compare github_list_repos grep inspect_presentation key lesson_feedback list_files list_followups list_routines list_skills login_fill mcp_tool_search memory memory_search navigate notebook_read notebook_write notify_user page_create page_list page_read page_share page_update preview_setup preview_start preview_stop propose_api_connection propose_bot propose_connector propose_custom_mcp propose_plan propose_profile_update propose_questionnaire propose_routine propose_skill propose_skill_change propose_skill_delete read_file report_alert request_secrets reschedule_followup research_note routine_control routine_group routine_webhook_info run_code sandbox_download sandbox_list sandbox_read sandbox_release sandbox_shell sandbox_shell_wait schedule_followup screenshot scroll secret_list secret_request send_to_bot session_search set_autonomy set_connector_tool_marks set_engine set_primary_bot set_reasoning_effort shell shell_kill shell_output shell_stdin show_image show_skill skill_read suggest_routine todo_write track_items type update_task_list video_transcript web_extract web_search write_file".split(" "),
);

describe("defineTool", () => {
	it("gera o schema do zod no formato do catálogo (sem $schema, required só quando há)", () => {
		const tool = defineTool({
			name: "demo",
			description: "Demo.",
			input: z.object({ query: z.string().describe("q"), limit: z.number().int().optional() }),
			effect: "read",
			group: "misc",
			run: () => ({ summary: "ok" }),
		});
		expect(tool.definition).toEqual({
			type: "function",
			function: { name: "demo", description: "Demo.", parameters: { type: "object", properties: { query: { type: "string", description: "q" }, limit: { type: "integer" } }, required: ["query"] } },
		});
		expect(tool.meta).toEqual({ effect: "read" });
	});

	it("valida os args pelo schema: erro honesto com a assinatura; null em campo opcional = omitido", async () => {
		const seen: unknown[] = [];
		const tool = defineTool({
			name: "demo",
			description: "Demo.",
			input: z.object({ query: z.string(), limit: z.number().optional() }),
			effect: "read",
			group: "misc",
			run: (args) => {
				seen.push(args);
				return { summary: "ok" };
			},
		});
		await expect(tool.handler({ query: 3 }, ctx)).rejects.toThrow(/Invalid arguments: query: .*Expected: demo\(query: string, limit\?: number\)/);
		await expect(tool.handler({ query: "a", limit: null }, ctx)).resolves.toEqual({ summary: "ok" });
		expect(seen).toEqual([{ query: "a" }]);
	});

	it("metadado: effectForArgs com args válidos, pior caso com inválidos; ownCard, poll, endsTurn e needsHuman passam", () => {
		const tool = defineTool({
			name: "demo",
			description: "Demo.",
			input: z.object({ method: z.string().optional() }),
			effect: "write_external",
			catalogEffect: "read",
			effectForArgs: (args) => (args.method === "GET" ? "read" : "write_external"),
			poll: true,
			endsTurn: true,
			needsHuman: true,
			ownCard: true,
			group: "connectors",
			run: () => ({ summary: "ok" }),
		});
		expect(tool.meta).toMatchObject({ effect: "write_external", catalogEffect: "read", poll: true, endsTurn: true, needsHuman: true, ownCard: true });
		expect(tool.meta.effectForArgs?.({ method: "GET" })).toBe("read");
		expect(tool.meta.effectForArgs?.({ method: 5 })).toBe("write_external");
	});
});

describe("defineRawTool", () => {
	it("usa a definição como está (mesma referência) e não valida nem muda os args", async () => {
		const definition = { type: "function" as const, function: { name: "raw", description: "Raw.", parameters: { type: "object" as const, properties: { n: { type: "number" } } } } };
		const seen: unknown[] = [];
		const tool = defineRawTool({ name: "raw", definition, effect: "write_internal", endsTurn: true, group: "misc", run: (args) => (seen.push(args), { summary: "ok" }) });
		expect(tool.definition).toBe(definition);
		expect(tool.meta).toEqual({ effect: "write_internal", endsTurn: true });
		await tool.handler({ n: null, extra: 1 }, ctx);
		expect(seen).toEqual([{ n: null, extra: 1 }]);
	});

	it("recusa definição de outro nome e aceita tool legada sem schema", () => {
		const definition = { type: "function" as const, function: { name: "outra", description: "", parameters: { type: "object" as const, properties: {} } } };
		expect(() => defineRawTool({ name: "raw", definition, effect: "read", group: "misc", run: () => ({ summary: "" }) })).toThrow(/outra/);
		expect(defineRawTool({ name: "legado", effect: "read", group: "misc", run: () => ({ summary: "" }) }).definition).toBeUndefined();
	});
});

describe("tools migradas para defineTool", () => {
	it("current_time e app_info mantêm o mesmo schema (bytes) que o catálogo enviava", () => {
		expect(JSON.stringify(CURRENT_TIME_TOOL)).toBe(
			JSON.stringify({ type: "function", function: { name: "current_time", description: CURRENT_TIME_TOOL.function.description, parameters: { type: "object", properties: { timezone: { type: "string", description: "IANA zone; default: the user's" } } } } }),
		);
		const topic = (APP_INFO_TOOL.function.parameters.properties as Record<string, Record<string, unknown>>).topic!;
		expect(Object.keys(topic)).toEqual(["type", "enum", "description"]);
		expect(topic.enum).toEqual(["oauth", "mcp", "webhooks", "vault", "login", "settings", "models", "limits"]);
		expect(APP_INFO_TOOL.function.parameters.required).toBeUndefined();
	});

	it("o registro executa pelo handler do defineTool e o metadado vem dele", async () => {
		for (const tool of [currentTimeTool, appInfoTool]) {
			expect(getToolRegistration(tool.name)?.handler).toBe(tool.handler);
			expect(getToolRegistration(tool.name)?.definition).toBe(tool.definition);
			expect(getToolMeta(tool.name)).toEqual(tool.meta);
			expect(isDefinedTool(tool.name)).toBe(true);
		}
		await expect(currentTimeTool.handler({ timezone: "Not/AZone" }, ctx)).rejects.toThrow(/Invalid timezone/);
		expect((await currentTimeTool.handler({ timezone: null }, ctx)).summary).toMatch(/America\/Sao_Paulo/);
	});

	it("app_info segue tolerante: tópico com maiúscula vale; tópico desconhecido devolve todos", async () => {
		const one = (await appInfoTool.handler({ topic: " MCP " }, ctx)).summary;
		const all = (await appInfoTool.handler({ topic: "nada" }, ctx)).summary;
		expect(all.length).toBeGreaterThan(one.length);
		expect((await appInfoTool.handler({ topic: "mcp" }, ctx)).summary).toBe(one);
	});
});

describe("guarda: tool nova usa defineTool", () => {
	it("a tabela TOOL_META não ganha nome novo (só encolhe) e não repete nome de defineTool", () => {
		const added = Object.keys(TOOL_META).filter((name) => !LEGACY_TABLE.has(name));
		expect(added, "tool nova: declare com defineTool , não na tabela").toEqual([]);
		for (const tool of [currentTimeTool, appInfoTool, toolSearchTool, toolCallTool]) expect(Object.hasOwn(TOOL_META, tool.name), tool.name).toBe(false);
	});

	it("toda tool do registro é da tabela antiga ou do defineTool, e nenhuma fica sem effect", () => {
		for (const name of [...listRegisteredToolNames(), ...DEV_SESSION_TOOL_NAMES]) {
			expect(LEGACY_TABLE.has(name) || isDefinedTool(name), `${name}: declare com defineTool`).toBe(true);
			expect(EFFECTS, name).toContain(getToolMeta(name)?.effect);
		}
		for (const tool of [currentTimeTool, appInfoTool, toolSearchTool, toolCallTool]) expect(EFFECTS, tool.name).toContain(tool.meta.effect);
	});

	it("ownCard substitui a lista fixa do approval: propostas e cartões próprios marcados", () => {
		const own = Object.entries(TOOL_META).filter(([, meta]) => meta.ownCard).map(([name]) => name).sort();
		for (const name of Object.keys(TOOL_META).filter((key) => key.startsWith("propose_"))) expect(own, name).toContain(name);
		expect(own).toEqual(expect.arrayContaining(["dev_pr_create", "edit_file", "email_create_mailbox", "email_reply", "email_send", "generate_image", "login_fill", "preview_setup", "read_file", "request_secrets", "secret_request", "set_primary_bot", "shell", "write_file"]));
		expect(getToolMeta("page_share")?.ownCard).toBeUndefined();
	});
});
