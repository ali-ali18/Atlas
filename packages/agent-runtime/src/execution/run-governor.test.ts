import { describe, expect, it } from "vitest";
import { createExecutionLedger } from "./ledger.js";
import {
	budgetUsage,
	canExtendBudget,
	costCapMessage,
	costCapReached,
	decideReserve,
	DELIVERABLE_RESERVE_NOTE,
	DELIVERABLE_RESTRICT_NOTE,
	DELIVERABLE_STAGNATION_NOTE,
	jevCheckpointKey,
	onlyReadsRecently,
	shouldWrapUp,
} from "./run-governor.js";

describe("budgetUsage", () => {
	const base = { step: 0, hardCap: 300, elapsedMs: 0, maxWallMs: 30 * 60_000 };

	it("usa o MAIOR entre passos, tempo e custo", () => {
		expect(budgetUsage({ ...base, step: 150 }).fraction).toBeCloseTo(0.5);
		expect(budgetUsage({ ...base, step: 30, elapsedMs: 24 * 60_000 }).fraction).toBeCloseTo(0.8);
		expect(budgetUsage({ ...base, step: 30, costUsd: 0.2, maxCostUsd: 0.25 }).fraction).toBeCloseTo(0.8);
		const mixed = budgetUsage({ ...base, step: 60, elapsedMs: 3 * 60_000, costUsd: 0.125, maxCostUsd: 0.25 });
		expect(mixed.steps).toBeCloseTo(0.2);
		expect(mixed.cost).toBe(0.5);
		expect(mixed.fraction).toBe(0.5);
	});

	it("sem limite de custo ou de tempo, a dimensão não conta; custo ausente vale 0", () => {
		expect(budgetUsage({ ...base, step: 3, maxWallMs: 0, elapsedMs: 9e9, costUsd: 99 }).fraction).toBe(0.01);
		expect(budgetUsage({ ...base, maxCostUsd: 0.25 }).cost).toBe(0);
	});
});

describe("teto de custo", () => {
	it("para em 100% (inclusive) e nunca sem limite", () => {
		expect(costCapReached(0.24, 0.25)).toBe(false);
		expect(costCapReached(0.25, 0.25)).toBe(true);
		expect(costCapReached(9, undefined)).toBe(false);
		expect(costCapReached(undefined, 0.25)).toBe(false);
	});

	it("mensagem em pt-BR com o valor", () => {
		expect(costCapMessage(0.25)).toBe("custo máximo da execução atingido (US$ 0,25)");
		expect(costCapMessage(1)).toBe("custo máximo da execução atingido (US$ 1,00)");
	});
});

describe("decideReserve", () => {
	const pending = { deliverablePending: true, wrapUp: false };

	it("sem arquivo pendente nada muda, em qualquer fração", () => {
		expect(decideReserve({ fraction: 0.99, deliverablePending: false, wrapUp: true })).toEqual({ restrictTools: false, note: null });
	});

	it("80% avisa; 90% restringe às tools de arquivo e repete a instrução", () => {
		expect(decideReserve({ ...pending, fraction: 0.79 })).toEqual({ restrictTools: false, note: null });
		expect(decideReserve({ ...pending, fraction: 0.8 })).toEqual({ restrictTools: false, note: DELIVERABLE_RESERVE_NOTE });
		expect(decideReserve({ ...pending, fraction: 0.9 })).toEqual({ restrictTools: true, note: DELIVERABLE_RESTRICT_NOTE });
		expect(DELIVERABLE_RESERVE_NOTE).toContain("Produce the requested file now with what you have; note gaps inside the file.");
		expect(DELIVERABLE_RESTRICT_NOTE).toContain("Produce the requested file now with what you have; note gaps inside the file.");
	});

	it("o fechamento por estagnação restringe mesmo com orçamento sobrando", () => {
		expect(decideReserve({ fraction: 0.1, deliverablePending: true, wrapUp: true })).toEqual({
			restrictTools: true,
			note: DELIVERABLE_STAGNATION_NOTE,
		});
	});
});

describe("shouldWrapUp", () => {
	it("só depois do segundo aviso; sem arquivo, uma decisão a mais para atender o aviso", () => {
		expect(shouldWrapUp({ streak: 4, nudged: 1, deliverablePending: true })).toBe(false);
		expect(shouldWrapUp({ streak: 5, nudged: 2, deliverablePending: true })).toBe(true);
		expect(shouldWrapUp({ streak: 5, nudged: 2, deliverablePending: false })).toBe(false);
		expect(shouldWrapUp({ streak: 6, nudged: 2, deliverablePending: false })).toBe(true);
	});
});

describe("canExtendBudget", () => {
	it("estende só com novidade recente", () => {
		expect(canExtendBudget({ recentNovelty: 3, deliverablePending: false, onlyReads: true })).toBe(true);
		expect(canExtendBudget({ recentNovelty: 0, deliverablePending: false, onlyReads: false })).toBe(false);
	});

	it("arquivo pendente + só leituras nunca estende, mesmo com novidade", () => {
		expect(canExtendBudget({ recentNovelty: 9, deliverablePending: true, onlyReads: true })).toBe(false);
		expect(canExtendBudget({ recentNovelty: 9, deliverablePending: true, onlyReads: false })).toBe(true);
	});
});

describe("onlyReadsRecently", () => {
	const ok = (name: string) => ({ name, ok: true });
	const readsMcp = (name: string) => name === "mcp__data__dump";

	it("leituras (builtin ou MCP somente leitura) não são escrita", () => {
		expect(onlyReadsRecently([ok("web_search"), ok("artifact_read"), ok("mcp__data__dump")], readsMcp)).toBe(true);
	});

	it("uma escrita ok na janela desfaz; falha não conta como escrita; sai da janela com o tempo", () => {
		expect(onlyReadsRecently([ok("web_search"), ok("create_file")], readsMcp)).toBe(false);
		expect(onlyReadsRecently([ok("web_search"), { name: "create_file", ok: false }], readsMcp)).toBe(true);
		const old = [ok("create_file"), ...Array.from({ length: 12 }, () => ok("web_search"))];
		expect(onlyReadsRecently(old, readsMcp)).toBe(true);
	});
});

describe("jevCheckpointKey", () => {
	it("passou de 50 e a cada 50", () => {
		expect(jevCheckpointKey({ step: 49, streak: 0, nudged: 0 })).toBeNull();
		expect(jevCheckpointKey({ step: 50, streak: 0, nudged: 0 })).toBe("step:50");
		expect(jevCheckpointKey({ step: 51, streak: 0, nudged: 0 })).toBeNull();
		expect(jevCheckpointKey({ step: 100, streak: 0, nudged: 0 })).toBe("step:100");
	});

	it("2 decisões sem novidade e nenhum aviso ainda: uma chave estável por sequência", () => {
		expect(jevCheckpointKey({ step: 7, streak: 2, nudged: 0 })).toBe("streak:5");
		expect(jevCheckpointKey({ step: 7, streak: 3, nudged: 1 })).toBeNull();
		expect(jevCheckpointKey({ step: 7, streak: 2, nudged: 1 })).toBeNull();
	});
});

describe("ledger: janela recente e estagnação", () => {
	it("noveltyInLast só olha as últimas decisões", () => {
		const ledger = createExecutionLedger();
		const seen = (step: number, text: string) =>
			ledger.observe({ step, tool: "web_search", argKey: `k${step}`, resultText: text, ok: true });
		seen(0, "alpha beta gamma");
		ledger.endDecision(0);
		for (let step = 1; step <= 3; step += 1) {
			seen(step, "alpha beta gamma");
			ledger.endDecision(step);
		}
		expect(ledger.noveltyInLast(10)).toBe(1);
		expect(ledger.noveltyInLast(3)).toBe(0);
		expect(ledger.stagnation()).toEqual({ streak: 3, nudged: 1 });
	});
});
