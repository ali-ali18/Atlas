import { describe, expect, it } from "vitest";
import { describeEngineSettings, engineSettingsError, looksLikeEngineRequest, normalizeEngineSettings, parseSetEngineArgs, withEngineSettings } from "./engine-settings.js";
import { readEnginePolicy } from "./engine-policy.js";
import { readHelperPolicy } from "./engine-helpers.js";

describe("withEngineSettings", () => {
	it("mescla só as chaves do motor e preserva o resto", () => {
		const next = withEngineSettings({ planMode: true, subagentModel: "x/y" }, { engine: "v2", longWorkBudgetUsd: 1, longWorkMinutes: 30, helperModel: "anthropic/claude-haiku" });
		expect(next).toMatchObject({ planMode: true, subagentModel: "x/y", engine: "v2", longWorkBudgetUsd: 1, longWorkMinutes: 30 });
		expect(readEnginePolicy(next).engine).toBe("v2");
		expect(readHelperPolicy(next).helperModel).toBe("anthropic/claude-haiku");
	});
	it("v1 fica explícito (o padrão global não o leva ao v2) e desliga o escopo; helperModel null remove o modelo; política inválida vira objeto", () => {
		const off = withEngineSettings({ engine: "v2", engineScope: "all", helperModel: "a/b", planMode: true }, { engine: "v1", helperModel: null });
		expect(off).toEqual({ planMode: true, engine: "v1" });
		expect(withEngineSettings(null, { engine: "v2" })).toEqual({ engine: "v2" });
	});
	it("scope all grava engineScope, chat remove; sem scope no patch não mexe nele", () => {
		const wide = withEngineSettings({ engine: "v2" }, { scope: "all" });
		expect(wide).toEqual({ engine: "v2", engineScope: "all" });
		expect(readEnginePolicy(wide).scope).toBe("all");
		expect(withEngineSettings(wide, { longWorkMinutes: 30 })).toEqual({ engine: "v2", engineScope: "all", longWorkMinutes: 30 });
		expect(withEngineSettings(wide, { scope: "chat" })).toEqual({ engine: "v2" });
		expect(withEngineSettings(wide, { engine: "v1", scope: "all" })).toEqual({ engine: "v1", engineScope: "all" });
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
		expect(parseSetEngineArgs({ scope: "all" })).toEqual({ ok: true, patch: { scope: "all" } });
		expect(parseSetEngineArgs({ engine: "new", scope: "chat" })).toEqual({ ok: true, patch: { engine: "v2", scope: "chat" } });
	});
	it("falha com a lista do aceito: campo desconhecido, faixa, vazio, userId", () => {
		for (const args of [{ userId: "x", engine: "new" }, { budget_usd: 0.01 }, { budget_usd: 21 }, { minutes: 0 }, { minutes: 181 }, { engine: "v3" }, { scope: "tudo" }, { scope: 1 }, { scope: "ALL" }, { helper_model: "a b" }, {}, null]) {
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
		expect(describeEngineSettings({ engine: "v2" })).toBe("Motor novo (teste) · sem limite de gasto, até 60 min por tarefa longa");
		expect(describeEngineSettings({ engine: "v2", engineScope: "all" })).toBe("Motor novo (teste) · também em rotinas e grupos · sem limite de gasto, até 60 min por tarefa longa");
		expect(describeEngineSettings({ engine: "v2", longWorkBudgetUsd: 2, longWorkMinutes: 90 })).toBe("Motor novo (teste) · gasto máximo de US$ 2,00 e até 90 min por tarefa longa");
		expect(describeEngineSettings({ engine: "v2", longWorkBudgetUsd: 1, longWorkMinutes: 10, helperModel: "a/b" })).toContain("US$ 1,00 e até 10 min");
	});
});

describe("engineSettingsError", () => {
	it("ausente ou válido passa; fora da faixa falha", () => {
		expect(engineSettingsError(null)).toBeNull();
		expect(engineSettingsError({ planMode: true })).toBeNull();
		expect(engineSettingsError({ engine: "v2", longWorkBudgetUsd: 1, longWorkMinutes: 30, helperModel: "a/b" })).toBeNull();
		expect(engineSettingsError({ engine: "v2", engineScope: "all" })).toBeNull();
		expect(engineSettingsError({ engineScope: "chat" })).toBeNull();
		for (const bad of [{ engine: "v3" }, { longWorkBudgetUsd: 0 }, { longWorkBudgetUsd: "1" }, { longWorkMinutes: 500 }, { helperModel: 5 }, { helperModel: "a b" }, { engineScope: "tudo" }, { engineScope: true }, { engineScope: "ALL" }]) {
			expect(engineSettingsError(bad), JSON.stringify(bad)).toMatch(/^Invalid/);
		}
	});
});

describe("gasto máximo opcional", () => {
	it("set_engine: 0, vazio ou null tiram o limite de gasto; valor válido vira teto; a política perde a chave", () => {
		for (const empty of [0, "", null]) expect(parseSetEngineArgs({ budget_usd: empty })).toEqual({ ok: true, patch: { longWorkBudgetUsd: null } });
		expect(parseSetEngineArgs({ budget_usd: 2 })).toEqual({ ok: true, patch: { longWorkBudgetUsd: 2 } });
		expect(parseSetEngineArgs({ minutes: 180 })).toEqual({ ok: true, patch: { longWorkMinutes: 180 } });
		expect(withEngineSettings({ engine: "v2", longWorkBudgetUsd: 1, other: 1 }, { longWorkBudgetUsd: null })).toEqual({ engine: "v2", other: 1 });
		expect(engineSettingsError({ engine: "v2", longWorkBudgetUsd: null })).toBeNull();
	});
});

describe("0 remove o teto de gasto (igual a vazio e null)", () => {
	it("normalizeEngineSettings tira a chave com 0, null ou vazio e preserva o resto; valor positivo passa", () => {
		for (const empty of [0, null, ""]) expect(normalizeEngineSettings({ engine: "v2", longWorkBudgetUsd: empty, planMode: true })).toEqual({ engine: "v2", planMode: true });
		expect(normalizeEngineSettings({ engine: "v2", longWorkBudgetUsd: 2 })).toEqual({ engine: "v2", longWorkBudgetUsd: 2 });
		expect(normalizeEngineSettings({ engine: "v2" })).toEqual({ engine: "v2" });
		expect(normalizeEngineSettings(null)).toBeNull();
		expect(engineSettingsError(normalizeEngineSettings({ engine: "v2", longWorkBudgetUsd: 0 }))).toBeNull();
	});

	it("readEnginePolicy trata 0 como sem limite", () => {
		expect(readEnginePolicy({ engine: "v2", longWorkBudgetUsd: 0 }).longWorkBudgetUsd).toBeUndefined();
		expect(readEnginePolicy({ engine: "v2", longWorkBudgetUsd: 0.05 }).longWorkBudgetUsd).toBe(0.05);
	});
});
