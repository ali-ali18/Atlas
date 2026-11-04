import { describe, expect, it } from "vitest";
import type { FixtureEvent } from "./fixtures.js";
import { BENCH_TASKS, refOf, taskById } from "./tasks.js";
import { ESTIMATE_MARGIN, estimateRealCost, formatBenchReport, schemaChars, summarize } from "./report.js";
import type { RunMetrics } from "./run.js";
import { assertKeysFor, claudeCallCostUsd, claudePriceFor, isClaudeDirect } from "./providers.js";
import { findChromium } from "./vm-harness.js";
import { runBrowserBench } from "./index.js";

const ev = (...types: Array<string | FixtureEvent>): FixtureEvent[] => types.map((item) => (typeof item === "string" ? { type: item } : item));
const check = (id: string, events: FixtureEvent[], finalText: string) => taskById(id)!.check({ events, finalText });

describe("bench do navegador: checagens determinísticas do estado final (cada uma sabe falhar)", () => {
	it("8 tarefas, ids únicos, cada uma com roteiro para os dois conjuntos de tools", () => {
		expect(BENCH_TASKS).toHaveLength(8);
		expect(new Set(BENCH_TASKS.map((task) => task.id)).size).toBe(8);
		for (const task of BENCH_TASKS) {
			expect(task.prompt.length, task.id).toBeGreaterThan(20);
			expect(typeof task.v3("http://x").next, task.id).toBe("function");
			expect(typeof task.legacy("http://x").next, task.id).toBe("function");
		}
	});

	it("chat: precisa enviar 1x, a resposta terminar e o código estar no texto final", () => {
		expect(check("chat-gemini", ev("chat_sent", "chat_done"), "O código é 4172").pass).toBe(true);
		expect(check("chat-gemini", ev("chat_sent"), "O código é 4172").pass).toBe(false); // respondeu antes de terminar
		expect(check("chat-gemini", ev("chat_sent", "chat_done"), "não sei").pass).toBe(false);
		expect(check("chat-gemini", ev("chat_sent", "chat_sent", "chat_done"), "4172").pass).toBe(false); // reenviou
	});

	it("compartilhar: 1x e sem apagar nada", () => {
		expect(check("share-menu", ev("shared"), "").pass).toBe(true);
		expect(check("share-menu", ev("shared", "deleted"), "").pass).toBe(false);
		expect(check("share-menu", ev(), "").pass).toBe(false);
	});

	it("login: nenhuma senha digitada, formulário não enviado e o bot avisa", () => {
		expect(check("login-sem-senha", ev(), "Preciso que você faça o login").pass).toBe(true);
		expect(check("login-sem-senha", ev({ type: "password_typed", length: 8 }), "Preciso da senha").pass).toBe(false);
		expect(check("login-sem-senha", ev("login_submit"), "Preciso da senha").pass).toBe(false);
		expect(check("login-sem-senha", ev(), "Tudo certo.").pass).toBe(false); // seguiu calado
	});

	it("cookies: preço mostrado, nunca aceitar", () => {
		expect(check("consent-cobrindo", ev("consent_rejected", "price_shown"), "R$ 27,90").pass).toBe(true);
		expect(check("consent-cobrindo", ev("consent_accepted", "price_shown"), "R$ 27,90").pass).toBe(false);
		expect(check("consent-cobrindo", ev("price_shown"), "não vi").pass).toBe(false);
	});

	it("lista, botão tardio, iframe e 300 links", () => {
		expect(check("lista-rolando", ev({ type: "bought", n: 55 }), "").pass).toBe(true);
		expect(check("lista-rolando", ev({ type: "bought", n: 5 }), "").pass).toBe(false);
		expect(check("botao-tardio", ev("downloaded"), "").pass).toBe(true);
		expect(check("botao-tardio", ev(), "").pass).toBe(false);
		expect(check("alvo-no-iframe", ev({ type: "coupon_applied", code: "PROMO10" }), "").pass).toBe(true);
		expect(check("alvo-no-iframe", ev({ type: "coupon_applied", code: "" }), "").pass).toBe(false);
		expect(check("300-links", ev("refund_opened"), "7 dias").pass).toBe(true);
		expect(check("300-links", ev("refund_opened"), "não sei").pass).toBe(false);
	});

	it("refOf acha o ref pelo papel e o nome, nos dois formatos (árvore e lista)", () => {
		expect(refOf('  textbox "Pergunte ao assistente" [a12]\n  button "Enviar mensagem" [a13]', "button", "Enviar")).toBe("a13");
		expect(refOf('[e7] link "Política de reembolso"', "link", "reembolso")).toBe("e7");
		expect(refOf('iframe\n  textbox "Código promocional" [f1a3]', "textbox", "promocional")).toBe("f1a3");
		expect(() => refOf('button "Outro" [a1]', "button", "Enviar")).toThrow(/não achei/);
	});
});

const run = (over: Partial<RunMetrics>): RunMetrics => ({ taskId: "chat-gemini", mode: "v3", model: "m", completed: true, detail: "ok", steps: 4, toolCalls: 4, toolErrors: 0, toolErrorSamples: [], silentClicks: 0, promptTokens: 1000, completionTokens: 100, costUsd: 0.01, durationMs: 1, finalText: "", ...over });

describe("bench do navegador: relatório, custo e provedor", () => {
	it("o conjunto v3 tem schema de até 5 mil caracteres e é menor que o das tools atuais", () => {
		expect(schemaChars("v3")).toBeLessThanOrEqual(5_000);
		expect(schemaChars("v3")).toBeLessThan(schemaChars("legacy"));
	});

	it("relatório e agregado: completou, passos, 'clicou e nada aconteceu', custo", () => {
		const runs = [run({}), run({ taskId: "share-menu", completed: false, silentClicks: 2, detail: "compartilhou 0x" }), run({ mode: "legacy", promptTokens: 3000 })];
		expect(summarize(runs.slice(0, 2))).toMatchObject({ runs: 2, completed: 1, silentClicks: 2, steps: 8 });
		const report = formatBenchReport(runs, { title: "T" });
		expect(report).toContain("v3 (4 tools)");
		expect(report).toContain("atuais (12 tools)");
		expect(report).toMatch(/share-menu \| m \| v3 \| FALHOU/);
	});

	it("estimativa: soma tokens por conjunto, aplica a margem e as repetições", () => {
		const runs = [run({ promptTokens: 1_000_000, completionTokens: 100_000, steps: 0 })];
		const cost = estimateRealCost(runs, { promptUsdPerMTok: 1, completionUsdPerMTok: 5 }, { modes: ["v3"], repeat: 2 });
		expect(cost).toBeCloseTo((1 + 0.5) * 2 * ESTIMATE_MARGIN, 6);
		expect(estimateRealCost(runs, { promptUsdPerMTok: 1, completionUsdPerMTok: 5 }, { modes: ["legacy"], repeat: 1 })).toBe(0);
	});

	it("provedor: claude-* é direto na Anthropic, anthropic/claude-* é OpenRouter; chave ausente falha antes de gastar; custo sai dos tokens", () => {
		expect(isClaudeDirect("claude-haiku-5-5")).toBe(true);
		expect(isClaudeDirect("anthropic/claude-sonnet-5-5")).toBe(false);
		expect(() => assertKeysFor(["claude-haiku-5-5"], {})).toThrow(/ANTHROPIC_API_KEY ou CLAUDE_KEY ou claude_key.*Nada foi executado/);
		expect(() => assertKeysFor(["claude-haiku-5-5"], { CLAUDE_KEY: "sk-ant-x" })).not.toThrow();
		expect(() => assertKeysFor(["claude-nao-existe-1"], { CLAUDE_KEY: "x" })).toThrow(/sem preço/);
		expect(() => assertKeysFor(["deepseek/deepseek-chat"], {})).toThrow(/OPENROUTER_API_KEY/);
		const price = claudePriceFor("claude-haiku-5-5");
		expect(claudeCallCostUsd({ promptTokens: 50_000, completionTokens: 50_000 }, price)).toBeCloseTo(0.005 + 0.025, 6);
		expect(claudeCallCostUsd({ promptTokens: 50_000, completionTokens: 0, cachedTokens: 50_000 }, price)).toBeCloseTo(0.0005, 6);
	});

	it("o relatório não vaza a chave: nenhum campo guarda segredo", () => {
		expect(JSON.stringify(run({}))).not.toMatch(/sk-ant|CLAUDE_KEY/);
	});
});

// A rodada completa sobe o servidor de controle REAL da VM num Chromium local (sem Docker, sem rede). Sem Chromium na máquina, pula.
describe.skipIf(!findChromium())("bench do navegador: roteiro (mock) na VM de bancada", () => {
	it("as 8 tarefas passam nos dois conjuntos de tools, e as 4 do v3 gastam menos tokens de entrada", async () => {
		const { runs } = await runBrowserBench({ models: [], timeoutMs: 120_000 });
		expect(runs).toHaveLength(16);
		const failed = runs.filter((item) => !item.completed).map((item) => `${item.taskId}/${item.mode}: ${item.error ?? item.detail}`);
		expect(failed).toEqual([]);
		const v3 = summarize(runs.filter((item) => item.mode === "v3"));
		const legacy = summarize(runs.filter((item) => item.mode === "legacy"));
		expect(v3.promptTokens).toBeLessThan(legacy.promptTokens);
		expect(v3.toolCalls).toBeLessThanOrEqual(legacy.toolCalls);
	}, 600_000);
});

describe("bench do navegador: pedido real leva o endereço da página", () => {
	it("cada tarefa diz ao modelo onde está a página (sem isso o modelo real ficava em about:blank)", async () => {
		const { benchUserPrompt } = await import("./run.js");
		const { BENCH_TASKS } = await import("./tasks.js");
		for (const task of BENCH_TASKS) {
			const prompt = benchUserPrompt(task, "http://127.0.0.1:9999");
			expect(prompt.startsWith(task.prompt)).toBe(true);
			expect(prompt).toContain(`Página: http://127.0.0.1:9999${task.path}`);
		}
	});
});

describe("bench do navegador: o relatório diz por que cada tool falhou", () => {
	it("guarda tool, argumentos e erro numa linha cortada e sem segredo", async () => {
		const { toolErrorSample } = await import("./run.js");
		const call = { id: "c1", type: "function" as const, function: { name: "browser_act", arguments: `{"action":"click",\n"ref":"e99","x":"${"a".repeat(400)}"}` } };
		const sample = toolErrorSample(call, "ref e99 não existe na página.\nUse page_state.  Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789");
		expect(sample.startsWith('browser_act({"action":"click", "ref":"e99"')).toBe(true);
		expect(sample).toContain("→ ref e99 não existe na página. Use page_state.");
		expect(sample).not.toContain("\n");
		expect(sample).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
		expect(sample.length).toBeLessThan(560);
	});

	it("o relatório lista os erros por tarefa só quando houve erro", () => {
		const ok = run({});
		const failed = run({ mode: "v3", toolErrors: 1, toolErrorSamples: ["browser_act({}) → falta o campo action | aceitos: x"] });
		expect(formatBenchReport([ok], { title: "t" })).not.toContain("## Erros de tool");
		const text = formatBenchReport([ok, failed], { title: "t" });
		expect(text).toContain("## Erros de tool");
		expect(text).toContain("| chat-gemini | m | v3 | browser_act({}) → falta o campo action \\| aceitos: x |");
	});
});
