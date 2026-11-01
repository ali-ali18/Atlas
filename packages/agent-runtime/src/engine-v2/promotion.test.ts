/**
 * Motor v2: promoção automática chat -> trabalho longo, sem teto em US$ por padrão, nunca pedir "continua" e não perguntar
 * no meio do trabalho. LLM mockado; o relógio é falso (só `Date`) para o chat "gastar" os 8 min do perfil.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SandboxManager } from "@workspace/sandbox";
import type { CompleteChatWithToolsResult, LlmToolCall } from "@workspace/llm";
import type { ComputerUseEvent } from "@workspace/shared";
import { SYSTEM_MESSAGES } from "@workspace/shared";
import type { PersistUserArtifactInput } from "@workspace/db";
import { runEngineV2, type EngineV2Options } from "./run.js";
import { DOCUMENT_BUDGET_NOTE, DOCUMENT_DELIVERY_NOTE, DOCUMENT_DONE_INSTRUCTION, documentMissingNote, stopReasonPhrase } from "./delivery.js";
import { ENGINE_V2_CORE, ENGINE_V2_PROMOTED_NOTE, ENGINE_V2_UNATTENDED, UNASKED_MIDWORK_NOTE, midWorkQuestion } from "./prompt.js";
import { RESERVE_GAPS_NOTE, RESERVE_WRITE_NOTE, WRAP_UP_NOTE, deliveryInstruction } from "./supervisor.js";
import { budgetStopFallbackText } from "../computer-use.js";

vi.mock("@workspace/db", async (original) => ({
	...(await original<typeof import("@workspace/db")>()),
	searchMemoryEntries: vi.fn(async () => []),
	getBotProfile: vi.fn(async () => ({ description: "Bot configurado." })),
	listBotSkills: vi.fn(async () => []),
	searchSkillVersions: vi.fn(async () => []),
	listRoutines: vi.fn(async () => []),
	persistConversationCardFromEvent: vi.fn(async () => undefined),
	upsertTaskListCard: vi.fn(async () => undefined),
	getConversationUntrustedAt: vi.fn(async () => null),
}));

let seq = 0;
const call = (name: string, args: Record<string, unknown> = {}): LlmToolCall => ({ id: `p${++seq}`, type: "function", function: { name, arguments: JSON.stringify(args) } });
const usageOf = (costUsd?: number) => (costUsd === undefined ? {} : { usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, costUsd } });
const turn = (calls: LlmToolCall[], costUsd?: number): CompleteChatWithToolsResult => ({ model: "m", message: { role: "assistant", content: null, tool_calls: calls }, finishReason: "tool_calls", ...usageOf(costUsd) });
const say = (content: string, costUsd?: number): CompleteChatWithToolsResult => ({ model: "m", message: { role: "assistant", content }, finishReason: "stop", ...usageOf(costUsd) });
const taskList = (items: Array<[string, "pending" | "in_progress" | "completed"]>) => call("update_task_list", { items: items.map(([content, status]) => ({ content, status })) });
const words = (n: number) => Array.from({ length: n }, (_, i) => `palavra${i}`).join(" ");

const COOKIE = "Abra o vídeo https://youtu.be/abc123, faça perguntas ao Gemini sobre ele, compare com Hermes, Dots e Grok Bot e monte um relatório";
/** Cada passo do modelo "gasta" 2,5 min de relógio ativo: o 4º passo cruza 80% dos 8 min do chat. */
const STEP_MS = 150_000;

type Seen = { toolNames: string[]; system: string; lastUser: string; transcript: string };

async function runChat(input: {
	messages?: Array<{ role: "user" | "assistant"; content: string }>;
	script: Array<CompleteChatWithToolsResult | ((seen: Seen) => CompleteChatWithToolsResult)>;
	options?: Partial<EngineV2Options>;
	stepMs?: number;
	extra?: Partial<Parameters<typeof runEngineV2>[0]>;
}) {
	const events: ComputerUseEvent[] = [];
	const seen: Seen[] = [];
	const persisted: PersistUserArtifactInput[] = [];
	const script = [...input.script];
	const onPromoted = vi.fn();
	const result = await runEngineV2(
		{
			manager: {} as unknown as SandboxManager,
			getSessionId: async () => "session-1",
			apiKey: "test",
			model: "m",
			runId: "run-promo",
			userId: "user-a",
			botId: "bot-a",
			conversationId: "conv-1",
			origin: "chat",
			humanTurn: true,
			messages: input.messages ?? [{ role: "user", content: COOKIE }],
			timeZone: "America/Sao_Paulo",
			onEvent: (event) => {
				events.push(event);
			},
			createFileDeps: {
				persist: vi.fn(async (item: PersistUserArtifactInput) => {
					persisted.push(item);
					return { id: `art-${persisted.length}`, kind: item.kind, meta: { ...(item.meta ?? {}), mime: item.mime, size: item.bytes.byteLength }, runId: item.runId ?? null, conversationId: item.conversationId ?? null, createdAt: new Date().toISOString() } as never;
				}),
				nextVersion: vi.fn(async () => 1),
				countRunFiles: vi.fn(async () => 0),
			},
			streamChat: async (params, handlers) => {
				vi.setSystemTime(Date.now() + (input.stepMs ?? STEP_MS));
				const last = [...params.messages].reverse().find((m) => m.role === "user");
				const snapshot: Seen = {
					toolNames: params.tools.map((tool) => tool.function.name),
					system: params.messages.filter((m) => m.role === "system").map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n"),
					lastUser: typeof last?.content === "string" ? last.content : JSON.stringify(last?.content ?? ""),
					transcript: JSON.stringify(params.messages.map((m) => m.content)),
				};
				seen.push(snapshot);
				const next = script.shift();
				if (!next) throw new Error("roteiro acabou");
				const reply = typeof next === "function" ? next(snapshot) : next;
				if (reply.message.content) handlers?.onDelta?.(reply.message.content);
				return reply;
			},
			...input.extra,
		},
		{ profile: "chat", promotable: true, onPromoted, ...input.options },
	);
	return { result, events, seen, persisted, onPromoted };
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date("2026-11-01T12:00:00Z"));
});
afterEach(() => vi.useRealTimers());

const research = (cost: number) => turn([call("memory_search", { query: "grok bot" })], cost);

describe("promoção automática chat -> trabalho longo (v2)", () => {
	it("caso real: várias tools estouram os 8 min e muito mais que US$ 0,25, o run vira trabalho longo, entrega o documento e não pede 'continua'", async () => {
		const run = await runChat({
			script: [
				research(2), research(2), research(2),
				// 4º passo: já promovido (lista e caderno disponíveis); o modelo planeja.
				(seen) => {
					expect(seen.toolNames).toEqual(expect.arrayContaining(["update_task_list", "notebook_write", "notebook_read", "create_file", "delegate"]));
					expect(seen.transcript).toContain("This task turned into long work");
					return turn([taskList([["Comparar", "in_progress"], ["Entregar", "pending"]])], 2);
				},
				turn([call("notebook_write", { title: "Hermes", excerpt: "agente open source", source: "https://example.com/hermes" })], 2),
				turn([taskList([["Comparar", "completed"], ["Entregar", "completed"]])], 2),
				say(`# Relatório\n\n${words(320)}`, 2),
				turn([call("create_file", { filename: "comparativo.md", content: `# Comparativo\n\n${words(320)}` })], 2),
				say("Relatório pronto: Hermes, Dots e Grok Bot comparados. Não deu para confirmar o preço do Dots.", 2),
			],
		});
		// Antes da promoção: chat puro, sem caderno nem delegate.
		for (const before of run.seen.slice(0, 3)) {
			for (const name of ["notebook_write", "notebook_read", "delegate"]) expect(before.toolNames).not.toContain(name);
			expect(before.transcript).not.toContain("This task turned into long work");
		}
		expect(run.onPromoted).toHaveBeenCalledTimes(1);
		expect(run.result.stop).toEqual({ reason: "answered" });
		expect(run.persisted).toHaveLength(1);
		expect(run.result.usage.costUsd).toBeGreaterThan(10);
		expect(run.result.text).toContain("Relatório pronto");
		expect(run.result.text).not.toMatch(/continu(a|ar|e)\b/i);
		expect(run.events.some((event) => event.type === "file")).toBe(true);
	});

	it("o tempo vira o do trabalho longo: 9 min de relógio não entregam mais depois da promoção", async () => {
		const run = await runChat({
			messages: [{ role: "user", content: "abra a página e resuma" }],
			script: [research(0.5), research(0.5), research(0.5), turn([taskList([["Resumir", "in_progress"]])], 0.5), research(0.5), turn([taskList([["Resumir", "completed"]])], 0.5), say("Feito.")],
		});
		expect(run.result.usage.costUsd).toBeGreaterThanOrEqual(3);
		expect(run.onPromoted).toHaveBeenCalledTimes(1);
		expect(run.result.stop).toEqual({ reason: "answered" });
	});

	it("sem humano (promotable falso): o limite de tempo do chat segue e o run entrega por tempo, sem promover", async () => {
		const run = await runChat({
			options: { promotable: false, onPromoted: undefined },
			script: [research(1), research(1), research(1), research(1), say("Entrega parcial: li a página; faltou comparar com o Grok Bot porque o tempo acabou.")],
		});
		expect(run.result.stop).toMatchObject({ reason: "budget_wall" });
		expect(run.onPromoted).not.toHaveBeenCalled();
		expect(run.result.text).not.toMatch(/continu(a|ar|e)\b/i);
	});

	it("sem teto de conta nem do bot, nada para por dinheiro: US$ 40 num chat que termina rápido", async () => {
		const run = await runChat({ script: [research(20), research(20), say("Pronto: li as duas fontes.", 0)], stepMs: 10_000 });
		expect(run.result.stop).toEqual({ reason: "answered" });
		expect(run.result.usage.costUsd).toBe(40);
		expect(run.onPromoted).not.toHaveBeenCalled();
	});

	it("com teto de conta explícito o run para e entrega com honestidade, sem convite para 'continua'", async () => {
		const run = await runChat({
			extra: { budget: { maxCostUsd: 0.25 } },
			stepMs: 10_000,
			script: [research(0.3), say("Entrega parcial: li uma fonte; o gasto máximo definido acabou antes de comparar.")],
		});
		expect(run.result.stop).toMatchObject({ reason: "budget_cost" });
		expect(run.result.text).toContain("gasto máximo");
		expect(run.result.text).not.toMatch(/continu(a|ar|e)\b/i);
		expect(run.onPromoted).not.toHaveBeenCalled();
	});

	it("o teto de conta explícito também vale depois da promoção (não é piso do chat)", async () => {
		const run = await runChat({
			extra: { budget: { maxCostUsd: 3 } },
			script: [research(0.5), research(0.5), research(0.5), research(0.5), turn([taskList([["Comparar", "in_progress"]])], 1.5), say("Entrega parcial: o gasto máximo acabou antes de fechar a comparação.")],
		});
		expect(run.onPromoted).toHaveBeenCalledTimes(1);
		expect(run.result.stop).toMatchObject({ reason: "budget_cost" });
	});

	it("gasto máximo do bot (trabalho longo) vale: entrega ao bater", async () => {
		const run = await runChat({
			options: { profile: "long_work", promotable: false, longWorkBudgetUsd: 0.5 },
			stepMs: 10_000,
			script: [turn([taskList([["Pesquisar", "in_progress"]])], 0.3), research(0.3), say("Entrega parcial: o gasto máximo da tarefa acabou.")],
		});
		expect(run.result.stop).toMatchObject({ reason: "budget_cost" });
	});

	it("trabalho longo sem nenhum teto não para por dinheiro (modelo caro)", async () => {
		const run = await runChat({
			options: { profile: "long_work", promotable: false },
			stepMs: 10_000,
			script: [turn([taskList([["Pesquisar", "in_progress"], ["Entregar", "pending"]])], 30), research(30), turn([taskList([["Pesquisar", "completed"], ["Entregar", "completed"]])], 30), say("Pronto.", 30)],
		});
		expect(run.result.stop).toEqual({ reason: "answered" });
		expect(run.result.usage.costUsd).toBe(120);
	});

	it("'Bom dia' no chat continua pequeno e sem caderno, delegate nem nota de promoção", async () => {
		const run = await runChat({ messages: [{ role: "user", content: "Bom dia" }], script: [say("Bom dia!")] });
		expect(run.seen[0]!.toolNames).not.toContain("notebook_write");
		expect(run.seen[0]!.toolNames).not.toContain("delegate");
		expect(run.seen[0]!.system).not.toContain("This task turned into long work");
		expect(run.onPromoted).not.toHaveBeenCalled();
	});
});

describe("perguntar só no começo (v2)", () => {
	const LONG = { profile: "long_work" as const, promotable: false };
	const OPEN = () => turn([taskList([["Pesquisar", "in_progress"], ["Entregar", "pending"]])], 0.01);
	const CLOSE = () => turn([taskList([["Pesquisar", "completed"], ["Entregar", "completed"]])], 0.01);
	const discards = (run: Awaited<ReturnType<typeof runChat>>) => run.events.filter((event) => event.type === "assistant_discard").map((event) => (event as { reason?: string }).reason);

	it("trabalho longo: resposta que é SÓ uma pergunta resolvível volta ao modelo uma vez, que segue sozinho", async () => {
		const run = await runChat({
			stepMs: 1_000,
			options: LONG,
			messages: [{ role: "user", content: "Pesquise o Grok Bot" }],
			script: [
				OPEN(), research(0.01), CLOSE(),
				say("Me diga se o Grok Bot é seu agente?"),
				(seen) => {
					expect(seen.lastUser).toContain("You were about to ask the user a question in the middle of the work");
					return turn([call("memory_search", { query: "grok bot agente" })], 0.01);
				},
				say("Assumi que o Grok Bot é um agente externo e comparei. Resultado: ..."),
			],
		});
		expect(run.result.text).toContain("Assumi que o Grok Bot");
		expect(discards(run)).toEqual(["unneeded_question"]);
	});

	it("chat com lista de tarefas aberta também é barrado", async () => {
		const run = await runChat({
			stepMs: 1_000,
			options: { promotable: false },
			messages: [{ role: "user", content: "Pesquise o Grok Bot" }],
			script: [OPEN(), say("Qual fonte você prefere?"), say("Usei a fonte oficial. Resultado: ...")],
		});
		expect(run.result.text).toContain("Usei a fonte oficial");
		expect(discards(run)).toEqual(["unneeded_question"]);
	});

	it("chat curto: resposta com ? depois de uma tool NÃO é descartada (oferta que fecha a entrega passa)", async () => {
		const run = await runChat({ stepMs: 1_000, options: { promotable: false }, messages: [{ role: "user", content: "Quanto está o dólar?" }], script: [research(0.01), say("Está R$ 5,10. Quer que eu monitore?")] });
		expect(run.result.text).toBe("Está R$ 5,10. Quer que eu monitore?");
		expect(discards(run)).toEqual([]);
		// Nem mesmo só a pergunta curta, em chat sem lista aberta.
		const only = await runChat({ stepMs: 1_000, options: { promotable: false }, messages: [{ role: "user", content: "Pesquise" }], script: [research(0.01), say("Qual fonte você prefere?")] });
		expect(only.result.text).toBe("Qual fonte você prefere?");
	});

	it("depois de falha de tool a pergunta de sim/não passa", async () => {
		const run = await runChat({ stepMs: 1_000, options: LONG, messages: [{ role: "user", content: "Pesquise" }], script: [OPEN(), CLOSE(), turn([call("ferramenta_que_nao_existe")], 0.01), say("Não consegui abrir a fonte. Uso a versão em cache?")] });
		expect(run.result.text).toBe("Não consegui abrir a fonte. Uso a versão em cache?");
		expect(discards(run)).toEqual([]);
	});

	it("o portão age uma vez só: a segunda pergunta passa", async () => {
		const run = await runChat({ stepMs: 1_000, options: LONG, messages: [{ role: "user", content: "Pesquise" }], script: [OPEN(), CLOSE(), say("Qual fonte você prefere?"), say("Ainda tenho uma dúvida: qual período?")] });
		expect(run.result.text).toBe("Ainda tenho uma dúvida: qual período?");
	});

	it("pergunta de algo irreversível, externo ou dinheiro não é barrada; nem pergunta antes de qualquer trabalho", async () => {
		const risky = await runChat({ stepMs: 1_000, options: LONG, messages: [{ role: "user", content: "Pesquise" }], script: [OPEN(), CLOSE(), say("Posso enviar o e-mail para o fornecedor agora?")] });
		expect(risky.result.text).toBe("Posso enviar o e-mail para o fornecedor agora?");
		const start = await runChat({ stepMs: 1_000, messages: [{ role: "user", content: "Faça um relatório" }], script: [say("Qual período você quer?")] });
		expect(start.result.text).toBe("Qual período você quer?");
	});

	it("midWorkQuestion: só a pergunta, curta e sem termo de risco", () => {
		expect(midWorkQuestion("Quer que eu detalhe mais algum ponto?")).toBe(true);
		expect(midWorkQuestion("Qual fonte você prefere? Posso usar a oficial?")).toBe(true);
		expect(midWorkQuestion("Está R$ 5,10. Quer que eu monitore?")).toBe(false);
		expect(midWorkQuestion("Posso apagar o arquivo antigo?")).toBe(false);
		expect(midWorkQuestion("Vou pagar o boleto agora, pode ser?")).toBe(false);
		expect(midWorkQuestion("Resultado pronto.")).toBe(false);
		expect(midWorkQuestion(`${words(80)} Quer mais?`)).toBe(false);
	});
});

describe("tempo da conta é teto duro; promoção sobrevive à falha de gravação", () => {
	it("conta com 5 min: o chat respeita o menor valor e a promoção não passa de 5 min", async () => {
		const run = await runChat({
			extra: { budget: { maxWallMs: 5 * 60_000 } },
			script: [research(0.01), research(0.01), say("Entrega parcial: o tempo máximo da conta acabou antes de comparar tudo.")],
		});
		expect(run.onPromoted).toHaveBeenCalledTimes(1);
		expect(run.result.stop).toMatchObject({ reason: "budget_wall" });
	});

	it("falha ao gravar a promoção é registrada e o run segue; a retomada reaplica pelo checkpoint", async () => {
		const failing = vi.fn(async () => {
			throw new Error("db fora");
		});
		const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const checkpoints: Array<{ promoted?: boolean }> = [];
		const first = await runChat({
			options: { onPromoted: failing },
			extra: { onCheckpoint: async (checkpoint) => void checkpoints.push(JSON.parse(JSON.stringify(checkpoint))) },
			script: [research(1), research(1), research(1), turn([taskList([["Comparar", "in_progress"]])], 1), turn([taskList([["Comparar", "completed"]])], 1), say("Pronto.", 1)],
		});
		expect(failing).toHaveBeenCalledTimes(1);
		expect(errors).toHaveBeenCalledWith("v2: could not record run promotion", "db fora");
		expect(first.result.stop).toEqual({ reason: "answered" });
		const mid = checkpoints.find((checkpoint) => checkpoint.promoted === true);
		expect(mid).toBeTruthy();
		// Retomada com o perfil ainda `chat` (a gravação falhou): reaplica a promoção, sem nota duplicada, e tenta gravar de novo.
		const retried = vi.fn();
		const resumed = await runChat({
			options: { onPromoted: retried },
			extra: { restoredCheckpoint: mid as never },
			script: [(seen) => {
				expect(seen.toolNames).toEqual(expect.arrayContaining(["notebook_write", "update_task_list"]));
				return turn([taskList([["Comparar", "completed"]])], 1);
			}, say("Pronto de novo.", 1)],
		});
		expect(retried).toHaveBeenCalledTimes(1);
		expect(resumed.result.stop).toEqual({ reason: "answered" });
		errors.mockRestore();
	});
});

describe("nunca pedir 'continua'", () => {
	const INVITE = /\b(mande|manda|envie|responda|diga|digite|escreva)\s+["“'«]?\s*(continu\w+)|\b(send|reply|type|say|write|answer)\s+["“'«]?\s*(continue|go on)\b|\b(responde|envía|escribe|di)\s+["“'«]?\s*continuar?\b|responda\s+["“'«]?continu/i;

	it("o prompt do v2 proíbe o convite; nenhum texto fixo do runtime o contém", () => {
		expect(ENGINE_V2_CORE.join("\n")).toMatch(/Never ask the user to send "continue"/);
		const texts: string[] = [
			...ENGINE_V2_UNATTENDED,
			ENGINE_V2_PROMOTED_NOTE,
			UNASKED_MIDWORK_NOTE,
			WRAP_UP_NOTE,
			RESERVE_GAPS_NOTE,
			RESERVE_WRITE_NOTE,
			DOCUMENT_BUDGET_NOTE,
			DOCUMENT_DELIVERY_NOTE,
			DOCUMENT_DONE_INSTRUCTION,
			...(["budget_cost", "budget_wall", "budget_steps", "loop_repeat"] as const).map(deliveryInstruction),
		];
		for (const language of ["pt-BR", "en-US", "es-ES"] as const) {
			texts.push(documentMissingNote(language), SYSTEM_MESSAGES[language].stopFallback("x"));
			for (const reason of ["budget_cost", "budget_wall", "budget_steps", "loop_repeat", "outro"]) texts.push(budgetStopFallbackText(stopReasonPhrase(reason, language), language));
		}
		for (const text of texts) expect(text, text).not.toMatch(INVITE);
		// Sem texto de limite de dinheiro para quem não configurou um.
		expect(stopReasonPhrase("budget_wall", "pt-BR")).not.toMatch(/custo|gasto|US\$/i);
	});
});
