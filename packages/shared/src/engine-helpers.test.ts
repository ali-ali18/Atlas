import { describe, expect, it } from "vitest";
import { HELPER_MAX_TASKS_PER_CALL, HELPER_POOL_RATIO, parseHelperTasks, planHelperBudgets, readHelperPolicy } from "./engine-helpers.js";

describe("parseHelperTasks", () => {
	it("aceita objetivo, título e contexto", () => {
		expect(parseHelperTasks({ tasks: [{ title: "Forn A", goal: " ache o preço ", context: "SKU 1" }] })).toEqual({
			ok: true,
			tasks: [{ title: "Forn A", goal: "ache o preço", context: "SKU 1" }],
		});
	});
	it("recusa vazio, excesso, campo desconhecido e objetivo ausente", () => {
		expect(parseHelperTasks({ tasks: [] })).toMatchObject({ ok: false });
		expect(parseHelperTasks({})).toMatchObject({ ok: false });
		const many = Array.from({ length: HELPER_MAX_TASKS_PER_CALL + 1 }, () => ({ goal: "x" }));
		expect(parseHelperTasks({ tasks: many })).toMatchObject({ ok: false, error: expect.stringContaining("At most 12") });
		expect(parseHelperTasks({ tasks: [{ goal: "x", tools: ["web_search"] }] })).toMatchObject({ ok: false, error: expect.stringContaining("unknown field(s): tools") });
		expect(parseHelperTasks({ tasks: [{ title: "x" }] })).toMatchObject({ ok: false, error: expect.stringContaining("goal is required") });
		expect(parseHelperTasks({ tasks: [{ goal: "x" }], model: "a/b" })).toMatchObject({ ok: false, error: expect.stringContaining("Unknown field(s): model") });
	});
});

describe("planHelperBudgets", () => {
	it("a soma dos ajudantes nunca passa da fatia do que sobra ao pai", () => {
		for (const [count, parallel, usd, ms] of [[1, 4, 0.5, 20 * 60_000], [5, 4, 0.5, 20 * 60_000], [12, 4, 3, 60 * 60_000], [3, 8, 0.2, 5 * 60_000]] as const) {
			const plan = planHelperBudgets({ taskCount: count, maxParallel: parallel, remainingUsd: usd, remainingMs: ms });
			expect(plan.ok).toBe(true);
			if (!plan.ok) continue;
			expect(plan.perTask.costUsd * count).toBeLessThanOrEqual(usd * HELPER_POOL_RATIO + 1e-9);
			expect(plan.perTask.costUsd * count).toBeLessThan(usd);
			expect(plan.perTask.activeMs * plan.waves).toBeLessThanOrEqual(ms * HELPER_POOL_RATIO);
		}
	});
	it("5 tarefas com paralelo 4 = 2 levas, e o tempo de cada ajudante cabe nelas", () => {
		const plan = planHelperBudgets({ taskCount: 5, maxParallel: 4, remainingUsd: 0.5, remainingMs: 20 * 60_000 });
		expect(plan).toMatchObject({ ok: true, waves: 2 });
	});
	it("sem orçamento ou tempo suficiente = erro honesto", () => {
		expect(planHelperBudgets({ taskCount: 5, maxParallel: 4, remainingUsd: 0.05, remainingMs: 20 * 60_000 })).toMatchObject({ ok: false, reason: expect.stringContaining("not enough budget") });
		expect(planHelperBudgets({ taskCount: 2, maxParallel: 4, remainingUsd: 1, remainingMs: 20_000 })).toMatchObject({ ok: false, reason: expect.stringContaining("not enough time") });
	});
});

describe("readHelperPolicy", () => {
	it("padrão: mesmo modelo do bot e 4 em paralelo", () => {
		expect(readHelperPolicy(undefined)).toEqual({ helperModel: null, helperMaxParallel: 4 });
		expect(readHelperPolicy({ helperModel: 12, helperMaxParallel: "x" })).toEqual({ helperModel: null, helperMaxParallel: 4 });
	});
	it("lê o modelo barato e limita o paralelo", () => {
		expect(readHelperPolicy({ helperModel: " google/gemini-flash ", helperMaxParallel: 20 })).toEqual({ helperModel: "google/gemini-flash", helperMaxParallel: 8 });
		expect(readHelperPolicy({ helperModel: "bad model!", helperMaxParallel: 0 })).toEqual({ helperModel: null, helperMaxParallel: 1 });
	});
});
