import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CompleteChatWithToolsParams, CompleteChatWithToolsResult } from "@workspace/llm";
import type { SandboxManager } from "@workspace/sandbox";
import type { AgentRunCheckpoint, ComputerUseEvent } from "@workspace/shared";
import { AgentRunPausedError } from "../errors.js";
import type { ComputerUseParams } from "../run-types.js";
import { COMPUTER_USE_TOOLS } from "../tools/catalog.js";
import { executeCancelReturn, executeScheduleReturn, type ScheduleReturnStore } from "../tools/schedule-return.js";
import type { ToolContext } from "../tools/registry/types.js";
import { runEngineV3 } from "./loop.js";
import { OWNER_HAS_COMPUTER, refusedToolKey, takeWaitMinutes } from "./owner-wait.js";

/** O executor real precisa de banco/VM: o roteiro de cada teste diz o que cada tool devolve. */
const executeTool = vi.hoisted(() => vi.fn(async (name: string, _args: Record<string, unknown>, _ctx: unknown): Promise<Record<string, unknown>> => ({ summary: `${name} done.` })));
vi.mock("../tools/registry/execute.js", () => ({ executeTool }));
const pendingReturns = vi.hoisted(() => [] as Array<{ id: string; dueAt: Date; reason: string }>);
vi.mock("@workspace/db", async (original) => ({
	...(await original<typeof import("@workspace/db")>()),
	getBotProfile: vi.fn(async () => ({ description: "configurado" })),
	getConversationUntrustedAt: vi.fn(async () => null),
	markConversationUntrusted: vi.fn(async () => undefined),
	markMcpTaskGrantsUntrusted: vi.fn(async () => undefined),
	persistConversationCardFromEvent: vi.fn(async () => undefined),
	upsertTaskListCard: vi.fn(async () => undefined),
	saveSkillPendingIntent: vi.fn(async () => undefined),
	takeToolCallApproval: vi.fn(async () => null),
	listPendingReturns: vi.fn(async () => pendingReturns),
}));

const call = (id: string, name: string, args: Record<string, unknown>): CompleteChatWithToolsResult => ({
	model: "m",
	message: { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] },
	finishReason: "tool_calls",
});
const say = (content: string): CompleteChatWithToolsResult => ({ model: "m", message: { role: "assistant", content }, finishReason: "stop" });
const textOf = (params: CompleteChatWithToolsParams) => params.messages.map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? ""))).join("\n");

type Script = Array<CompleteChatWithToolsResult | ((params: CompleteChatWithToolsParams) => CompleteChatWithToolsResult)>;

async function runV3(script: Script, extra: Partial<ComputerUseParams> = {}) {
	const events: ComputerUseEvent[] = [];
	const checkpoints: AgentRunCheckpoint[] = [];
	const requests: CompleteChatWithToolsParams[] = [];
	const queue = [...script];
	let error: unknown;
	let result;
	try {
		result = await runEngineV3({
			manager: {} as SandboxManager,
			getSessionId: async () => "s",
			sandboxEnabled: false,
			model: "m",
			apiKey: "k",
			runId: "run1",
			userId: "user-a",
			botId: "bot-a",
			conversationId: "conv-1",
			origin: "chat",
			humanTurn: true,
			messages: [{ role: "user", content: "Pega a transcrição do vídeo, resume pelo Gemini e faz um slide" }],
			onEvent: (event) => { events.push(event); },
			onCheckpoint: async (snapshot) => { checkpoints.push(snapshot as AgentRunCheckpoint); },
			streamChat: async (params) => {
				requests.push(params);
				const next = queue.shift();
				if (!next) throw new Error("roteiro acabou");
				return typeof next === "function" ? next(params) : next;
			},
			...extra,
		});
	} catch (caught) {
		error = caught;
	}
	const results = events.filter((event): event is Extract<ComputerUseEvent, { type: "tool_result" }> => event.type === "tool_result");
	const logins = events.filter((event): event is Extract<ComputerUseEvent, { type: "login" }> => event.type === "login");
	return { result, error, events, results, logins, checkpoints, requests };
}

const loginWall = { summary: "gemini.google.com pede login.", loginEvent: { type: "login", loginId: "login-run1-ab", site: "gemini.google.com", url: "https://gemini.google.com/app", runId: "run1", status: "pending" } };

/** Checkpoint de um run pausado no login, com a saída que o dono escolheu (ou nenhuma: acordou por mensagem). */
function pausedAt(outcome?: NonNullable<AgentRunCheckpoint["pendingLogin"]>["outcome"], extra: Partial<NonNullable<AgentRunCheckpoint["pendingLogin"]>> = {}): Partial<ComputerUseParams> {
	return {
		restoredCheckpoint: {
			version: 2,
			messages: [{ role: "user", content: "Pega a transcrição do vídeo, resume pelo Gemini e faz um slide" }],
			llmMessages: [
				{ role: "system", content: "You are a bot." },
				{ role: "user", content: "Pega a transcrição do vídeo, resume pelo Gemini e faz um slide" },
				{ role: "assistant", content: null, tool_calls: [{ id: "a", type: "function", function: { name: "web_extract", arguments: JSON.stringify({ url: "https://gemini.google.com/app" }) } }] },
				{ role: "tool", tool_call_id: "a", content: "gemini.google.com pede login." },
			],
			nextStepIndex: 1,
			pendingLogin: { loginId: "login-run1-ab", site: "gemini.google.com", url: "https://gemini.google.com/app", ...(outcome ? { outcome } : {}), ...extra },
		} as unknown as AgentRunCheckpoint,
	};
}

beforeEach(() => {
	executeTool.mockReset();
	executeTool.mockImplementation(async (name: string) => ({ summary: `${name} done.` }));
	pendingReturns.length = 0;
});

describe("login/VM: cada saída do cartão chega ao modelo e o run continua", () => {
	it("replay: login do Gemini pulado → transcrição + resumo próprio + slide entregue, e diz o que ficou de fora", async () => {
		// 1º run: a página do Gemini pede login; o run estaciona (pausa) com o cartão.
		executeTool.mockImplementationOnce(async () => loginWall);
		const first = await runV3([call("a", "web_extract", { urls: ["https://gemini.google.com/app"] })]);
		expect(first.error).toBeInstanceOf(AgentRunPausedError);
		expect(first.logins).toEqual([expect.objectContaining({ status: "pending", site: "gemini.google.com" })]);
		const paused = first.checkpoints.at(-1)!;
		expect(paused.pendingLogin?.loginId).toBe("login-run1-ab");

		// O dono toca "Pular": a API grava `outcome: skipped` no checkpoint e retoma o MESMO run.
		executeTool.mockImplementation(async (name: string) => (name === "web_extract" ? { summary: "Transcrição: o vídeo explica três ideias A, B e C." } : { summary: "Arquivo slide.pptx criado." }));
		const second = await runV3(
			[
				(params) => {
					expect(textOf(params)).toContain("Owner skipped this step");
					expect(textOf(params)).toContain("Continue the rest of the task without it");
					return call("b", "web_extract", { urls: ["https://youtube.com/watch?v=x"] });
				},
				call("c", "create_file", { filename: "slide.pptx", content: "A, B, C" }),
				say("Fiz a transcrição, resumi eu mesmo (A, B e C) e o slide está pronto. Ficou de fora: o resumo pelo Gemini, porque o login foi pulado."),
			],
			{ restoredCheckpoint: { ...paused, pendingLogin: { ...paused.pendingLogin!, outcome: "skipped" } } },
		);
		expect(second.error).toBeUndefined();
		expect(second.result?.stop?.reason).toBe("answered");
		expect(second.result?.text).toContain("Ficou de fora");
		expect(executeTool.mock.calls.slice(1).map(([name]) => name)).toEqual(["web_extract", "create_file"]);
		expect(second.logins).toEqual([expect.objectContaining({ status: "done", outcome: "skipped" })]);
	});

	it("Terminei: confere a tela e segue (texto de sempre)", async () => {
		const { requests, logins } = await runV3([say("ok")], pausedAt("done"));
		expect(textOf(requests[0]!)).toContain("The user says they finished logging in on gemini.google.com");
		expect(logins[0]).toMatchObject({ status: "done", outcome: "done" });
	});

	it("Assumir: o modelo sabe que o dono está com a VM e as tools da VM não rodam neste turno", async () => {
		// No v3 o navegador é browser_snapshot/act/navigate/tabs (PR6); `screenshot` nem é oferecida.
		const { requests, results } = await runV3([call("s", "browser_snapshot", { view: "screenshot" }), say("Espero você terminar.")], { ...pausedAt("takeover"), sandboxEnabled: true });
		expect(textOf(requests[0]!)).toContain("Owner has control of the computer");
		const shot = results.find((event) => event.name === "browser_snapshot");
		expect(shot).toMatchObject({ ok: false, summary: expect.stringContaining(OWNER_HAS_COMPUTER.slice(0, 40)) });
		expect(executeTool).not.toHaveBeenCalledWith("browser_snapshot", expect.anything(), expect.anything());
	});

	it("prazo vencido: vira pulado (nunca feito) e o run segue", async () => {
		const { requests, logins } = await runV3([say("Segui sem o login.")], pausedAt("skipped_timeout", { waitMinutes: 20 }));
		expect(textOf(requests[0]!)).toContain("within 20 min");
		expect(textOf(requests[0]!)).toContain("NOT done and NOT approved");
		expect(logins[0]).toMatchObject({ outcome: "skipped_timeout" });
	});

	it("dono ignorou o cartão e mandou outra mensagem: o modelo recebe a fala nova e o cartão fecha como ignorado", async () => {
		const consumeSteerInputs = vi.fn(async () => [{ id: "in1", content: "esquece o Gemini, faz só o slide", mode: "join" }]);
		const { requests, logins } = await runV3([say("Faço só o slide.")], { ...pausedAt(), consumeSteerInputs });
		const text = textOf(requests[0]!);
		expect(text).toContain('did not answer the previous request ("log in to gemini.google.com") and sent: "esquece o Gemini, faz só o slide"');
		// A fala do dono entra como mensagem dele depois da nota.
		expect(requests[0]!.messages.at(-1)).toEqual({ role: "user", content: "esquece o Gemini, faz só o slide" });
		expect(logins[0]).toMatchObject({ outcome: "ignored" });
	});

	it("sem botão e sem mensagem (cliente antigo): vale o Terminei de sempre", async () => {
		const { requests, logins } = await runV3([say("ok")], pausedAt());
		expect(textOf(requests[0]!)).toContain("The user says they finished logging in");
		expect(logins[0]).toMatchObject({ outcome: "done" });
	});
});

describe("questionário: prazo e pergunta pulada", () => {
	const questionnaire = { type: "questionnaire", questionnaireId: "questionnaire-run1", title: "Qual formato?", items: [], status: "pending" };

	it("waitMinutes agenda o prazo do questionário e o cartão leva o fim", async () => {
		executeTool.mockImplementation(async () => ({ summary: "Questionário enviado.", questionnaireEvent: questionnaire }));
		const scheduleTimeout = vi.fn(async () => undefined);
		const { result, events } = await runV3([call("q", "propose_questionnaire", { title: "Qual formato?", items: [{ name: "f", prompt: "Formato?", choices: ["pptx", "pdf"] }], waitMinutes: 15 })], {
			ownerWait: { scheduleTimeout, scheduleReturn: vi.fn(), now: () => new Date("2026-11-04T12:00:00Z") },
		});
		expect(result?.stop).toEqual({ reason: "awaiting_confirmation", detail: "questionnaire" });
		expect(executeTool.mock.calls[0]![1]).not.toHaveProperty("waitMinutes");
		expect(scheduleTimeout).toHaveBeenCalledWith(expect.objectContaining({ card: "questionnaire", cardId: "questionnaire-run1", minutes: 15, toolName: "propose_questionnaire" }));
		expect(events.find((event) => event.type === "questionnaire")).toMatchObject({ deadlineAt: "2026-11-04T12:15:00.000Z" });
	});

	it("pergunta pulada/ignorada antes neste trabalho não volta: decide com um padrão", async () => {
		const seeded = { restoredCheckpoint: { version: 1, messages: [{ role: "user", content: "segue" }], transcriptSeed: { fromRunId: "run0", resultContent: "skipped", shortContent: "ok", refused: [refusedToolKey("propose_questionnaire")] } } } as unknown as Partial<ComputerUseParams>;
		const { results, result } = await runV3([call("q", "propose_questionnaire", { title: "Qual formato?", items: [] }), say("Usei pptx, o padrão.")], seeded);
		expect(executeTool).not.toHaveBeenCalled();
		expect(results.find((event) => event.name === "propose_questionnaire")).toMatchObject({ ok: false, summary: expect.stringContaining("already declined, skipped or did not answer") });
		expect(result?.stop?.reason).toBe("answered");
	});
});

describe("takeWaitMinutes", () => {
	const tool = { type: "function" as const, function: { name: "x", description: "", parameters: { type: "object" as const, properties: { a: { type: "string" } } } } };
	it("tira o campo, valida e deixa o resto", () => {
		expect(takeWaitMinutes(tool, { a: "1", waitMinutes: 5 })).toEqual({ args: { a: "1" }, minutes: 5 });
		expect(takeWaitMinutes(tool, { a: "1" })).toEqual({ args: { a: "1" } });
		expect(takeWaitMinutes(tool, { waitMinutes: 0 })).toMatchObject({ error: expect.stringContaining("1 to 1440") });
		const own = { ...tool, function: { ...tool.function, parameters: { type: "object" as const, properties: { waitMinutes: { type: "number" } } } } };
		expect(takeWaitMinutes(own, { waitMinutes: 5 })).toEqual({ args: { waitMinutes: 5 } });
	});
});

describe("schedule_return", () => {
	const now = new Date("2026-11-04T12:00:00Z");
	function fakeStore(initial: number = 0) {
		const rows: Array<{ id: string; userId: string; conversationId: string; dueAt: Date; reason: string; visible: boolean; status: string }> = [];
		for (let index = 0; index < initial; index += 1) rows.push({ id: `old${index}`, userId: "user-a", conversationId: "conv-1", dueAt: now, reason: "x", visible: false, status: "pending" });
		const store = {
			listPending: vi.fn(async (userId: string, conversationId: string) => rows.filter((row) => row.userId === userId && row.conversationId === conversationId && row.status === "pending")),
			create: vi.fn(async (input: { userId: string; conversationId: string; dueAt: Date; reason: string; visible: boolean }) => {
				const row = { id: `ret${rows.length}`, status: "pending", ...input };
				rows.push(row);
				return { ...row, botId: null, sourceRunId: "run1", runId: null, createdAt: now, status: "pending" as const };
			}),
			cancel: vi.fn(async (userId: string, returnId: string, conversationId?: string) => {
				const row = rows.find((item) => item.id === returnId && item.userId === userId && item.status === "pending" && (!conversationId || item.conversationId === conversationId));
				if (!row) return null;
				row.status = "cancelled";
				return { ...row, botId: null, sourceRunId: "run1", runId: null, createdAt: now, status: "cancelled" as const };
			}),
		};
		return { rows, store: store as unknown as ScheduleReturnStore };
	}
	const deps = () => ({ scheduleTimeout: vi.fn(), scheduleReturn: vi.fn(async () => undefined), cancelReturn: vi.fn(async () => undefined), now: () => now });
	const ctx = (ownerWait = deps(), userId = "user-a") => ({ ownerWait, userId, conversationId: "conv-1", runId: "run1", botId: "bot-a", timeZone: "America/Sao_Paulo" }) as unknown as ToolContext;

	it("visível: grava, agenda o job atrasado e mostra o marcador \"Volto às HH:MM\"", async () => {
		const { store, rows } = fakeStore();
		const own = deps();
		const result = await executeScheduleReturn({ inMinutes: 210, reason: "ver se o deploy terminou", visible: true }, ctx(own), store);
		expect(own.scheduleReturn).toHaveBeenCalledWith({ userId: "user-a", returnId: "ret0", delayMs: 210 * 60_000 });
		expect(result.returnEvent).toMatchObject({ type: "return_scheduled", returnId: "ret0", label: "Volto às 12:30", status: "pending" });
		expect(rows[0]).toMatchObject({ visible: true, reason: "ver se o deploy terminou" });
	});

	it("invisível: sem marcador (só posta se houver novidade)", async () => {
		const { store } = fakeStore();
		const result = await executeScheduleReturn({ inMinutes: 30, reason: "ver o pedido" }, ctx(), store);
		expect(result.returnEvent).toBeUndefined();
		expect(result.summary).toContain("post only if there is news");
	});

	it("limites: 3 pendentes por conversa, 1 min a 7 dias, sem filas = erro honesto", async () => {
		await expect(executeScheduleReturn({ inMinutes: 30, reason: "x" }, ctx(), fakeStore(3).store)).rejects.toThrow(/3 pending returns/);
		await expect(executeScheduleReturn({ inMinutes: 0.5, reason: "x" }, ctx(), fakeStore().store)).rejects.toThrow(/at least 1 minute/);
		await expect(executeScheduleReturn({ inMinutes: 60 * 24 * 8, reason: "x" }, ctx(), fakeStore().store)).rejects.toThrow(/routine/);
		await expect(executeScheduleReturn({ inMinutes: 5, reason: "x" }, { ...ctx(), ownerWait: undefined } as unknown as ToolContext, fakeStore().store)).rejects.toThrow(/not available/);
	});

	it("fila fora do ar: erro honesto e a linha não fica pendente (não ocupa vaga nem dispara)", async () => {
		const { store, rows } = fakeStore();
		const own = { ...deps(), scheduleReturn: vi.fn(async () => { throw new Error("redis down"); }) };
		await expect(executeScheduleReturn({ inMinutes: 30, reason: "x" }, ctx(own), store)).rejects.toThrow(/Nothing was scheduled/);
		expect(rows[0]!.status).toBe("cancelled");
	});

	it("cancelar remove o retorno e o job; outro usuário não cancela", async () => {
		const { store, rows } = fakeStore();
		const own = deps();
		await executeScheduleReturn({ inMinutes: 30, reason: "x", visible: true }, ctx(own), store);
		await expect(executeCancelReturn({ returnId: "ret0" }, ctx(own, "user-b"), store)).rejects.toThrow(/No pending return/);
		expect(rows[0]!.status).toBe("pending");
		const cancelled = await executeCancelReturn({ returnId: "ret0" }, ctx(own), store);
		expect(rows[0]!.status).toBe("cancelled");
		expect(own.cancelReturn).toHaveBeenCalledWith("ret0");
		expect(cancelled.returnEvent).toMatchObject({ status: "cancelled" });
	});

	it("só o v3 oferece, e só com as filas; v1/v2 seguem sem a tool", async () => {
		expect(COMPUTER_USE_TOOLS.map((tool) => tool.function.name)).not.toContain("schedule_return");
		const offered = (requests: CompleteChatWithToolsParams[]) => [...(requests[0]!.tools ?? []).map((tool) => tool.function.name), textOf(requests[0]!)].join(" ");
		const without = await runV3([say("oi")]);
		expect(offered(without.requests)).not.toContain("schedule_return");
		const withDeps = await runV3([say("oi")], { ownerWait: deps() });
		expect(offered(withDeps.requests)).toContain("schedule_return");
	});

	it("mensagem antes do horário: o modelo vê o retorno pendente e não agenda de novo", async () => {
		pendingReturns.push({ id: "ret9", dueAt: new Date("2026-11-04T15:00:00Z"), reason: "ver o deploy" });
		const { requests } = await runV3([say("O deploy ainda está rodando; volto às 12:00 como combinado.")], { ownerWait: deps(), messages: [{ role: "user", content: "e o deploy?" }] });
		expect(textOf(requests[0]!)).toContain("Pending scheduled returns in this conversation: 2026-11-04T15:00:00.000Z");
		expect(textOf(requests[0]!)).toContain("Do not schedule the same again");
	});
});
