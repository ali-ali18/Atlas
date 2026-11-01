import { describe, expect, it } from "vitest";
import { describeEngineSettings, engineSettingsError, looksLikeEngineRequest, parseSetEngineArgs, withEngineSettings } from "./engine-settings.js";
import { readEnginePolicy } from "./engine-policy.js";
import { readHelperPolicy } from "./engine-helpers.js";

describe("withEngineSettings", () => {
	it("mescla só as chaves do motor e preserva o resto", () => {
		const next = withEngineSettings({ planMode: true, subagentModel: "x/y" }, { engine: "v2", longWorkBudgetUsd: 1, longWorkMinutes: 30, helperModel: "anthropic/claude-haiku" });
		expect(next).toMatchObject({ planMode: true, subagentModel: "x/y", engine: "v2", longWorkBudgetUsd: 1, longWorkMinutes: 30 });
		expect(readEnginePolicy(next).engine).toBe("v2");
		expect(readHelperPolicy(next).helperModel).toBe("anthropic/claude-haiku");
	});
	it("v1 remove engine e helperModel null remove o modelo; política inválida vira objeto", () => {
		const off = withEngineSettings({ engine: "v2", helperModel: "a/b", planMode: true }, { engine: "v1", helperModel: null });
		expect(off).toEqual({ planMode: true });
		expect(withEngineSettings(null, { engine: "v2" })).toEqual({ engine: "v2" });
	});
	it("não muta a entrada", () => {
		const input = { a: 1 };
		withEngineSettings(input, { engine: "v2" });
		expect(input).toEqual({ a: 1 });
	});
});

describe("parseSetEngineArgs", () => {
	it("aceita ligar com orçamento", () => {
		expect(parseSetEngineArgs({ engine: "new", budget_usd: 1, minutes: 30 })).toEqual({ ok: true, patch: { engine: "v2", longWorkBudgetUsd: 1, longWorkMinutes: 30 } });
		expect(parseSetEngineArgs({ engine: "current" })).toEqual({ ok: true, patch: { engine: "v1" } });
		expect(parseSetEngineArgs({ helper_model: "" })).toEqual({ ok: true, patch: { helperModel: null } });
	});
	it("falha com a lista do aceito: campo desconhecido, faixa, vazio, userId", () => {
		for (const args of [{ userId: "x", engine: "new" }, { budget_usd: 0.01 }, { budget_usd: 21 }, { minutes: 0 }, { minutes: 121 }, { engine: "v3" }, { helper_model: "a b" }, {}, null]) {
			const parsed = parseSetEngineArgs(args);
			expect(parsed.ok, JSON.stringify(args)).toBe(false);
			if (!parsed.ok) expect(parsed.error).toMatch(/Accepted fields/);
		}
	});
});

describe("looksLikeEngineRequest", () => {
	it("reconhece pedidos do dono", () => {
		for (const text of ["liga o motor novo nesse bot", "volta pro motor antigo", "orçamento de 1 dólar por tarefa longa", "use o novo motor", "turn on the new engine", "limite de 2 dólares por tarefa"]) {
			expect(looksLikeEngineRequest(text), text).toBe(true);
		}
	});
	it("ignora conversa comum, texto longo e resultado anexado pelo sistema", () => {
		for (const text of ["Bom dia", "qual o motor do carro?", "pesquise fornecedores de ervas", "x".repeat(500) + " motor novo"]) {
			expect(looksLikeEngineRequest(text), text).toBe(false);
		}
		expect(looksLikeEngineRequest("oi\n[Ação confirmada: liga o motor novo]")).toBe(false);
	});
});

describe("describeEngineSettings", () => {
	it("frase simples sem internals", () => {
		expect(describeEngineSettings({})).toBe("Motor atual");
		expect(describeEngineSettings({ engine: "v2" })).toBe("Motor novo (teste) · até US$ 0,50 e 20 min por tarefa longa");
		expect(describeEngineSettings({ engine: "v2", longWorkBudgetUsd: 1, longWorkMinutes: 10, helperModel: "a/b" })).toContain("US$ 1,00 e 10 min");
	});
});

describe("engineSettingsError", () => {
	it("ausente ou válido passa; fora da faixa falha", () => {
		expect(engineSettingsError(null)).toBeNull();
		expect(engineSettingsError({ planMode: true })).toBeNull();
		expect(engineSettingsError({ engine: "v2", longWorkBudgetUsd: 1, longWorkMinutes: 30, helperModel: "a/b" })).toBeNull();
		for (const bad of [{ engine: "v3" }, { longWorkBudgetUsd: 0 }, { longWorkBudgetUsd: "1" }, { longWorkMinutes: 500 }, { helperModel: 5 }, { helperModel: "a b" }]) {
			expect(engineSettingsError(bad), JSON.stringify(bad)).toMatch(/^Invalid/);
		}
	});
});
