/**
 * Motor v2, E1 (o contexto MANTÉM o trabalho): testes de integração do run de ponta a ponta, com LLM e tools mockados, sem rede
 * e com o relógio injetado. Casos: YouTube -> Gemini (as refs do passo 2 continuam inteiras no passo 8), pesquisa com 3 fontes,
 * 20 passos de navegador a 30% da janela e a compactação com resumo a 80% (sem erro).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SandboxManager } from "@workspace/sandbox";
import type { ChatTool, CompleteChatWithToolsParams, CompleteChatWithToolsResult, LlmMessage, LlmToolCall } from "@workspace/llm";
import type { AgentRunCheckpoint, ComputerUseEvent } from "@workspace/shared";
import { runEngineV2, type EngineV2Options } from "./run.js";
import { estimateMessagesTokens } from "../hygiene.js";
import { CONTEXT_WINDOW_NOTE } from "./context-keep.js";
import { FakeTable, installFakes } from "@workspace/db/testing";
import { dbSkillsStore, resetSkillRunGuardForTests } from "../tools/skills.js";

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
	markConversationUntrusted: vi.fn(async () => undefined),
	markMcpTaskGrantsUntrusted: vi.fn(async () => undefined),
}));

// Nada de rede: busca e extração nativas são dublês determinísticos.
const extractContent: Record<string, string> = {};
vi.mock("../web-native.js", () => ({
	nativeWebSearch: vi.fn(async () => [
		{ title: "Fonte A", url: "https://a.example.com/p", snippet: "preço A", source: "mock" },
		{ title: "Fonte B", url: "https://b.example.com/p", snippet: "preço B", source: "mock" },
		{ title: "Fonte C", url: "https://c.example.com/p", snippet: "preço C", source: "mock" },
	]),
	nativeWebExtract: vi.fn(async ({ urls }: { urls: string[] }) =>
		urls.map((url) => ({ url, title: `Página ${url}`, fetchedAt: "2026-11-03T12:00:00Z", content: extractContent[url] ?? "sem conteúdo", truncated: false })),
	),
}));

let seq = 0;
const call = (name: string, args: Record<string, unknown> = {}): LlmToolCall => ({ id: `i${++seq}`, type: "function", function: { name, arguments: JSON.stringify(args) } });
const turn = (calls: LlmToolCall[]): CompleteChatWithToolsResult => ({ model: "m", message: { role: "assistant", content: null, tool_calls: calls }, finishReason: "tool_calls" });
const say = (content: string): CompleteChatWithToolsResult => ({ model: "m", message: { role: "assistant", content }, finishReason: "stop" });
const taskList = (items: Array<[string, "pending" | "in_progress" | "completed"]>) => call("update_task_list", { items: items.map(([content, status]) => ({ content, status })) });

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

const BAD_WORDS = /\b(budget|limit|time)\b/i;

type Seen = { messages: LlmMessage[]; toolNames: string[]; inputTokens: number; text: string; isSummary: boolean };

const textOf = (message: LlmMessage): string => (typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? ""));

async function runBrowser(input: {
	messages: Array<{ role: "user"; content: string }>;
	script: Array<CompleteChatWithToolsResult | ((seen: Seen) => CompleteChatWithToolsResult)>;
	manager?: Partial<Record<string, unknown>>;
	options?: Partial<EngineV2Options>;
	extra?: Partial<Parameters<typeof runEngineV2>[0]>;
}) {
	const events: ComputerUseEvent[] = [];
	const checkpoints: AgentRunCheckpoint[] = [];
	const seen: Seen[] = [];
	const script = [...input.script];
	let summaries = 0;
	const result = await runEngineV2(
		{
			manager: { ...input.manager } as unknown as SandboxManager,
			getSessionId: async () => "session-1",
			apiKey: "test",
			model: "m",
			runId: "run-ctx",
			userId: "user-a",
			botId: "bot-a",
			conversationId: "conv-1",
			origin: "chat",
			humanTurn: true,
			messages: input.messages,
			timeZone: "America/Sao_Paulo",
			persistScreenshot: async () => `art-${++seq}`,
			loadScreenshot: async () => `data:image/png;base64,${PNG.toString("base64")}`,
			onEvent: (event) => {
				events.push(event);
			},
			onCheckpoint: async (checkpoint) => {
				checkpoints.push(JSON.parse(JSON.stringify(checkpoint)) as AgentRunCheckpoint);
			},
			streamChat: async (params: CompleteChatWithToolsParams, handlers) => {
				const isSummary = params.tools.length === 0 && textOf(params.messages[1] ?? ({} as LlmMessage)).includes("<conversation_to_summarize>");
				const snapshot: Seen = {
					messages: params.messages,
					toolNames: params.tools.map((tool: ChatTool) => tool.function.name),
					inputTokens: estimateMessagesTokens(params.messages, JSON.stringify(params.tools).length),
					text: params.messages.map(textOf).join("\n"),
					isSummary,
				};
				seen.push(snapshot);
				if (isSummary) {
					summaries += 1;
					return say("Resumo do trabalho até aqui: abri o painel, li várias páginas e anotei os achados principais para continuar de onde parou.");
				}
				const next = script.shift();
				if (!next) throw new Error("roteiro acabou");
				const reply = typeof next === "function" ? next(snapshot) : next;
				if (reply.message.content) handlers?.onDelta?.(reply.message.content);
				return reply;
			},
			...input.extra,
		},
		{ profile: "chat", promotable: false, ...input.options },
	);
	return { result, events, checkpoints, seen, steps: seen.filter((item) => !item.isSummary), summaries: () => summaries };
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date("2026-11-03T12:00:00Z"));
});
afterEach(() => {
	vi.useRealTimers();
	delete process.env.ATLAS_ENGINE_V2_CONTEXT_KEEP;
});

const YOUTUBE_REFS = "Resultados do YouTube\n[e12] link: Vídeo: Como o agente Hermes funciona (12:41)\n[e13] link: Vídeo: Dots vs Grok Bot (08:02)\n[e14] botão: Pular anúncio";
const readResult = (url: string, title: string, text: string) => ({ url, title, text, view: "text", totalLength: text.length, offset: 0, truncated: false, frames: 1, collapsed: 0 });

/** Roteiro do pedido real: YouTube -> Gemini, sem campo de senha na página. */
function geminiManager() {
	let page: "youtube" | "gemini" | "answer" = "youtube";
	return {
		execNavigate: async (_s: string, url: string) => ({ url, title: page === "youtube" ? "YouTube" : "Gemini", ready: true }),
		execBrowserSnapshot: async () => ({
			url: "https://www.youtube.com/results",
			title: "YouTube",
			lines: [
				'e12 link "Vídeo: Como o agente Hermes funciona (12:41)"',
				'e13 link "Vídeo: Dots vs Grok Bot (08:02)"',
				...Array.from({ length: 12 }, (_, index) => `e${20 + index} link "Outro vídeo sugerido número ${index} com título longo para encher o resultado do passo 2"`),
				'e14 button "Pular anúncio"',
			],
			offset: 0,
			total: 15,
			nextOffset: null,
		}),
		execBrowserRead: async () => {
			if (page === "gemini") return readResult("https://gemini.google.com/app", "Gemini", "Gemini\nOlá! Como posso ajudar?\n[e1] botão: Continue with Google\n[e2] campo: Pergunte ao Gemini");
			if (page === "answer") return readResult("https://gemini.google.com/app", "Gemini", "Resposta do Gemini: o vídeo mostra que o Hermes é um agente de código aberto; Dots e Grok Bot são concorrentes diretos.");
			return readResult("https://www.youtube.com/results", "YouTube", YOUTUBE_REFS);
		},
		execBrowserAct: async (_s: string, input: { ref: string; action: string }) => {
			if (input.action === "click") page = "gemini";
			else page = "answer";
			return { action: input.action, ref: input.ref, url: "https://gemini.google.com/app" };
		},
	};
}

function geminiScript(onStep8: (seen: Seen) => void) {
	return [
		turn([call("mcp_tool_search", { query: "browser" })]),
		turn([call("navigate", { url: "https://www.youtube.com/results?search_query=hermes+agent" })]),
		turn([call("browser_snapshot", {})]),
		turn([call("browser_act", { ref: "e12", action: "click" })]),
		turn([call("navigate", { url: "https://gemini.google.com/app" })]),
		turn([call("browser_read", {})]),
		turn([call("browser_act", { ref: "e2", action: "type", value: "Resuma o vídeo e compare com Dots e Grok Bot", submit: true })]),
		(seen: Seen) => {
			onStep8(seen);
			return turn([call("browser_read", {})]);
		},
		say("Resumo do Gemini: o Hermes é de código aberto; Dots e Grok Bot são concorrentes diretos."),
	];
}

describe("integração E1: YouTube -> Gemini (replay do pedido real)", () => {
	it("sem troca de fase, sem notas com budget/limit/time, refs do passo 2 inteiras no passo 8, sem assistant_discard e resposta final visível", async () => {
		let step8: Seen | undefined;
		const run = await runBrowser({
			messages: [{ role: "user", content: "abra o YouTube, ache o vídeo do Hermes, peça o resumo ao Gemini e compare com Dots e Grok Bot" }],
			manager: geminiManager(),
			script: geminiScript((seen) => (step8 = seen)),
		});
		expect(run.result.stop).toEqual({ reason: "answered" });
		expect(run.result.text).toContain("Resumo do Gemini");
		expect(run.events.some((event) => event.type === "assistant_delta" && String(event.delta).includes("Resumo do Gemini"))).toBe(true);
		expect(run.events.some((event) => event.type === "assistant_discard")).toBe(false);
		// Catálogo estável: nenhuma tool some entre o primeiro passo com navegador e o último (nada de fase).
		const withBrowser = run.steps.filter((item) => item.toolNames.includes("browser_read"));
		expect(withBrowser.length).toBeGreaterThanOrEqual(6);
		expect(new Set(withBrowser.map((item) => item.toolNames.join(","))).size).toBeLessThanOrEqual(2);
		// Nenhuma nota do runtime fala em budget, limit ou time.
		const notes = run.steps
			.flatMap((item) => item.messages)
			.map(textOf)
			.flatMap((text) => (text.startsWith("[auto-context") ? [text] : text.includes("[Runtime note] ") ? [text.slice(text.indexOf("[Runtime note] "))] : []));
		for (const note of notes) expect(note, note).not.toMatch(BAD_WORDS);
		// No passo 8 as refs do passo 2 continuam INTEIRAS no que vai ao modelo (antes, a higiene as colapsava).
		expect(step8).toBeDefined();
		expect(step8!.text).toContain('e12 link "Vídeo: Como o agente Hermes funciona (12:41)"');
		expect(step8!.text).toContain('e14 button "Pular anúncio"');
		expect(step8!.text).not.toContain("[higiene: resultados de ferramentas anteriores colapsados");
		// O histórico canônico (checkpoint) também guarda o resultado inteiro.
		expect(JSON.stringify(run.checkpoints.at(-1)!.llmMessages)).toContain('e12 link \\"Vídeo: Como o agente Hermes funciona (12:41)\\"');
	});

	it("custo de entrada por passo: o E1 mantém o trabalho (resultados inteiros) e ATLAS_ENGINE_V2_CONTEXT_KEEP=off volta ao colapso antigo", async () => {
		const measure = async () => {
			let step8: Seen | undefined;
			const run = await runBrowser({ messages: [{ role: "user", content: "abra o YouTube e o Gemini" }], manager: geminiManager(), script: geminiScript((seen) => (step8 = seen)) });
			return { tokens: run.steps.map((item) => item.inputTokens), step8: step8!, run };
		};
		const on = await measure();
		process.env.ATLAS_ENGINE_V2_CONTEXT_KEEP = "off";
		const off = await measure();
		// Pelo menos uma resposta do E1 traz as refs do passo 2 e a do modo antigo não.
		expect(on.step8.text).toContain('e12 link "Vídeo: Como o agente Hermes funciona (12:41)"');
		expect(off.step8.text).not.toContain('e14 button "Pular anúncio"');
		expect(on.step8.text).toContain('e14 button "Pular anúncio"');
		// Medida para o relatório: tokens de entrada por passo (E1 ligado x desligado).
		process.stdout.write(`[custo por passo] ligado=${JSON.stringify(on.tokens)} desligado=${JSON.stringify(off.tokens)}` + "\n");
		expect(on.tokens.length).toBe(off.tokens.length);
		expect(on.run.result.stop).toEqual({ reason: "answered" });
		expect(off.run.result.stop).toEqual({ reason: "answered" });
	});
});

describe("integração E1: pesquisa com 3 fontes", () => {
	it("web_search -> 3 web_extract em paralelo -> notebook_write -> resposta: resultados inteiros, ninguém força create_file, até 8 passos", async () => {
		const urls = ["https://a.example.com/p", "https://b.example.com/p", "https://c.example.com/p"];
		const bodies = urls.map((url, index) => `Conteúdo da fonte ${"ABC"[index]}: ${"preço detalhado ".repeat(120)}FIM-${"ABC"[index]}`);
		urls.forEach((url, index) => (extractContent[url] = bodies[index]!));
		let beforeAnswer: Seen | undefined;
		const run = await runBrowser({
			messages: [{ role: "user", content: "Compare o preço do produto nas fontes A, B e C" }],
			options: { profile: "long_work", promotable: false },
			script: [
				turn([taskList([["Buscar", "in_progress"], ["Ler as fontes", "pending"], ["Responder", "pending"]])]),
				turn([call("web_search", { query: "preço do produto" })]),
				turn(urls.map((url) => call("web_extract", { urls: [url] }))),
				turn([call("notebook_write", { title: "Preços", excerpt: "A, B e C comparados", source: urls[0] })]),
				turn([taskList([["Buscar", "completed"], ["Ler as fontes", "completed"], ["Responder", "completed"]])]),
				(seen) => {
					beforeAnswer = seen;
					return say("A fonte A é a mais barata; B e C ficam acima.");
				},
			],
		});
		expect(run.result.stop).toEqual({ reason: "answered" });
		expect(run.steps.length).toBeLessThanOrEqual(8);
		// Os 3 resultados chegam inteiros ao passo da resposta.
		for (const marker of ["FIM-A", "FIM-B", "FIM-C"]) expect(beforeAnswer!.text, marker).toContain(marker);
		expect(beforeAnswer!.text).not.toContain("[higiene: resultados de ferramentas anteriores colapsados");
		// Ninguém força create_file e o texto não é o de uma parada por teto.
		expect(run.steps.every((item) => !item.text.includes("Call it now with the deliverable"))).toBe(true);
		expect(run.events.some((event) => event.type === "tool_call" && event.name === "create_file")).toBe(false);
		expect(run.result.text).not.toMatch(/Parei porque atingi o limite|limite/i);
		expect(run.events.some((event) => event.type === "assistant_discard")).toBe(false);
	});
});

describe("integração E1: janela do modelo", () => {
	const bigRead = (n: number, chars: number) => `Página ${n}: ${"conteúdo da leitura do navegador ".repeat(Math.ceil(chars / 33))}`.slice(0, chars);

	function longBrowserRun(steps: number, charsPerStep: number, contextLength: number, withShots: boolean, extra: Partial<Parameters<typeof runEngineV2>[0]> = {}, finalSay = "Terminei.") {
		let n = 0;
		const manager = {
			execNavigate: async (_s: string, url: string) => ({ url, title: "Site", ready: true }),
			execBrowserRead: async () => readResult("https://site.example.com", "Site", bigRead(++n, charsPerStep)),
			execScreen: async () => ({ width: 1000, height: 800 }),
			execScreenshot: async () => PNG,
		};
		const script: Array<CompleteChatWithToolsResult | ((seen: Seen) => CompleteChatWithToolsResult)> = [turn([call("mcp_tool_search", { query: "browser" })])];
		for (let index = 0; index < steps; index += 1) {
			script.push(turn([call("browser_read", { offset: index })]));
			if (withShots) script.push(turn([call("screenshot", {})]));
		}
		script.push(say(finalSay));
		return runBrowser({ messages: [{ role: "user", content: "Leia o site inteiro" }], manager, script, extra: { contextLength, ...extra } });
	}

	it("20 passos de navegador a ~30% da janela: os 6 últimos grupos inteiros, o canônico não muda e vão no máximo 2 imagens", async () => {
		// 20 leituras x ~5.000 chars (~1.430 tokens) = ~29 mil tokens ~ 29% de uma janela de 100 mil tokens.
		const run = await longBrowserRun(20, 5_000, 100_000, true, { contextBudget: { targetTokens: 60_000, ceilingTokens: 80_000, summarize: true } });
		expect(run.result.stop).toEqual({ reason: "answered" });
		const last = run.steps.at(-1)!;
		// Os 6 últimos resultados de leitura estão inteiros no que vai ao modelo.
		const reads = last.messages.filter((message) => message.role === "tool" && textOf(message).includes("Página "));
		expect(reads.length).toBeGreaterThanOrEqual(6);
		for (const message of reads.slice(-6)) expect(textOf(message)).not.toContain("[higiene");
		// Sem pressão real de janela, NADA foi colapsado: o histórico canônico (checkpoint) guarda as 20 leituras inteiras.
		const canonical = JSON.stringify(run.checkpoints.at(-1)!.llmMessages);
		expect(canonical).not.toContain("[higiene: resultados de ferramentas anteriores colapsados");
		for (const n of [1, 10, 20]) expect(canonical).toContain(`Página ${n}: `);
		// No máximo 2 imagens no envio, apesar das 20 capturas.
		const images = last.messages.flatMap((message) => (Array.isArray(message.content) ? message.content : [])).filter((part) => part.type === "image_url" || part.type === "screenshot_ref");
		expect(images.length).toBeLessThanOrEqual(2);
		expect(images.length).toBeGreaterThan(0);
	});

	it("a 80% da janela compacta com resumo e NÃO lança erro; o histórico canônico recebe o resumo", async () => {
		// Janela de 60 mil tokens, teto do orçamento em 48 mil (80%): leituras de ~5.700 tokens cada passam do teto no 7o passo.
		const run = await longBrowserRun(9, 20_000, 60_000, false, { contextBudget: { targetTokens: 24_000, ceilingTokens: 48_000, summarize: true } }, "Resumo final do site.");
		expect(run.result.stop).toEqual({ reason: "answered" });
		expect(run.result.text).toBe("Resumo final do site.");
		expect(run.summaries()).toBeGreaterThanOrEqual(1);
		expect(run.events.some((event) => event.type === "context_compacted")).toBe(true);
		// Depois do resumo o envio encolhe e leva a nota do resumo; o aviso de janela (75%) foi dado uma vez.
		const afterSummary = run.steps.find((item) => item.text.includes("replaced by the summary below"));
		expect(afterSummary).toBeDefined();
		expect(JSON.stringify(run.checkpoints.at(-1)!.llmMessages)).toContain("replaced by the summary below");
		expect(run.events.some((event) => event.type === "error")).toBe(false);
	});

	it("perto de 75% da janela o modelo recebe UM aviso (sem falar em teto) e nada quebra mesmo sem resumo", async () => {
		const run = await longBrowserRun(8, 20_000, 60_000, false, { contextBudget: { targetTokens: 24_000, ceilingTokens: 48_000, summarize: false } }, "Pronto.");
		expect(run.result.stop).toEqual({ reason: "answered" });
		expect(run.summaries()).toBe(0);
		const warned = run.steps.filter((item) => item.text.includes(CONTEXT_WINDOW_NOTE));
		expect(warned.length).toBeGreaterThanOrEqual(1);
		expect(CONTEXT_WINDOW_NOTE).not.toMatch(BAD_WORDS);
		// Uma vez só: o aviso entra no histórico canônico uma única vez.
		expect(JSON.stringify(run.checkpoints.at(-1)!.llmMessages).split("Context notice").length - 1).toBe(1);
	});

	it("com ATLAS_ENGINE_V2_CONTEXT_KEEP=off o E1 desliga (sem resumo próprio nem manutenção do canônico)", async () => {
		process.env.ATLAS_ENGINE_V2_CONTEXT_KEEP = "off";
		const run = await longBrowserRun(9, 20_000, 60_000, false, { contextBudget: { targetTokens: 24_000, ceilingTokens: 48_000, summarize: true } }, "Fim.");
		expect(run.summaries()).toBe(0);
		expect(run.result.stop).toEqual({ reason: "answered" });
	});
});

/** E2/E3: ferramentas do navegador juntas e paradas indevidas (replay YouTube -> Gemini). */
describe("integração E2/E3: navegador completo, login só estrutural, cartão informativo não para", () => {
	const toolResults = (events: ComputerUseEvent[]) => events.flatMap((event) => (event.type === "tool_result" ? [{ name: event.name, ok: event.ok, summary: event.summary }] : []));
	const geminiLines = ['[e1] link "Sign in"', '[e2] button "Continue with Google"', '[e3] button "Continue with email"', '[e4] textbox "Pergunte ao Gemini"'];
	const geminiSnapshot = (lines: string[]) => async () => ({ url: "https://gemini.google.com/app", title: "Gemini", lines, offset: 0, total: lines.length, nextOffset: null });

	it("o clique sai sem 'Tool click was not loaded': click, type, key, scroll e browser_tabs já estão na lista do 1º passo", async () => {
		const execClick = vi.fn(async () => ({ ok: true }));
		const run = await runBrowser({
			messages: [{ role: "user", content: "abra o YouTube e clique no primeiro vídeo" }],
			manager: { ...geminiManager(), execClick },
			script: [turn([call("navigate", { url: "https://www.youtube.com" })]), turn([call("click", { x: 100, y: 200 })]), say("Cliquei no primeiro vídeo.")],
		});
		expect(run.result.stop).toEqual({ reason: "answered" });
		for (const name of ["click", "type", "key", "scroll", "browser_tabs"]) expect(run.steps[0]!.toolNames, name).toContain(name);
		const results = toolResults(run.events);
		expect(results.map((item) => item.name)).toEqual(["navigate", "click"]);
		expect(results.every((item) => item.ok && !/was not loaded/i.test(item.summary))).toBe(true);
		expect(execClick).toHaveBeenCalledTimes(1);
	});

	it("1ª tool de navegador sem pedido roteado: o grupo carrega inteiro (com click e abas) e o clique seguinte não perde passo; o catálogo não encolhe", async () => {
		const run = await runBrowser({
			messages: [{ role: "user", content: "Preciso de uma ajuda" }],
			manager: { ...geminiManager(), execClick: vi.fn(async () => ({ ok: true })) },
			script: [turn([call("navigate", { url: "https://www.youtube.com" })]), turn([call("navigate", { url: "https://www.youtube.com" })]), turn([call("click", { x: 1, y: 2 })]), say("Feito.")],
		});
		const results = toolResults(run.events);
		expect(results.map((item) => item.name)).toEqual(["navigate", "navigate", "click"]);
		expect(results[0]!.summary).toMatch(/was not loaded/i);
		expect(results[2]!.summary).not.toMatch(/was not loaded/i);
		expect(run.steps[1]!.toolNames).toEqual(expect.arrayContaining(["navigate", "click", "type", "key", "scroll", "browser_tabs"]));
		// Estável: tudo o que estava no passo anterior continua no seguinte.
		for (let at = 1; at < run.steps.length; at += 1) for (const name of run.steps[at - 1]!.toolNames) expect(run.steps[at]!.toolNames).toContain(name);
	});

	it("a página do Gemini com 'Continue with Google' e SEM senha não pausa: vira nota e o run responde", async () => {
		const onLoginRequired = vi.fn(async () => undefined);
		const run = await runBrowser({
			messages: [{ role: "user", content: "abra o Gemini e peça um resumo" }],
			manager: { execNavigate: async (_s: string, url: string) => ({ url, title: "Gemini", ready: true }), execBrowserSnapshot: geminiSnapshot(geminiLines) },
			script: [turn([call("navigate", { url: "https://gemini.google.com/app" })]), turn([call("browser_snapshot", {})]), say("O Gemini pede entrar; me diga se posso seguir sem conta.")],
			extra: { onLoginRequired },
		});
		expect(run.result.stop).toEqual({ reason: "answered" });
		expect(run.events.some((event) => event.type === "login")).toBe(false);
		expect(onLoginRequired).not.toHaveBeenCalled();
		const snapshot = toolResults(run.events).find((item) => item.name === "browser_snapshot");
		expect(snapshot?.ok).toBe(true);
		expect(snapshot?.summary).toContain("may need a login");
		expect(snapshot?.summary).not.toContain("LOGIN REQUIRED");
		expect(run.checkpoints.at(-1)?.pendingLogin).toBeUndefined();
	});

	it("uma página com campo de senha pausa e mostra o cartão de login", async () => {
		const events: ComputerUseEvent[] = [];
		const onLoginRequired = vi.fn(async () => undefined);
		const outcome = await runBrowser({
			messages: [{ role: "user", content: "abra o Gemini e peça um resumo" }],
			manager: {
				execNavigate: async (_s: string, url: string) => ({ url, title: "Gemini", ready: true }),
				execBrowserSnapshot: geminiSnapshot(['[e1] textbox "E-mail"', '[e2] textbox "Senha" (campo de senha: nunca preencha)', '[e3] button "Entrar"']),
			},
			script: [turn([call("navigate", { url: "https://gemini.google.com/app" })]), turn([call("browser_snapshot", {})]), say("não deve chegar aqui")],
			extra: { onLoginRequired, onEvent: (event: ComputerUseEvent) => void events.push(event) },
		}).then(
			() => undefined,
			(error: unknown) => error,
		);
		expect(outcome).toMatchObject({ name: "AgentRunPausedError" });
		expect(events.filter((event) => event.type === "login")).toMatchObject([{ site: "gemini.google.com", status: "pending" }]);
		expect(onLoginRequired).toHaveBeenCalledTimes(1);
	});

	it("browser_read em /acesso: a checagem estrutural acha o campo de senha e pausa; /docs/login sem formulário só vira nota", async () => {
		const readPage = (url: string, lines: string[]) => ({
			execNavigate: async (_s: string, target: string) => ({ url: target, title: "Página", ready: true }),
			execBrowserRead: async () => readResult(url, "Página", "Entre na sua conta"),
			execBrowserSnapshot: geminiSnapshot(lines),
		});
		const events: ComputerUseEvent[] = [];
		const paused = await runBrowser({
			messages: [{ role: "user", content: "abra o ERP e leia a página" }],
			manager: readPage("https://erp.test/acesso", ['[e1] textbox "Senha" (campo de senha: nunca preencha)']),
			script: [turn([call("browser_read", {})]), say("não deve chegar aqui")],
			extra: { onEvent: (event: ComputerUseEvent) => void events.push(event) },
		}).then(() => undefined, (error: unknown) => error);
		expect(paused).toMatchObject({ name: "AgentRunPausedError" });
		expect(events.filter((event) => event.type === "login")).toMatchObject([{ site: "erp.test", status: "pending" }]);

		const docs = await runBrowser({
			messages: [{ role: "user", content: "abra a documentação e leia" }],
			manager: readPage("https://app.test/docs/login", ['[e1] link "Índice"']),
			script: [turn([call("browser_read", {})]), say("Li a documentação.")],
		});
		expect(docs.result.stop).toEqual({ reason: "answered" });
		expect(docs.events.some((event) => event.type === "login")).toBe(false);
		expect(toolResults(docs.events)[0]?.summary).toContain("may need a login");
	});

	it("depois de um cartão de skill só informativo (criada sem desfazer) o run continua e termina com a resposta", async () => {
		resetSkillRunGuardForTests();
		const docs = new FakeTable([], () => ({ createdAt: new Date(), updatedAt: new Date(), revision: 1, enabled: true, status: "active", createdBy: "user", tools: [], botId: null }));
		const fakes = installFakes({ skillDoc: docs, skillRevision: new FakeTable(), bot: new FakeTable([{ id: "bot-a", ownerId: "user-a" }]) });
		// Sem id/revisão não há o que desfazer: o cartão sai como "criada", sem `learned` (antes, isso parava o run).
		const apply = vi.spyOn(dbSkillsStore, "apply").mockResolvedValue({} as Awaited<ReturnType<typeof dbSkillsStore.apply>>);
		try {
			const run = await runBrowser({
				messages: [{ role: "user", content: "crie uma skill que resume minhas reuniões em tópicos com decisões e próximos passos" }],
				script: [turn([call("propose_skill", { action: "create", name: "resumo-reunioes", description: "Resume reuniões em tópicos", body: "1. Ler\n2. Resumir" })]), say("Skill criada: resumo-reunioes.")],
				extra: { autonomy: { level: "autonomous", exceptions: [] } },
			});
			const card = run.events.find((event) => event.type === "skill");
			expect(card).toMatchObject({ type: "skill", action: "created" });
			expect((card as { learned?: boolean }).learned).not.toBe(true);
			expect(run.result.stop).toEqual({ reason: "answered" });
			expect(run.result.text).toContain("Skill criada");
		} finally {
			apply.mockRestore();
			fakes.restore();
		}
	});
});
