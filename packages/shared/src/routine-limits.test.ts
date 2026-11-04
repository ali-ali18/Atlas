import { describe, expect, it } from "vitest";
import {
	applyRoutineLimitsPatch,
	formatRoutineLimitsSummary,
	parseRoutineLimitsInput,
	parseStepLimitWait,
	parseStoredRoutineLimits,
	stepLimitCardText,
} from "./routine-limits.js";

describe("limites da rotina", () => {
	it("aceita passos e US$ na faixa, null volta ao padrão", () => {
		expect(parseRoutineLimitsInput({ maxSteps: 60, maxCostUsd: 0.5 })).toEqual({ ok: true, patch: { maxSteps: 60, maxCostUsd: 0.5 } });
		expect(parseRoutineLimitsInput({ maxSteps: null })).toEqual({ ok: true, patch: { maxSteps: null } });
		expect(parseRoutineLimitsInput(null)).toEqual({ ok: true, patch: null });
		expect(parseRoutineLimitsInput({})).toEqual({ ok: true, patch: {} });
		// Centavos: arredonda para 2 casas.
		expect(parseRoutineLimitsInput({ maxCostUsd: 0.123 })).toEqual({ ok: true, patch: { maxCostUsd: 0.12 } });
	});

	it("limites da faixa: 5 e 200 passos, US$ 0,01 e 50", () => {
		expect(parseRoutineLimitsInput({ maxSteps: 5 }).ok).toBe(true);
		expect(parseRoutineLimitsInput({ maxSteps: 200 }).ok).toBe(true);
		expect(parseRoutineLimitsInput({ maxSteps: 4 }).ok).toBe(false);
		expect(parseRoutineLimitsInput({ maxSteps: 201 }).ok).toBe(false);
		expect(parseRoutineLimitsInput({ maxSteps: 10.5 }).ok).toBe(false);
		expect(parseRoutineLimitsInput({ maxSteps: "40" }).ok).toBe(false);
		expect(parseRoutineLimitsInput({ maxCostUsd: 0.01 }).ok).toBe(true);
		expect(parseRoutineLimitsInput({ maxCostUsd: 50 }).ok).toBe(true);
		expect(parseRoutineLimitsInput({ maxCostUsd: 0 }).ok).toBe(false);
		expect(parseRoutineLimitsInput({ maxCostUsd: 51 }).ok).toBe(false);
		expect(parseRoutineLimitsInput({ maxCostUsd: Number.NaN }).ok).toBe(false);
	});

	it("campo desconhecido falha com a lista dos aceitos", () => {
		const parsed = parseRoutineLimitsInput({ maxSteps: 50, maxMinutes: 10 });
		expect(parsed).toEqual({ ok: false, error: expect.stringContaining("maxMinutes") });
		expect(parsed.ok ? "" : parsed.error).toContain("Aceitos: maxSteps, maxCostUsd");
		expect(parseRoutineLimitsInput([1]).ok).toBe(false);
		expect(parseRoutineLimitsInput("60").ok).toBe(false);
	});

	it("patch: troca, remove e mantém; sem nada vira undefined", () => {
		expect(applyRoutineLimitsPatch(undefined, { maxSteps: 80 })).toEqual({ maxSteps: 80 });
		expect(applyRoutineLimitsPatch({ maxSteps: 80, maxCostUsd: 1 }, { maxCostUsd: null })).toEqual({ maxSteps: 80 });
		expect(applyRoutineLimitsPatch({ maxSteps: 80 }, { maxSteps: null })).toBeUndefined();
		expect(applyRoutineLimitsPatch({ maxSteps: 80 }, {})).toEqual({ maxSteps: 80 });
		expect(applyRoutineLimitsPatch({ maxSteps: 80 }, null)).toBeUndefined();
	});

	it("gravado fora da faixa é ignorado", () => {
		expect(parseStoredRoutineLimits({ maxSteps: 3, maxCostUsd: 0.3 })).toEqual({ maxCostUsd: 0.3 });
		expect(parseStoredRoutineLimits({ maxSteps: 999 })).toBeUndefined();
		expect(parseStoredRoutineLimits(null)).toBeUndefined();
	});

	it("resumo em frase, sem US$ quando não configurado", () => {
		expect(formatRoutineLimitsSummary(undefined)).toBe("Até 40 passos por execução · sem teto em US$");
		expect(formatRoutineLimitsSummary({ maxSteps: 60, maxCostUsd: 0.5 })).toBe("Até 60 passos · até US$ 0,50 por execução");
	});
});

describe("espera no limite", () => {
	it("lê só o que é válido", () => {
		expect(parseStepLimitWait({ cardId: "c", kind: "steps", steps: 40, outcome: "continue" })).toEqual({ cardId: "c", kind: "steps", steps: 40, outcome: "continue" });
		expect(parseStepLimitWait({ cardId: "c", kind: "cost", steps: 40, costUsd: 0.5 })).toEqual({ cardId: "c", kind: "cost", steps: 40, costUsd: 0.5 });
		expect(parseStepLimitWait({ cardId: "c", kind: "steps", steps: 40, outcome: "maybe" })).toEqual({ cardId: "c", kind: "steps", steps: 40 });
		expect(parseStepLimitWait({ cardId: "", kind: "steps", steps: 40 })).toBeUndefined();
		expect(parseStepLimitWait({ cardId: "c", kind: "wall", steps: 40 })).toBeUndefined();
		expect(parseStepLimitWait(undefined)).toBeUndefined();
	});

	it("cartão em pt-BR sem nomes internos", () => {
		expect(stepLimitCardText({ kind: "steps", steps: 40 }).title).toBe("Cheguei no limite de 40 passos. Continuo?");
		expect(stepLimitCardText({ kind: "cost", steps: 40, costUsd: 0.3 }).title).toBe("Cheguei no limite de US$ 0,30 desta execução. Continuo?");
		expect(stepLimitCardText({ kind: "steps", steps: 40 }).description).toContain("Agora não encerra");
	});
});
