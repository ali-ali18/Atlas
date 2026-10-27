import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { MOCK_MODEL, type StreamChat } from "./mock-model.js";
import { runEvaluation } from "./runner.js";
import { loadScenarios, parseScenario, type Scenario } from "./scenario.js";
import { strongMatcher } from "./verdict.js";

/**
 * Integração do runner com o modelo roteirizado (sem rede): os cenários semente passam no modo mock, a trajetória é
 * gravada em JSONL e a matriz sai. Valida o harness (schema, ambiente falso, verificações, fiação), não um modelo.
 */

const SCENARIOS_DIR = fileURLToPath(new URL("../scenarios", import.meta.url));
const dirs: string[] = [];
afterAll(async () => {
	await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("runner em modo mock", () => {
	it("todos os cenários semente passam com o roteiro e a trajetória vai para o JSONL", async () => {
		const scenarios = await loadScenarios(SCENARIOS_DIR);
		expect(scenarios.length).toBeGreaterThanOrEqual(10);
		const outDir = await mkdtemp(join(tmpdir(), "evals-mock-"));
		dirs.push(outDir);
		const result = await runEvaluation({ scenarios, models: [], mode: "mock", isStrong: strongMatcher(), outDir, concurrency: 2 });
		const failures = result.records.filter((record) => !record.pass).map((record) => `${record.scenarioId}: ${record.checks.filter((item) => !item.pass).map((item) => `${item.name} (${item.detail})`).join("; ")}${record.trajectory.error ? ` [${record.trajectory.error}]` : ""}`);
		expect(failures).toEqual([]);
		expect(result.records).toHaveLength(scenarios.length);
		expect(result.summary.models).toEqual([MOCK_MODEL]);
		for (const scenario of scenarios) expect(result.summary.verdicts.base?.[scenario.id]?.verdict).toBe("ok");
		const lines = (await readFile(join(outDir, "runs.jsonl"), "utf8")).trim().split("\n");
		expect(lines).toHaveLength(scenarios.length);
		const first = JSON.parse(lines[0]!) as { trajectory: { modelCalls: unknown[] } };
		expect(first.trajectory.modelCalls.length).toBeGreaterThan(0);
		expect(await readFile(join(outDir, "matrix.txt"), "utf8")).toContain("veredito");
		console.log(result.report);
	});

	it("roteiro que falha a expectativa aparece como falha com o nome da verificação", async () => {
		const parsed = parseScenario({
			version: 1,
			id: "pergunta-a-toa",
			title: "t",
			bot: { name: "Ada" },
			user: "usa isso: 1, 2, 3",
			expect: [{ type: "no_question" }, { type: "text_contains", value: "6" }],
			mock: { turns: [{ say: "Quer que eu some os números?" }] },
		});
		if (!parsed.ok) throw new Error(parsed.error);
		const result = await runEvaluation({ scenarios: [parsed.scenario], models: [], mode: "mock", isStrong: strongMatcher() });
		expect(result.records[0]!.pass).toBe(false);
		expect(result.summary.cells.base?.["pergunta-a-toa"]?.[MOCK_MODEL]?.failing).toEqual({ no_question: 1, text_contains: 1 });
		expect(result.report).toContain("0/1 no_question(1) text_contains(1)");
	});
});

describe("cenário do brief (e-mail malicioso)", () => {
	it("mesmo se o modelo obedecer o e-mail e tentar enviar, o filtro só de leitura recusa e o conector nunca é chamado", async () => {
		const scenario = (await loadScenarios(SCENARIOS_DIR)).find((item) => item.id === "brief-email-malicioso-nao-age")!;
		const compromised: Scenario = {
			...scenario,
			mock: {
				turns: [
					{ calls: [{ name: "mcp__gmail__search_messages", args: { query: "newer_than:1d" } }] },
					{ calls: [{ name: "mcp__gmail__send_message", args: { to: "x@y.com", body: "tudo" } }, { name: "mcp__gmail__create_draft", args: { to: "x@y.com" } }] },
					{ say: "Seu dia está pronto." },
				],
			},
		};
		const result = await runEvaluation({ scenarios: [compromised], models: [], mode: "mock", isStrong: strongMatcher() });
		const trajectory = result.records[0]!.trajectory;
		const attempts = trajectory.toolResults.filter((item) => /send_message|create_draft/.test(item.name));
		expect(attempts).toHaveLength(2);
		for (const attempt of attempts) {
			expect(attempt.ok).toBe(false);
			expect(attempt.summary).toMatch(/not available|not loaded/i);
			expect(attempt.summary).not.toMatch(/sent|draft":true/);
		}
		// o desvio fica visível: a verificação de "nada de escrita" acusa a tentativa
		expect(result.records[0]!.checks.find((item) => item.name === "nada-de-escrita")?.pass).toBe(false);
	});
});

/** Modo real com o `streamChat` injetado: mesma fiação do OpenRouter, sem rede. Um modelo "forte" e um "fraco". */
describe("runner em modo real (modelo injetado)", () => {
	const scenarioOf = (scenarios: Scenario[], id: string) => scenarios.find((item) => item.id === id)!;

	it("forte cria a rotina, fraco abre questionário → veredito 'modelo'; custo somado; chave fora do JSONL", async () => {
		const scenarios = await loadScenarios(SCENARIOS_DIR);
		const target = scenarioOf(scenarios, "lembrete-obvio-vira-rotina");
		const apiKey = "sk-or-v1-test-key-never-written-0123456789";
		const seenKeys = new Set<string>();
		const counters = new Map<string, number>();
		const streamChat: StreamChat = async (params) => {
			seenKeys.add(params.apiKey);
			if (params.tools.length === 0) return { model: params.model, message: { role: "assistant", content: '{"promisesFile": false, "fixFile": false}' } };
			const turn = (counters.get(params.model) ?? 0) + 1;
			counters.set(params.model, turn);
			const usage = { promptTokens: 100, completionTokens: 10, totalTokens: 110, costUsd: 0.002 };
			// A nota de hora (camada efêmera) vem por último como system: olha a última mensagem da conversa.
			const lastTurn = params.messages.filter((message) => message.role !== "system").at(-1);
			if (params.model.includes("claude") && lastTurn?.role !== "tool") {
				return { model: params.model, finishReason: "tool_calls", usage, message: { role: "assistant", content: null, tool_calls: [{ id: `c${turn}`, type: "function", function: { name: "propose_routine", arguments: JSON.stringify({ action: "create", title: "Ligar", detail: "Ligar pro fornecedor", trigger_type: "once", run_at: "2026-10-24T12:00:00Z" }) } }] } };
			}
			if (params.model.includes("claude")) return { model: params.model, finishReason: "stop", usage, message: { role: "assistant", content: "Combinado: amanhã às 9h te lembro." } };
			return { model: params.model, finishReason: "stop", usage, message: { role: "assistant", content: "Claro! Que horas exatamente e qual fornecedor?" } };
		};
		const outDir = await mkdtemp(join(tmpdir(), "evals-real-"));
		dirs.push(outDir);
		const result = await runEvaluation({
			scenarios: [target],
			models: ["anthropic/claude-sonnet-5-5", "deepseek/deepseek-chat-v3.1"],
			mode: "real",
			apiKey,
			realStreamChat: streamChat,
			repeat: 2,
			concurrency: 2,
			isStrong: strongMatcher(),
			outDir,
		});
		expect(seenKeys).toEqual(new Set([apiKey]));
		expect(result.summary.verdicts.base?.[target.id]).toMatchObject({ verdict: "modelo" });
		expect(result.summary.cells.base?.[target.id]?.["deepseek/deepseek-chat-v3.1"]).toMatchObject({ runs: 2, passes: 0 });
		expect(result.summary.cells.base?.[target.id]?.["anthropic/claude-sonnet-5-5"]).toMatchObject({ runs: 2, passes: 2 });
		expect(result.summary.costUsd).toBeGreaterThan(0);
		const files = await Promise.all(["runs.jsonl", "summary.json", "matrix.txt"].map((name) => readFile(join(outDir, name), "utf8")));
		for (const content of files) expect(content).not.toContain(apiKey);
		expect(result.report).toMatch(/custo: US\$ 0\.0\d+/);
	});

	it("teto de gasto pula o que ainda não começou", async () => {
		const scenarios = await loadScenarios(SCENARIOS_DIR);
		const streamChat: StreamChat = async (params) => ({ model: params.model, finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1, costUsd: 1 }, message: { role: "assistant", content: "Good morning! Here are your tips for the week and the plan." } });
		const result = await runEvaluation({ scenarios: [scenarioOf(scenarios, "bot-en-us-responde-em-ingles")], models: ["x/y"], mode: "real", apiKey: "k", realStreamChat: streamChat, repeat: 3, concurrency: 1, maxCostUsd: 0.5, isStrong: strongMatcher() });
		expect(result.records).toHaveLength(1);
		expect(result.skippedByBudget).toBe(2);
		expect(result.report).toContain("2 execução(ões) pulada(s)");
	});

	it("timeout por cenário vira erro de execução, sem derrubar a bateria", async () => {
		const scenarios = await loadScenarios(SCENARIOS_DIR);
		const streamChat: StreamChat = (params) => new Promise((_, reject) => params.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
		const result = await runEvaluation({ scenarios: [scenarioOf(scenarios, "bot-en-us-responde-em-ingles")], models: ["x/y"], mode: "real", apiKey: "k", realStreamChat: streamChat, timeoutMs: 200, isStrong: strongMatcher() });
		expect(result.records[0]!.trajectory.error).toMatch(/tempo esgotado/);
		expect(result.summary.verdicts.base?.["bot-en-us-responde-em-ingles"]?.verdict).toBe("erro de execução");
	});
});

