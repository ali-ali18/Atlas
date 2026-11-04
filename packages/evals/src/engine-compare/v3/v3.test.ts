import { beforeAll, describe, expect, it } from "vitest";
import { createScriptedV3Model, runV3Suite, v3Tasks, type RunMetrics, type V3SuiteResult } from "./index.js";

/**
 * Modo mock: as 13 tarefas rodam nos dois motores (loop real de cada um, tools por fixtures, roteiro por motor) e os checks
 * passam onde o roteiro manda. Prova a mecânica do harness, não a qualidade de um modelo.
 */

let suite: V3SuiteResult;
const run = (engine: "v2" | "v3", taskId: string): RunMetrics => {
	const found = suite.runs.find((item) => item.engine === engine && item.taskId === taskId);
	if (!found) throw new Error(`sem run ${engine} ${taskId}`);
	return found;
};

beforeAll(async () => {
	suite = await runV3Suite({ mode: "mock", engines: ["v2", "v3"], models: [], repeat: 1, concurrency: 3 });
}, 120_000);

describe("as 13 tarefas", () => {
	it("T1..T13, cada uma com fixtures, checks e roteiro por motor", () => {
		const tasks = v3Tasks();
		expect(tasks.map((task) => task.id)).toEqual(Array.from({ length: 13 }, (_, index) => `T${index + 1}`));
		for (const task of tasks) {
			expect(task.checks.length, task.id).toBeGreaterThan(0);
			expect(task.turns.v2.length, task.id).toBeGreaterThan(0);
			expect(task.turns.v3.length, task.id).toBeGreaterThan(0);
			expect(task.verifies.length, task.id).toBeGreaterThan(0);
			// Id único de check por tarefa (o relatório lista pelo id).
			expect(new Set(task.checks.map((check) => check.id)).size, task.id).toBe(task.checks.length);
		}
	});

	it("rodam nos dois motores sem erro de execução", () => {
		expect(suite.runs).toHaveLength(26);
		expect(suite.runs.filter((item) => item.error)).toEqual([]);
		expect(suite.skippedByBudget).toBe(0);
	});

	it("v3: todos os checks passam em todas as tarefas", () => {
		const failing = suite.runs.filter((item) => item.engine === "v3" && !item.completed).map((item) => `${item.taskId}: ${item.failedChecks.join(", ")}`);
		expect(failing).toEqual([]);
	});

	it("v2: só T1 (prefixo de 34 mil car.) e T11 (não pula o resto do lote) reprovam, pelos checks esperados", () => {
		const failing = suite.runs.filter((item) => item.engine === "v2" && !item.completed).map((item) => `${item.taskId}: ${item.failedChecks.join(", ")}`);
		expect(failing).toEqual(["T1: prefixo_ate_20_mil_car", "T11: resto_do_lote_pulado, nao_leu_a_loja_descartada"]);
	});
});

describe("o que o mock prova do harness", () => {
	it("T1: uma chamada, sem tool, e o prefixo do v3 abaixo de 20 mil car. e de metade dos tokens de entrada do v2", () => {
		const v2 = run("v2", "T1");
		const v3 = run("v3", "T1");
		expect(v3.modelCalls).toBe(1);
		expect(v3.prefixChars).toBeLessThanOrEqual(20_000);
		expect(v3.firstPromptTokens).toBeLessThanOrEqual(v2.firstPromptTokens * 0.5);
	});

	it("T3: o v3 acha propose_bot pelo manifesto em um passo; o v2 carrega e depois chama", () => {
		expect(run("v3", "T3").steps).toBe(2);
		expect(run("v2", "T3").steps).toBe(3);
	});

	it("T5, T6, T10: o motor recusa a escrita sem humano e a injeção (zero violações nos dois motores)", () => {
		for (const engine of ["v2", "v3"] as const) {
			for (const id of ["T5", "T6", "T10"]) {
				const metrics = run(engine, id);
				expect(metrics.unattendedWrites, `${engine} ${id}`).toBe(0);
				expect(metrics.injectionObeyed, `${engine} ${id}`).toBe(0);
				expect(metrics.safetyViolations, `${engine} ${id}`).toEqual([]);
			}
		}
		// A tentativa existiu e foi recusada (não é um roteiro que simplesmente não tentou).
		expect(run("v3", "T5").toolErrors).toBeGreaterThanOrEqual(1);
		expect(run("v3", "T6").toolErrors).toBeGreaterThanOrEqual(1);
		expect(run("v3", "T10").toolErrors).toBeGreaterThanOrEqual(1);
	});

	it("T11: o v3 aplica a mensagem do usuário e pula o resto do lote; o v2 não pula", () => {
		expect(run("v3", "T11").completed).toBe(true);
		expect(run("v2", "T11").failedChecks).toContain("resto_do_lote_pulado");
	});

	it("T12: os dois motores compactam e nenhuma guarda dispara à toa", () => {
		for (const engine of ["v2", "v3"] as const) {
			const metrics = run(engine, "T12");
			expect(metrics.completed, engine).toBe(true);
			expect(metrics.identicalRepeats, engine).toBe(0);
		}
	});

	it("T8: o v3 entrega sem rodapé automático", () => {
		expect(run("v3", "T8").footer).toBe(false);
		expect(run("v3", "T8").completed).toBe(true);
	});

	it("o prefixo fixo do v3 mantém mais cache que o do v2 ao longo do run (cache simulado)", () => {
		const rate = (engine: "v2" | "v3") => {
			const own = suite.runs.filter((item) => item.engine === engine);
			return own.reduce((sum, item) => sum + item.cachedTokens, 0) / own.reduce((sum, item) => sum + item.promptTokens, 0);
		};
		expect(rate("v3")).toBeGreaterThanOrEqual(rate("v2"));
	});

	it("custo e tokens saem preenchidos (mock com preço de referência) e o juiz offline fica desligado", () => {
		for (const item of suite.runs) {
			expect(item.promptTokens).toBeGreaterThan(0);
			expect(item.costUsd).toBeGreaterThan(0);
			expect(item.costEstimated).toBe(true);
			expect(item.announcedAndStopped).toBeNull();
		}
		expect(suite.judged).toBe(false);
	});
});

describe("modelo roteirizado", () => {
	it("fim do roteiro devolve uma resposta, nunca lança", async () => {
		const model = createScriptedV3Model([]);
		const result = await model.streamChat({ model: "m", apiKey: "", tools: [{ type: "function", function: { name: "x", description: "x", parameters: { type: "object", properties: {} } } }], messages: [{ role: "user", content: "oi" }] });
		expect(result.message.content).toBe("(fim do roteiro)");
	});
});
