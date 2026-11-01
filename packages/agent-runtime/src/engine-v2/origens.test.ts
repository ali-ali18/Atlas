import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatTool, CompleteChatWithToolsResult, LlmToolCall } from "@workspace/llm";
import type { SandboxManager } from "@workspace/sandbox";
import type { ComputerUseEvent } from "@workspace/shared";
import { buildMcpToolset } from "../mcp/registry.js";
import type { McpRuntime } from "../mcp/runtime.js";
import { buildEngineV2Catalog } from "./catalog.js";
import { unattendedLoginOutcome } from "./login.js";
import { runEngineV2, type EngineV2Options } from "./run.js";

/**
 * Motor v2 fora do chat direto (escopo "all" do bot): rotina, grupo e bot→bot. O que o v1 garante em cada origem
 * (sem humano para perguntar, conector só com o que a autonomia libera, tools de gestão fora da rotina) vale igual.
 */

vi.mock("@workspace/db", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@workspace/db")>();
	return {
		...actual,
		getBotProfile: vi.fn(async () => ({ description: "configurado" })),
		findExecutedConfirmCall: vi.fn(async () => null),
		persistJevStatusCard: vi.fn(async () => undefined),
		persistConversationCardFromEvent: vi.fn(async () => undefined),
		upsertTaskListCard: vi.fn(async () => undefined),
		getConversationUntrustedAt: vi.fn(async () => null),
		searchMemoryEntries: vi.fn(async () => []),
		listBotSkills: vi.fn(async () => []),
		searchSkillVersions: vi.fn(async () => []),
		listRoutines: vi.fn(async () => []),
		saveSkillPendingIntent: vi.fn(async () => undefined),
		loadAutonomyContext: vi.fn(async () => ({ accountRaw: null, botRaw: null, botName: "Taldo" })),
	};
});

const erp = {
	id: "conn-erp",
	slug: "erp",
	name: "ERP",
	disabledTools: [],
	tools: [
		{ name: "buscar_cliente", description: "Busca cliente", inputSchema: { type: "object", properties: { nome: { type: "string" } } }, annotations: { readOnlyHint: true } },
		{ name: "criar_proposta", description: "Cria proposta", inputSchema: { type: "object", properties: { cliente: { type: "string" } } }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
	],
};
const READ = "mcp__erp__buscar_cliente";
const WRITE = "mcp__erp__criar_proposta";
const balanced = { level: "balanced", exceptions: [] } as never;

const toolCall = (id: string, name: string, args: Record<string, unknown> = {}): CompleteChatWithToolsResult => ({
	model: "m",
	message: { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } } satisfies LlmToolCall] },
	finishReason: "tool_calls",
});
const say = (text: string): CompleteChatWithToolsResult => ({ model: "m", message: { role: "assistant", content: text }, finishReason: "stop" });

async function runOrigin(input: {
	origin: string;
	script: CompleteChatWithToolsResult[];
	/** O toolset do conector foi montado SEM `unattended` (o catálogo precisa filtrar sozinho). */
	options?: Partial<EngineV2Options>;
	extra?: Partial<Parameters<typeof runEngineV2>[0]>;
	text?: string;
}) {
	const call = vi.fn(async () => ({ ok: true, text: "feito", truncated: false }));
	const mcp: McpRuntime = { toolset: buildMcpToolset([erp], { autonomy: balanced }), call };
	const events: ComputerUseEvent[] = [];
	const queue = [...input.script];
	const requests: Array<{ system: string; toolNames: string[] }> = [];
	const result = await runEngineV2(
		{
			manager: {} as SandboxManager,
			getSessionId: async () => "x",
			sandboxEnabled: false,
			model: "m",
			apiKey: "t",
			messages: [{ role: "user", content: input.text ?? "Veja se o cliente Acme existe e me diga" }],
			botId: "bot-1",
			userId: "user-1",
			conversationId: "conv-o",
			runId: "run-o1",
			origin: input.origin,
			mcp,
			autonomy: balanced,
			onEvent: (event) => {
				events.push(event);
			},
			streamChat: async (params) => {
				requests.push({
					system: params.messages.filter((m) => m.role === "system").map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n"),
					toolNames: params.tools.map((tool: ChatTool) => tool.function.name),
				});
				const next = queue.shift();
				if (!next) throw new Error("LLM extra");
				return next;
			},
			...input.extra,
		},
		{ profile: "chat", ...input.options },
	);
	return { call, events, result, requests, results: events.filter((e): e is Extract<ComputerUseEvent, { type: "tool_result" }> => e.type === "tool_result") };
}

beforeEach(() => vi.clearAllMocks());

describe("v2 em rotina: sem humano, sem escrita que precisa de confirmação", () => {
	it("não expõe tool de escrita do conector nem as de gestão; o chat expõe a escrita (com cartão)", async () => {
		const routine = await runOrigin({ origin: "routine", script: [say("Acme existe.")] });
		const names = routine.requests[0]!.toolNames;
		expect(names).toContain(READ);
		expect(names).not.toContain(WRITE);
		for (const gone of ["list_routines", "propose_routine", "routine_group", "web_search", "web_extract", "memory", "secret_request", "update_task_list", "generate_image", "page_create", "propose_api_connection", "propose_profile_update", "set_engine", "delegate"]) {
			expect(names, gone).not.toContain(gone);
		}
		const chat = await runOrigin({ origin: "chat", script: [say("ok")] });
		expect(chat.requests[0]!.toolNames).toContain(WRITE);
		expect(chat.requests[0]!.toolNames).toContain("update_task_list");
	});

	it("o prompt avisa que não há quem responda e traz o modo execução de rotina; o chat não paga esse texto", async () => {
		const routine = await runOrigin({ origin: "routine", script: [say("ok")] });
		expect(routine.requests[0]!.system).toMatch(/Unattended run: .*nobody is in the conversation to answer/);
		expect(routine.requests[0]!.system).toMatch(/MODO EXECUÇÃO DE ROTINA/);
		const chat = await runOrigin({ origin: "chat", script: [say("ok")], text: "Bom dia" });
		expect(chat.requests[0]!.system).not.toMatch(/Unattended run/);
		expect(chat.requests[0]!.system).not.toMatch(/MODO EXECUÇÃO DE ROTINA/);
		const bot = await runOrigin({ origin: "bot", script: [say("ok")] });
		expect(bot.requests[0]!.system).not.toMatch(/Unattended run/);
	});

	it("o modelo insiste na escrita: erro honesto, o conector não é chamado e o run não fica esperando o usuário", async () => {
		const { call, results, result, events } = await runOrigin({
			origin: "routine",
			script: [toolCall("w1", WRITE, { cliente: "Acme" }), say("Não consegui criar a proposta: preciso da sua aprovação, abra a conversa.")],
		});
		expect(call).not.toHaveBeenCalled();
		expect(results[0]?.ok).toBe(false);
		expect(events.some((event) => event.type === "confirm")).toBe(false);
		expect(result.stop).toEqual({ reason: "answered" });
	});

	it("leitura do conector roda e entrega o resultado", async () => {
		const { call, result } = await runOrigin({ origin: "routine", script: [toolCall("r1", READ, { nome: "Acme" }), say("Acme existe.")] });
		expect(call).toHaveBeenCalledTimes(1);
		expect(result.text).toBe("Acme existe.");
		expect(result.stop).toEqual({ reason: "answered" });
	});

	it("rotina de painel: só ler e atualizar o painel dela (o catálogo carrega o grupo de painéis)", () => {
		const names = (origin: string, routinePageId?: string) =>
			buildEngineV2Catalog({
				origin,
				userId: "user-1",
				sandboxEnabled: false,
				autonomy: balanced,
				mcp: null,
				apiConnector: false,
				attachments: { present: false },
				allowProfileUpdate: false,
				hasImageAttachments: false,
				routerMessages: [],
				lastUserMessage: "atualize o painel",
				...(routinePageId ? { routinePageId } : {}),
			}).tools.map((tool) => tool.function.name);
		const withPage = names("routine", "page-1");
		expect(withPage).toContain("page_update");
		expect(withPage).toContain("page_read");
		expect(withPage).not.toContain("page_create");
		expect(withPage).not.toContain("page_share");
		expect(names("routine").filter((name) => name.startsWith("page_"))).toEqual([]);
		expect(names("bot").filter((name) => name.startsWith("page_"))).toEqual([]);
	});
});

describe("v2 em rotina: login sem humano", () => {
	const event = { type: "login", loginId: "l1", site: "erp.example.com", url: "https://erp.example.com", reason: "login" } as Extract<ComputerUseEvent, { type: "login" }>;
	const summary = "Página de login.\nLOGIN REQUIRED on erp.example.com: peça ao usuário.";

	it("rotina: sem cartão e sem pausa; o modelo recebe a nota para fechar com uma mensagem ao dono", () => {
		const out = unattendedLoginOutcome({ event, summary, unattended: true });
		expect(out.event).toBeUndefined();
		expect(out.summary).toContain("LOGIN NOT POSSIBLE on erp.example.com");
		expect(out.summary).not.toContain("LOGIN REQUIRED on");
	});

	it("chat, captcha e login de conector seguem pedindo à pessoa", () => {
		expect(unattendedLoginOutcome({ event, summary, unattended: false }).event).toBe(event);
		const captcha = { ...event, reason: "captcha" } as typeof event;
		expect(unattendedLoginOutcome({ event: captcha, summary, unattended: true }).event).toBe(captcha);
	});
});

describe("v2 em bot→bot e grupo", () => {
	it("bot→bot: sem tools sensíveis; sem roster (nenhum outro bot) também não há envio entre bots", async () => {
		const { requests } = await runOrigin({ origin: "bot", script: [say("ok")] });
		const names = requests[0]!.toolNames;
		for (const gone of ["send_to_bot", "decide_bot_pending", "set_primary_bot", "propose_bot", "set_engine", "propose_profile_update", "delegate", "generate_image", "page_create"]) {
			expect(names, gone).not.toContain(gone);
		}
		expect(names).toContain("update_task_list");
		expect(names).toContain(WRITE);
	});

	it("grupo (run de membro, origin chat): set_engine e perfil só com o dono digitando; sem turno humano nada disso aparece", async () => {
		const { requests } = await runOrigin({
			origin: "chat",
			text: "liga o motor novo nesse bot",
			script: [say("ok")],
			extra: { humanTurn: false },
		});
		expect(requests[0]!.toolNames).not.toContain("set_engine");
		const human = await runOrigin({ origin: "chat", text: "liga o motor novo nesse bot", script: [say("ok")], extra: { humanTurn: true } });
		expect(human.requests[0]!.toolNames).toContain("set_engine");
	});
});
