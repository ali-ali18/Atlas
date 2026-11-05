import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MatrixSummary } from "./aggregate.js";
import { runMatrix } from "./run.js";
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

	it("teto rígido: para de agendar, marca skipped_budget, nunca passa do teto e ainda grava o relatório", async () => {
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
		expect(summary.spentUsd).toBeLessThanOrEqual(capUsd);
		// Parou de agendar: tudo que ficou depois da primeira pulada também foi pulado.
		const firstSkipped = runs.findIndex((item) => item.status === "skipped_budget");
		expect(runs.slice(firstSkipped).every((item) => item.status === "skipped_budget")).toBe(true);
		expect(await readFile(join(outDir, "matrix.md"), "utf8")).toContain("skipped_budget");
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

	it("chave que aparece num erro do provedor não chega ao relatório nem ao JSONL", async () => {
		const secret = "sk-ant-api03-SEGREDO-123456";
		const outDir = await tmp();
		const providers: MatrixProviders = {
			anthropic: async () => {
				throw new Error(`401 invalid x-api-key ${secret}`);
			},
			opencodeGo: async () => {
				throw new Error("boom");
			},
			openrouter: async () => {
				throw new Error("boom");
			},
		};
		const result = await runMatrix({ scenarios: scenarios.slice(0, 1), engines: ["v2"], models: ["anthropic/claude-haiku-5-5"], repeat: 1, mode: "real", capUsd: 5, env: { CLAUDE_KEY: secret }, providers, isStrong: strongMatcher(), outDir });
		expect(result.runs[0]!.status).toBe("done");
		expect(result.runs[0]!.pass).toBe(false);
		for (const file of ["matrix.md", "matrix.json", "runs.jsonl"]) expect(await readFile(join(outDir, file), "utf8")).not.toContain(secret);
	}, 60_000);
});
