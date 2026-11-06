import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MatrixSummary } from "./aggregate.js";
import { runMatrix } from "./run.js";
import { seededUnit, simulatedFailRate } from "./simulate.js";
import { resolveModelSpec } from "./models.js";
import type { MatrixProviders } from "./providers.js";
import { loadScenarios, type Scenario } from "../scenario.js";
import { strongMatcher } from "../verdict.js";

/** Matriz ponta a ponta com provedores falsos: roteamento, custo, teto, agregação e relatório, sem rede. */

const SCENARIOS_DIR = fileURLToPath(new URL("../../scenarios", import.meta.url));
const MODELS = ["anthropic/claude-sonnet-5-5", "opencode-go/qwen3.8-flash"];
const dirs: string[] = [];
let scenarios: Scenario[] = [];

beforeAll(async () => {
	const all = await loadScenarios(SCENARIOS_DIR, { recursive: true });
	scenarios = ["gold-agenda-lembrete-boleto-amanha-10h", "gold-email-resumo-24h"].map((id) => all.find((scenario) => scenario.id === id)!);
	expect(scenarios.every(Boolean)).toBe(true);
});
afterAll(async () => {
	await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Nenhum teste deste arquivo pode tocar a rede: `fetch` global lança, e o afterEach prova que ninguém o chamou (auditoria F0, T2). */
const fetchSpy = vi.fn(async () => {
	throw new Error("fetch real chamado em teste: sem rede");
});
beforeEach(() => {
	fetchSpy.mockClear();
	vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => {
	const calls = fetchSpy.mock.calls.length;
	vi.unstubAllGlobals();
	expect(calls, "nenhuma chamada real de fetch").toBe(0);
});

const tmp = async (): Promise<string> => {
	const dir = await mkdtemp(join(tmpdir(), "evals-matrix-"));
	dirs.push(dir);
	return dir;
};

describe("matrix --simulate", () => {
	it("2 cenários × 2 modelos × 2 motores × 2 repetições: roda tudo, agrega e grava o relatório", async () => {
		const outDir = await tmp();
		const result = await runMatrix({ scenarios, engines: ["v2", "v1"], models: MODELS, repeat: 2, mode: "simulate", capUsd: 100, isStrong: strongMatcher(), outDir, now: () => new Date("2026-11-05T12:00:00Z"), concurrency: 2 });
		const { summary } = result;
		expect(result.runs).toHaveLength(16);
		expect(result.runs.every((item) => item.status === "done")).toBe(true);
		expect(summary.budgetStopped).toBe(false);
		expect(summary.mode).toBe("simulate");
		expect(summary.spentUsd).toBeGreaterThan(0);
		expect(summary.spentUsd).toBeLessThanOrEqual(100);
		// Anthropic marca costUnknown (como o adaptador real) e o custo sai da tabela; Go idem com `plan`.
		expect(Object.keys(summary.byProvider).sort()).toEqual(["anthropic", "opencode-go"]);
		expect(summary.byProvider.anthropic!.runs).toBe(8);
		expect(summary.byProvider["opencode-go"]!.costUsd).toBeGreaterThan(0);
		expect(summary.costUnknown).toBe(false);
		// O forte simulado nunca erra no motor com roteiro (cada célula tem 2 repetições).
		for (const engine of ["v2", "v1"]) for (const scenario of scenarios) expect(summary.cells[scenario.id]![engine]![MODELS[0]!]!.runs).toBe(2);
		expect(summary.byCapability.agenda).toBeDefined();
		expect(summary.byCapability.email).toBeDefined();
		expect(summary.engineDeltas).toHaveLength(2);
		for (const scenario of scenarios) expect(Object.keys(summary.readings[scenario.id]!)).toEqual(["v2", "v1"]);
		const json = JSON.parse(await readFile(join(outDir, "matrix.json"), "utf8")) as { summary: MatrixSummary; runs: unknown[] };
		expect(json.runs).toHaveLength(16);
		expect(json.summary.createdAt).toBe("2026-11-05T12:00:00.000Z");
		const markdown = await readFile(join(outDir, "matrix.md"), "utf8");
		for (const section of ["## Por modelo", "## Por provedor", "## Por capacidade", "## Leitura: harness ou modelo?", "## Detalhe por cenário"]) expect(markdown).toContain(section);
		expect((await readFile(join(outDir, "runs.jsonl"), "utf8")).trim().split("\n")).toHaveLength(16);
	}, 120_000);

	it("é determinístico: duas rodadas dão os mesmos acertos e os mesmos custos", async () => {
		const options = { scenarios, engines: ["v2"], models: MODELS, repeat: 3, mode: "simulate" as const, isStrong: strongMatcher() };
		const first = await runMatrix(options);
		const second = await runMatrix(options);
		const key = (items: typeof first.runs) => items.map((item) => `${item.scenarioId}|${item.model}|${item.repeat}|${item.pass}|${item.costUsd.toFixed(8)}`);
		expect(key(first.runs)).toEqual(key(second.runs));
	}, 120_000);

	it("teto: pula o que não cabe, marca skipped_budget e ainda grava o relatório", async () => {
		const outDir = await tmp();
		const all = await runMatrix({ scenarios, engines: ["v2", "v1"], models: MODELS, repeat: 3, mode: "simulate", isStrong: strongMatcher() });
		// Metade do gasto de uma rodada completa: dá para rodar parte e cortar o resto.
		const capUsd = all.summary.spentUsd * 0.5;
		expect(capUsd).toBeGreaterThan(Math.max(...all.runs.map((item) => item.estimatedUsd)));
		const result = await runMatrix({ scenarios, engines: ["v2", "v1"], models: MODELS, repeat: 3, mode: "simulate", capUsd, isStrong: strongMatcher(), outDir, concurrency: 2 });
		const { summary, runs } = result;
		const skipped = runs.filter((item) => item.status === "skipped_budget");
		const done = runs.filter((item) => item.status === "done");
		expect(runs).toHaveLength(24);
		expect(skipped.length).toBeGreaterThan(0);
		expect(done.length).toBeGreaterThan(0);
		expect(summary.budgetStopped).toBe(true);
		expect(summary.skippedBudget).toBe(skipped.length);
		// O teto vale pelo gasto real: passa, no máximo, pelas chamadas em andamento (aqui, uma execução inteira é um limite folgado).
		expect(summary.spentUsd).toBeLessThanOrEqual(capUsd + 2 * Math.max(...all.runs.map((item) => item.costUsd)));
		expect(summary.stoppedBudget + summary.skippedBudget).toBeGreaterThan(0);
		// Pulou só o que não cabia: a execução pulada tinha estimativa maior que o que sobrava do teto.
		for (const item of skipped) expect(item.estimatedUsd).toBeGreaterThan(0);
		expect(await readFile(join(outDir, "matrix.md"), "utf8")).toContain("skipped_budget");
	}, 120_000);

	it("o stub de fetch está ativo: uma chamada real seria vista e falharia (auditoria F0, T2)", async () => {
		await expect(fetch("https://example.test/")).rejects.toThrow(/sem rede/);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		fetchSpy.mockClear();
	});

	it("falhas simuladas são determinísticas: o barato falha ao menos uma vez, o forte nunca, e a execução degradada reprova (auditoria F0, T1)", async () => {
		const cheap = MODELS[1]!;
		const strong = MODELS[0]!;
		const options = { scenarios, engines: ["v2"], models: [strong, cheap], repeat: 8, mode: "simulate" as const, isStrong: strongMatcher() };
		const first = await runMatrix(options);
		const second = await runMatrix(options);
		const outcome = (items: typeof first.runs) => items.map((item) => `${item.scenarioId}|${item.model}|${item.repeat}|${item.pass}|${item.failedChecks.join("+")}`);
		expect(outcome(first.runs)).toEqual(outcome(second.runs));
		// A sorteio é função pura de (modelo, cenário, motor, repetição) e da taxa do modelo.
		expect(simulatedFailRate(resolveModelSpec(strong))).toBe(0);
		expect(simulatedFailRate(resolveModelSpec(cheap))).toBe(0.35);
		expect(seededUnit("a|b|c|0")).toBe(seededUnit("a|b|c|0"));
		expect(seededUnit("a|b|c|0")).not.toBe(seededUnit("a|b|c|1"));
		const degradedExpected = (run: (typeof first.runs)[number]) => seededUnit(`${run.model}|${run.scenarioId}|${run.engine}|${run.repeat}`) < simulatedFailRate(resolveModelSpec(run.model));
		const strongRuns = first.runs.filter((run) => run.model === strong);
		const cheapRuns = first.runs.filter((run) => run.model === cheap);
		expect(strongRuns.every((run) => run.pass && run.failedChecks.length === 0)).toBe(true);
		// o forte nunca sorteia falha; o barato sorteia (e o conjunto sorteado bate com o resultado)
		expect(strongRuns.some(degradedExpected)).toBe(false);
		const degraded = cheapRuns.filter(degradedExpected);
		expect(degraded.length).toBeGreaterThan(0);
		expect(degraded.length).toBeLessThan(cheapRuns.length);
		// execução degradada (responde sem tools): reprova e diz quais verificações falharam
		for (const run of degraded) {
			expect(run.pass, `${run.scenarioId} #${run.repeat}`).toBe(false);
			expect(run.failedChecks.length).toBeGreaterThan(0);
		}
		// as não sorteadas rodam o roteiro inteiro e passam
		for (const run of cheapRuns.filter((item) => !degradedExpected(item))) expect(run.pass, `${run.scenarioId} #${run.repeat}`).toBe(true);
		// a falha entra na leitura e no acerto agregado
		expect(first.summary.byModel.v2![cheap]!.passes).toBe(cheapRuns.length - degraded.length);
		expect(first.summary.byModel.v2![strong]!.passes).toBe(strongRuns.length);
	}, 120_000);

	it("modelo repetido em --models conta uma vez só (auditoria F0, B7)", async () => {
		const result = await runMatrix({ scenarios: scenarios.slice(0, 1), engines: ["v2"], models: [MODELS[0]!, MODELS[1]!, MODELS[0]!, ` ${MODELS[1]!} `], repeat: 1, mode: "simulate", isStrong: strongMatcher() });
		expect(result.runs).toHaveLength(2);
		expect(result.summary.models).toEqual(MODELS);
		expect(result.summary.byModel.v2![MODELS[0]!]!.runs).toBe(1);
	});

	it("teto menor que a primeira estimativa: nada roda e o relatório sai mesmo assim", async () => {
		const result = await runMatrix({ scenarios, engines: ["v2"], models: MODELS, repeat: 1, mode: "simulate", capUsd: 0.000001, isStrong: strongMatcher() });
		expect(result.runs.every((item) => item.status === "skipped_budget")).toBe(true);
		expect(result.summary.spentUsd).toBe(0);
		expect(result.markdown).toContain("Teto atingido");
	});
});

describe("matrix real com provedores injetados", () => {
	it("sem a chave de algum provedor falha antes de qualquer execução, sem vazar valores", async () => {
		let called = 0;
		const providers: MatrixProviders = { anthropic: (async () => (called++, undefined)) as never, opencodeGo: (async () => (called++, undefined)) as never, openrouter: (async () => (called++, undefined)) as never };
		await expect(runMatrix({ scenarios, engines: ["v2"], models: MODELS, repeat: 1, mode: "real", capUsd: 1, env: { CLAUDE_KEY: "sk-ant-secret-value" }, providers, isStrong: strongMatcher() })).rejects.toThrow(/OPENCODE_GO_API_KEY/);
		await expect(runMatrix({ scenarios, engines: ["v2"], models: MODELS, repeat: 1, mode: "real", capUsd: 1, env: { CLAUDE_KEY: "sk-ant-secret-value" }, providers, isStrong: strongMatcher() })).rejects.not.toThrow(/sk-ant-secret-value/);
		expect(called).toBe(0);
	});

	it("o modo real exige --max-usd", async () => {
		await expect(runMatrix({ scenarios, engines: ["v2"], models: MODELS, mode: "real", env: { CLAUDE_KEY: "a", OPENCODE_GO_API_KEY: "b" }, isStrong: strongMatcher() })).rejects.toThrow(/max-usd/);
	});

	it("timeout do runtime e erro HTTP do provedor saem tipados (errorKind), cada um no seu contador (auditoria F0, C1)", async () => {
		const timeoutError = () => new DOMException("First event or idle timeout", "TimeoutError");
		const providers: MatrixProviders = {
			anthropic: async () => {
				throw timeoutError();
			},
			opencodeGo: async () => {
				throw new Error("OpenCode Go está indisponível no momento (HTTP 429).");
			},
			openrouter: async () => {
				throw new Error("boom");
			},
		};
		const result = await runMatrix({ scenarios: scenarios.slice(0, 1), engines: ["v2"], models: MODELS, repeat: 1, mode: "real", capUsd: 5, env: { CLAUDE_KEY: "k1", OPENCODE_GO_API_KEY: "k2" }, providers, isStrong: strongMatcher() });
		const byModel = Object.fromEntries(result.runs.map((item) => [item.model, item.errorKind]));
		expect(byModel).toEqual({ [MODELS[0]!]: "runtime_timeout", [MODELS[1]!]: "provider" });
		expect(result.summary.byModel.v2![MODELS[0]!]!.errorKinds).toEqual({ runtime_timeout: 1, provider: 0 });
		expect(result.summary.byModel.v2![MODELS[1]!]!.errorKinds).toEqual({ runtime_timeout: 0, provider: 1 });
		expect(result.markdown).toContain("**Corte de tempo do runtime:** 1 em");
	}, 60_000);

	it("duas chaves diferentes que aparecem em erros dos provedores (e do juiz) não chegam ao relatório, ao JSON nem ao JSONL (auditoria F0, T5)", async () => {
		const secrets = { anthropic: "sk-ant-api03-SEGREDO-ANTHROPIC-123456", go: "go-token-SEGREDO-OPENCODE-654321" };
		const outDir = await tmp();
		const providers: MatrixProviders = {
			anthropic: async () => {
				throw new Error(`401 invalid x-api-key ${secrets.anthropic}`);
			},
			opencodeGo: async () => {
				// o erro do Go cita as DUAS chaves (ex.: proxy que ecoa os cabeçalhos)
				throw new Error(`403 forbidden for ${secrets.go} (also saw ${secrets.anthropic})`);
			},
			openrouter: async () => {
				throw new Error("boom");
			},
		};
		const result = await runMatrix({
			scenarios: scenarios.slice(0, 1),
			engines: ["v2"],
			models: ["anthropic/claude-haiku-5-5", "opencode-go/qwen3.8-flash"],
			repeat: 1,
			mode: "real",
			capUsd: 5,
			env: { CLAUDE_KEY: secrets.anthropic, OPENCODE_GO_API_KEY: secrets.go },
			providers,
			isStrong: strongMatcher(),
			outDir,
		});
		expect(result.runs.map((run) => run.status)).toEqual(["done", "done"]);
		expect(result.runs.every((run) => run.error)).toBe(true);
		for (const file of ["matrix.md", "matrix.json", "runs.jsonl"]) {
			const content = await readFile(join(outDir, file), "utf8");
			for (const secret of Object.values(secrets)) expect(content, `${file} vazou ${secret.slice(0, 12)}`).not.toContain(secret);
		}
		expect(result.markdown).not.toContain(secrets.go);
		expect(JSON.stringify(result.runs)).not.toContain(secrets.anthropic);
	}, 60_000);
});
