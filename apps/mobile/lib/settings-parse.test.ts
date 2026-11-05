import { describe, expect, it } from "vitest";
import { parseAccountSettings, parseAutonomyLevel, parseUsage } from "./settings-parse";

describe("parseAccountSettings", () => {
	it("lê o que vale de fato", () => {
		const body = { effective: { sandboxAutoStart: { value: false, source: "user" }, general: { timezone: { value: "America/Sao_Paulo", source: "user" }, defaultBotLanguage: { value: "en-US", source: "user" } } } };
		expect(parseAccountSettings(body)).toEqual({ timezone: "America/Sao_Paulo", botLanguage: "en-US", sandboxAutoStart: false });
	});
	it("sem fuso na conta: null; idioma e navegador com os padrões", () => {
		const body = { effective: { general: { timezone: { value: undefined, source: "default" } } } };
		expect(parseAccountSettings(body)).toEqual({ timezone: null, botLanguage: "auto", sandboxAutoStart: true });
	});
	it("valor inválido vira padrão, nunca estoura", () => {
		const body = { effective: { sandboxAutoStart: { value: "sim" }, general: { timezone: { value: "Marte/Olympus" }, defaultBotLanguage: { value: "klingon" } } } };
		expect(parseAccountSettings(body)).toEqual({ timezone: null, botLanguage: "auto", sandboxAutoStart: true });
	});
	it("resposta sem effective: null", () => {
		expect(parseAccountSettings(null)).toBeNull();
		expect(parseAccountSettings({})).toBeNull();
		expect(parseAccountSettings([])).toBeNull();
	});
});

describe("parseAutonomyLevel", () => {
	it("lê o nível efetivo", () => {
		expect(parseAutonomyLevel({ effective: { level: "autonomous", exceptions: [] }, stored: null, source: "default" })).toBe("autonomous");
	});
	it("nível desconhecido ou corpo estranho: null", () => {
		expect(parseAutonomyLevel({ effective: { level: "yolo" } })).toBeNull();
		expect(parseAutonomyLevel({ effective: null })).toBeNull();
		expect(parseAutonomyLevel("x")).toBeNull();
	});
});

const totals = { runs: 3, costUsd: 0.5, costUnknownCalls: 0, planCalls: 0, promptTokens: 1200, completionTokens: 300, cachedTokens: 0 };

describe("parseUsage", () => {
	it("lê totais e as quebras por bot e por modelo", () => {
		const body = { period: "30d", totals, byBot: [{ ...totals, key: "b1", botId: "b1", name: "Ana" }], byModel: [{ ...totals, key: "openai/gpt", model: "openai/gpt" }] };
		const usage = parseUsage(body);
		expect(usage?.period).toBe("30d");
		expect(usage?.totals.costUsd).toBe(0.5);
		expect(usage?.byBot).toEqual([{ ...totals, key: "b1", label: "Ana" }]);
		expect(usage?.byModel[0]?.label).toBe("openai/gpt");
	});
	it("custo ausente fica null (nunca 0) e número ruim vira 0", () => {
		const usage = parseUsage({ period: "today", totals: { ...totals, costUsd: null, runs: -2, promptTokens: "x" }, byBot: "nada" });
		expect(usage?.totals.costUsd).toBeNull();
		expect(usage?.totals.runs).toBe(0);
		expect(usage?.totals.promptTokens).toBe(0);
		expect(usage?.byBot).toEqual([]);
	});
	it("período inválido ou sem totais: null", () => {
		expect(parseUsage({ period: "1y", totals })).toBeNull();
		expect(parseUsage({ period: "7d" })).toBeNull();
		expect(parseUsage(null)).toBeNull();
	});
});
