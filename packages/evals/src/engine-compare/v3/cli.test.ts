import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { main, parseCliArgs, v3ProgressLine } from "../../cli.js";
import type { StreamChat } from "../../mock-model.js";
import { evaluateVictory, createAnnounceStopJudge, createScriptedV3Model, estimateModel, formatV3Estimate, parseAnnounceStopAnswer, planningPrice, runV3Suite, runV3Task, selectTasks, tokensPerEngine, v3Tasks } from "./index.js";

/** CLI `motor-v2-vs-v3`: mock grátis, chaves só do ambiente (nunca impressas), estimativa de custo, teto de gasto e juiz opcional. */

const dirs: string[] = [];
afterAll(async () => {
	await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function capture(fn: () => Promise<unknown>): Promise<string> {
	const lines: string[] = [];
	const original = console.log;
	console.log = (...items: unknown[]) => void lines.push(items.join(" "));
	try {
		await fn();
	} finally {
		console.log = original;
	}
	return lines.join("\n");
}

describe("comando", () => {
	it("motor-v2-vs-v3 é um comando e as flags de ligar/desligar não engolem o próximo argumento", () => {
		const args = parseCliArgs(["motor-v2-vs-v3", "--mock", "--estimate", "--models", "claude-haiku-5-5,claude-sonnet-5-5", "--repeat", "2", "--max-cost", "8"]);
		expect(args.command).toBe("motor-v2-vs-v3");
		expect(args.flags.mock).toBe(true);
		expect(args.flags.estimate).toBe(true);
		expect(args.flags.models).toBe("claude-haiku-5-5,claude-sonnet-5-5");
		expect(args.flags["max-cost"]).toBe("8");
	});

	it("--mock grava report.md, results.json e runs.jsonl e sai 0 (a mecânica do v3 está verde)", async () => {
		const out = await mkdtemp(join(tmpdir(), "evals-v2v3-"));
		dirs.push(out);
		const printed = await capture(async () => expect(await main(["motor-v2-vs-v3", "--mock", "--only", "T1,T5", "--out", out])).toBe(0));
		expect(printed).toContain("Veredito");
		const report = await readFile(join(out, "report.md"), "utf8");
		expect(report).toContain("| T5 · Rotina só leitura");
		expect(report).toContain("Mecânica (mock)");
		const results = JSON.parse(await readFile(join(out, "results.json"), "utf8")) as { victory: { verdict: string }; runs: unknown[] };
		expect(results.runs).toHaveLength(4);
		expect(["vence", "perde", "perde-por-seguranca", "sem-dados"]).toContain(results.victory.verdict);
		expect((await readFile(join(out, "runs.jsonl"), "utf8")).trim().split("\n")).toHaveLength(4);
	}, 120_000);

	it("a chave do ambiente nunca vai para a saída nem para os arquivos", async () => {
		const out = await mkdtemp(join(tmpdir(), "evals-v2v3-"));
		dirs.push(out);
		const before = { a: process.env.ANTHROPIC_API_KEY, o: process.env.OPENROUTER_API_KEY };
		process.env.ANTHROPIC_API_KEY = "sk-ant-segredo-nao-imprimir";
		process.env.OPENROUTER_API_KEY = "sk-or-segredo-nao-imprimir";
		try {
			const printed = await capture(() => main(["motor-v2-vs-v3", "--mock", "--only", "T1", "--out", out]));
			const files = [printed, await readFile(join(out, "report.md"), "utf8"), await readFile(join(out, "results.json"), "utf8"), await readFile(join(out, "runs.jsonl"), "utf8")].join("\n");
			expect(files).not.toContain("segredo-nao-imprimir");
		} finally {
			for (const [key, value] of [["ANTHROPIC_API_KEY", before.a], ["OPENROUTER_API_KEY", before.o]] as const) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	}, 120_000);

	it("modo real sem --models, sem chave, com motor inválido, tarefa desconhecida ou juiz no mock falha antes de executar", async () => {
		await expect(main(["motor-v2-vs-v3"])).rejects.toThrow(/--models/);
		const saved = { a: process.env.ANTHROPIC_API_KEY, c: process.env.CLAUDE_KEY, d: process.env.claude_key };
		delete process.env.ANTHROPIC_API_KEY;
		delete process.env.CLAUDE_KEY;
		delete process.env.claude_key;
		try {
			await expect(main(["motor-v2-vs-v3", "--models", "claude-haiku-5-5", "--max-cost", "5"])).rejects.toThrow(/ANTHROPIC_API_KEY/);
		} finally {
			if (saved.a !== undefined) process.env.ANTHROPIC_API_KEY = saved.a;
			if (saved.c !== undefined) process.env.CLAUDE_KEY = saved.c;
			if (saved.d !== undefined) process.env.claude_key = saved.d;
		}
		await expect(main(["motor-v2-vs-v3", "--mock", "--engines", "v4"])).rejects.toThrow(/--engines/);
		await expect(main(["motor-v2-vs-v3", "--mock", "--only", "T99"])).rejects.toThrow(/desconhecida/);
		await expect(main(["motor-v2-vs-v3", "--mock", "--judge", "claude-haiku-5-5"])).rejects.toThrow(/--judge/);
	});

	it("números inválidos (vírgula, texto, zero, fracionário, flag sem valor) falham com erro, no mock e no real", async () => {
		for (const argv of [["--max-cost", "1,5"], ["--max-cost", "abc"], ["--max-cost", "0"], ["--max-cost"], ["--repeat", "0"], ["--repeat", "1.5"], ["--repeat", "abc"], ["--concurrency", "0"], ["--concurrency", "x"], ["--timeout", "0"]]) {
			await expect(main(["motor-v2-vs-v3", "--mock", "--only", "T1", ...argv]), argv.join(" ")).rejects.toThrow(/precisa de um/);
		}
		await expect(main(["motor-v2-vs-v3", "--estimate", "--repeat", "abc"])).rejects.toThrow(/--repeat/);
	});

	it("no modo real --max-cost é obrigatório (falha antes de gastar, mesmo com chave)", async () => {
		const saved = process.env.ANTHROPIC_API_KEY;
		process.env.ANTHROPIC_API_KEY = "sk-ant-segredo-nao-imprimir";
		try {
			await expect(main(["motor-v2-vs-v3", "--models", "claude-haiku-5-5"])).rejects.toThrow(/--max-cost é obrigatório/);
		} finally {
			if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
			else process.env.ANTHROPIC_API_KEY = saved;
		}
	});

	it("a linha de progresso por run passa pela redação de segredos", () => {
		const line = v3ProgressLine({ engine: "v3", model: "m", taskId: "T1", repeat: 0, completed: false, failedChecks: [], error: "401 invalid key sk-ant-segredo-nao-imprimir", modelCalls: 1, costKnown: true, costUsd: 0.1 }, ["sk-ant-segredo-nao-imprimir"]);
		expect(line).not.toContain("segredo-nao-imprimir");
		expect(line).toContain("T1");
		expect(v3ProgressLine({ engine: "v2", model: "m", taskId: "T2", repeat: 1, completed: true, failedChecks: [], error: null, modelCalls: 3, costKnown: false, costUsd: 0 }, [])).toContain("custo desconhecido");
	});

	it("--estimate imprime a estimativa (Haiku e Sonnet por padrão) sem chamar modelo nem gravar nada", async () => {
		const printed = await capture(async () => expect(await main(["motor-v2-vs-v3", "--estimate", "--repeat", "2"])).toBe(0));
		expect(printed).toContain("Estimativa de custo da rodada real");
		expect(printed).toContain("claude-haiku-5-5");
		expect(printed).toContain("claude-sonnet-5-5");
		expect(printed).toContain("Sugestão de teto");
		// Sem --repeat a estimativa usa o mesmo padrão da rodada real (3), não outro número.
		const defaultRepeat = await capture(() => main(["motor-v2-vs-v3", "--estimate"]));
		expect(defaultRepeat).toContain("3 repetição(ões)");
		await expect(main(["motor-v2-vs-v3", "--estimate", "--models", "claude-sem-preco"])).rejects.toThrow(/sem preço/);
	}, 120_000);
});

describe("estimativa", () => {
	it("o piso (roteiro) fica abaixo do esperado e o cache simulado só reduz", () => {
		const tokens = { v2: { runs: 13, steps: 70, promptTokens: 700_000, cachedTokens: 500_000, completionTokens: 3_000 }, v3: { runs: 13, steps: 60, promptTokens: 300_000, cachedTokens: 200_000, completionTokens: 2_500 } };
		const haiku = planningPrice("claude-haiku-5-5");
		const estimate = estimateModel(haiku, tokens, { engines: ["v2", "v3"], repeat: 2 });
		expect(estimate.floorUsd).toBeGreaterThan(0);
		expect(estimate.expectedUsd).toBeGreaterThan(estimate.floorUsd);
		expect(estimate.expectedWithCacheUsd).toBeLessThan(estimate.expectedUsd);
		// Dobra com a repetição e só o v3 custa menos que os dois.
		expect(estimateModel(haiku, tokens, { engines: ["v2", "v3"], repeat: 4 }).expectedUsd).toBeCloseTo(estimate.expectedUsd * 2, 6);
		expect(estimateModel(haiku, tokens, { engines: ["v3"], repeat: 2 }).expectedUsd).toBeLessThan(estimate.expectedUsd);
		const text = formatV3Estimate(tokens, { models: [haiku, planningPrice("claude-sonnet-5-5")], engines: ["v2", "v3"], repeat: 2, tasks: 13 });
		expect(text).toContain("| **Total** |");
	});

	it("tokens por motor somam os runs do mock", async () => {
		const probe = await runV3Suite({ mode: "mock", engines: ["v2", "v3"], models: [], repeat: 1, only: ["T1", "T9"] });
		const tokens = tokensPerEngine(probe.runs);
		expect(tokens.v2.runs).toBe(2);
		expect(tokens.v3.promptTokens).toBeGreaterThan(0);
		expect(tokens.v3.promptTokens).toBeLessThan(tokens.v2.promptTokens);
	}, 120_000);
});

describe("modo real (modelo injetado)", () => {
	const reply = (costUsd?: number): StreamChat => {
		const model = createScriptedV3Model([{ say: "Bom dia! Estou por aqui." }, { say: "Bom dia! Estou por aqui." }, { say: "Bom dia! Estou por aqui." }]).streamChat;
		return async (params, handlers) => {
			const result = await model(params, handlers);
			return costUsd === undefined ? result : { ...result, usage: { ...result.usage!, costUsd } };
		};
	};
	const t1 = () => selectTasks(["T1"])[0]!;

	it("custo informado pelo provedor vale; sem custo, o motor estima pelos tokens", async () => {
		const reported = await runV3Task(t1(), { engine: "v3", model: "claude-haiku-5-5", repeat: 0, mode: "real", streamChat: reply(0.0123) });
		expect(reported.metrics.model).toBe("claude-haiku-5-5");
		expect(reported.metrics.costUsd).toBeCloseTo(0.0123, 6);
		expect(reported.metrics.costEstimated).toBe(false);
		const estimated = await runV3Task(t1(), { engine: "v3", model: "claude-haiku-5-5", repeat: 0, mode: "real", streamChat: reply() });
		expect(estimated.metrics.costEstimated).toBe(true);
		expect(estimated.metrics.costUsd).toBeGreaterThan(0);
	});

	it("modo real sem streamChat falha", async () => {
		await expect(runV3Task(t1(), { engine: "v3", model: "m", repeat: 0, mode: "real" })).rejects.toThrow(/streamChat/);
	});

	it("o teto de gasto impede iniciar novas execuções", async () => {
		const result = await runV3Suite({ mode: "real", engines: ["v2", "v3"], models: ["claude-haiku-5-5"], repeat: 3, concurrency: 1, only: ["T1"], maxCostUsd: 0.5, streamChat: reply(1) });
		expect(result.runs).toHaveLength(1);
		expect(result.skippedByBudget).toBe(5);
		expect(result.spentUsd).toBeCloseTo(1, 6);
	}, 120_000);

	it("resposta cortada pelo limite de saída vira o empurrão `truncated` no v3 (contado por tipo)", async () => {
		const model = createScriptedV3Model([{ say: "Bom di", finishReason: "length" }, { say: "Bom dia! Estou por aqui." }]);
		const { metrics } = await runV3Task(t1(), { engine: "v3", model: "claude-haiku-5-5", repeat: 0, mode: "real", streamChat: model.streamChat });
		expect(metrics.nudges.truncated).toBe(1);
		expect(metrics.nudgeTotal).toBe(1);
		expect(metrics.modelCalls).toBe(2);
	});

	it("o juiz offline só roda quando passado e marca anuncia-e-para; custo do juiz entra no gasto", async () => {
		const judgeModel: StreamChat = async () => ({ model: "j", message: { role: "assistant", content: '{"announcedAndStopped": true, "reason": "disse que ia criar o arquivo"}' }, usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, costUsd: 0.002 } });
		const judge = createAnnounceStopJudge({ model: "claude-haiku-5-5", apiKey: "k", streamChat: judgeModel });
		const withJudge = await runV3Suite({ mode: "real", engines: ["v3"], models: ["claude-haiku-5-5"], repeat: 1, only: ["T1"], streamChat: reply(0.01), judge });
		expect(withJudge.runs[0]!.announcedAndStopped).toBe(true);
		expect(withJudge.judged).toBe(true);
		expect(withJudge.spentUsd).toBeCloseTo(0.012, 6);
		const without = await runV3Suite({ mode: "real", engines: ["v3"], models: ["claude-haiku-5-5"], repeat: 1, only: ["T1"], streamChat: reply(0.01) });
		expect(without.runs[0]!.announcedAndStopped).toBeNull();
	}, 120_000);

	it("o juiz lê o run como dado e entende só JSON válido", async () => {
		expect(parseAnnounceStopAnswer('texto {"announcedAndStopped": false, "reason": "entregou"} fim')).toEqual({ announcedAndStopped: false, reason: "entregou" });
		expect(() => parseAnnounceStopAnswer("sem json")).toThrow(/juiz/);
		expect(() => parseAnnounceStopAnswer('{"pass": true}')).toThrow(/announcedAndStopped/);
		let system = "";
		const spy: StreamChat = async (params) => {
			system = String(params.messages[0]?.content);
			return { model: "j", message: { role: "assistant", content: '{"announcedAndStopped": false, "reason": "ok"}' } };
		};
		await createAnnounceStopJudge({ model: "j", apiKey: "k", streamChat: spy })({ task: v3Tasks()[0]!, trajectory: (await runV3Task(t1(), { engine: "v3", model: "mock", repeat: 0, mode: "mock" })).trajectory });
		expect(system).toContain("untrusted data");
	}, 120_000);
});

describe("teto de gasto e custo desconhecido", () => {
	/** Cada chamada custa US$ 1 e demora um pouco, para as execuções se sobreporem como na rodada real. */
	const slow = (costUsd?: number): StreamChat => {
		return async (params, handlers) => {
			await new Promise((done) => setTimeout(done, 15));
			const result = await createScriptedV3Model([{ say: "Bom dia! Estou por aqui." }]).streamChat(params, handlers);
			return costUsd === undefined ? result : { ...result, usage: { ...result.usage!, costUsd } };
		};
	};

	it("reserva uma estimativa por execução antes de iniciar: concorrência 3 não estoura o teto", async () => {
		const result = await runV3Suite({ mode: "real", engines: ["v2", "v3"], models: ["claude-haiku-5-5"], repeat: 3, concurrency: 3, only: ["T1"], maxCostUsd: 2.5, reserveUsd: 1, streamChat: slow(1) });
		expect(result.spentUsd).toBeLessThanOrEqual(2.5);
		expect(result.runs.length).toBeLessThanOrEqual(2);
		expect(result.skippedByBudget).toBeGreaterThan(0);
		expect(result.complete).toBe(false);
	}, 120_000);

	it("sem reserva, o maior custo já visto vira a reserva (o teto não é furado em cascata)", async () => {
		const result = await runV3Suite({ mode: "real", engines: ["v2", "v3"], models: ["claude-haiku-5-5"], repeat: 4, concurrency: 1, only: ["T1"], maxCostUsd: 2.5, streamChat: slow(1) });
		expect(result.spentUsd).toBeLessThanOrEqual(2.5);
		expect(result.runs).toHaveLength(2);
	}, 120_000);

	it("rodada cortada pelo teto nunca dá vence: veredito sem dados", async () => {
		const result = await runV3Suite({ mode: "real", engines: ["v2", "v3"], models: ["claude-haiku-5-5"], repeat: 2, concurrency: 1, only: ["T1"], maxCostUsd: 1, streamChat: slow(1) });
		expect(result.complete).toBe(false);
		expect(evaluateVictory(result.runs, { isStrong: () => false, complete: result.complete }).verdict).toBe("sem-dados");
	}, 120_000);

	it("custo não informado e modelo sem preço: custo desconhecido (0), nunca o preço do Haiku", async () => {
		const model = (): StreamChat => async (params, handlers) => createScriptedV3Model([{ say: "Bom dia! Estou por aqui." }]).streamChat(params, handlers);
		const unknown = await runV3Task(selectTasks(["T1"])[0]!, { engine: "v3", model: "alguem/modelo-sem-preco", repeat: 0, mode: "real", streamChat: model() });
		expect(unknown.metrics.costKnown).toBe(false);
		expect(unknown.metrics.costUsd).toBe(0);
		const priced = await runV3Task(selectTasks(["T1"])[0]!, { engine: "v3", model: "claude-sonnet-5-5", repeat: 0, mode: "real", streamChat: model() });
		expect(priced.metrics.costKnown).toBe(true);
		// O preço do Sonnet (2/10) vale, não o do Haiku (0,1/0,5): 20x mais caro para os mesmos tokens.
		const haiku = await runV3Task(selectTasks(["T1"])[0]!, { engine: "v3", model: "claude-haiku-5-5", repeat: 0, mode: "real", streamChat: model() });
		expect(priced.metrics.costUsd / haiku.metrics.costUsd).toBeCloseTo(20, 1);
	}, 120_000);

	it("no mock o DATABASE_URL do ambiente do desenvolvedor não vaza para dentro da bateria", async () => {
		const saved = process.env.DATABASE_URL;
		process.env.DATABASE_URL = "postgresql://nao-usar@localhost:1/x";
		let seen: string | undefined = "não rodou";
		try {
			await runV3Suite({ mode: "mock", engines: ["v3"], models: [], repeat: 1, only: ["T1"], onRun: () => void (seen = process.env.DATABASE_URL) });
			expect(seen).toBeUndefined();
			expect(process.env.DATABASE_URL).toBe("postgresql://nao-usar@localhost:1/x");
		} finally {
			if (saved === undefined) delete process.env.DATABASE_URL;
			else process.env.DATABASE_URL = saved;
		}
	}, 120_000);
});
