import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { ENGINE_ADAPTERS } from "./engines.js";
import { runMatrix } from "./run.js";
import { loadScenarios, type Scenario } from "../scenario.js";
import { strongMatcher } from "../verdict.js";

/** `matrix --engines v4 --simulate`: o kernel `runAgent` (preset minimal) roda pelo pipeline do matrix, sem rede. */

const SCENARIOS_DIR = fileURLToPath(new URL("../../scenarios", import.meta.url));
let scenarios: Scenario[] = [];

beforeAll(async () => {
	const all = await loadScenarios(SCENARIOS_DIR, { recursive: true });
	scenarios = ["gold-economia-bom-dia", "arquivo-explicito-csv"].map((fragment) => all.find((s) => s.id.includes(fragment))!);
	expect(scenarios.every(Boolean)).toBe(true);
});

describe("matrix --engines v4 --simulate", () => {
	it("registra o adaptador v4 e marca o cenário com o motor v4", () => {
		const patched = ENGINE_ADAPTERS.v4!.patchScenario(scenarios[0]!);
		expect(patched.run.engine).toBe("v4");
	});

	it("roda 2 cenários pelo kernel: 'Bom dia' sem tools passa; o de arquivo roda create_file e termina", async () => {
		const result = await runMatrix({ scenarios, engines: ["v4"], models: ["anthropic/claude-sonnet-5-5"], repeat: 1, mode: "simulate", capUsd: 100, isStrong: strongMatcher(), concurrency: 1 });
		expect(result.runs).toHaveLength(2);
		expect(result.runs.every((run) => run.status === "done" && run.engine === "v4")).toBe(true);
		expect(result.runs.every((run) => run.error === undefined)).toBe(true);
		const bomDia = result.records.find((record) => record.scenarioId === scenarios[0]!.id)!;
		expect(bomDia.pass).toBe(true);
		expect(bomDia.trajectory.toolCalls).toHaveLength(0);
		expect(bomDia.trajectory.events.some((event) => event.type === "done")).toBe(true);
		const file = result.records.find((record) => record.scenarioId === scenarios[1]!.id)!;
		expect(file.trajectory.toolCalls.map((call) => call.name)).toContain("create_file");
		// O roteiro legado chama `create_file` com `filename`; o v4 só aceita `name`: falha honesta, o run segue e termina.
		expect(file.trajectory.toolResults.find((r) => r.name === "create_file")?.ok).toBe(false);
		expect(file.trajectory.events.some((event) => event.type === "done")).toBe(true);
		expect(result.summary.cells[scenarios[0]!.id]!.v4).toBeDefined();
	});

	it("com os argumentos do v4 (`name`), create_file grava pelo FileStore falso e emite o recibo", async () => {
		const original = scenarios[1]!;
		const turns = original.mock!.turns.map((turn) => ("calls" in turn ? { calls: turn.calls.map((c) => ({ name: c.name, args: { name: c.args.filename, content: c.args.content } })) } : turn));
		const v4Scenario: Scenario = { ...original, mock: { ...original.mock!, turns } };
		const result = await runMatrix({ scenarios: [v4Scenario], engines: ["v4"], models: ["anthropic/claude-sonnet-5-5"], mode: "simulate", capUsd: 100, isStrong: strongMatcher(), concurrency: 1 });
		const record = result.records[0]!;
		expect(record.trajectory.toolResults.find((r) => r.name === "create_file")?.ok).toBe(true);
		expect(record.trajectory.events.some((event) => event.type === "receipt")).toBe(true);
	});
});
