import { describe, expect, it } from "vitest";
import {
	ACCOUNT_CONFIG_MAX_BYTES,
	mergeAccountConfig,
	parseAccountConfig,
	validateAccountConfigPatch,
	type AccountConfigPatch,
} from "./account-config.js";

const ok = (raw: unknown): AccountConfigPatch => {
	const result = validateAccountConfigPatch(raw);
	if (!result.ok) throw new Error(JSON.stringify(result.errors));
	return result.patch;
};
const errorsOf = (raw: unknown) => {
	const result = validateAccountConfigPatch(raw);
	return result.ok ? [] : result.errors.map((e) => e.path);
};

describe("parseAccountConfig (leitura tolerante)", () => {
	it("vazio, nulo e lixo viram config vazia", () => {
		for (const raw of [undefined, null, 5, "x", [], {}]) expect(parseAccountConfig(raw)).toEqual({ v: 1 });
	});
	it("versão futura ou ausente é ignorada por inteiro", () => {
		expect(parseAccountConfig({ v: 2, models: { default: "a/b" } })).toEqual({ v: 1 });
		expect(parseAccountConfig({ models: { default: "a/b" } })).toEqual({ v: 1 });
	});
	it("mantém o válido e descarta chave desconhecida e valor inválido", () => {
		expect(
			parseAccountConfig({
				v: 1,
				models: { default: "a/b", maintenance: "chatgpt/x", vision: "bad id", extra: 1 },
				jev: { mcp: "gate", all: "gate", features: { intent: "on", nope: "on" } },
				execution: { maxOutputTokens: 5, maxSteps: 12.5, discipline: "yes", llmTimeoutPreset: "short" },
				secret: "x",
			}),
		).toEqual({
			v: 1,
			models: { default: "a/b" },
			jev: { mcp: "gate", features: { intent: "on" } },
			execution: { llmTimeoutPreset: "short" },
		});
	});
	it("memória da conversa: só standard/economy; inválido cai fora", () => {
		expect(parseAccountConfig({ v: 1, execution: { contextMemory: "economy" } })).toEqual({ v: 1, execution: { contextMemory: "economy" } });
		expect(parseAccountConfig({ v: 1, execution: { contextMemory: "banana" } })).toEqual({ v: 1 });
		expect(validateAccountConfigPatch({ execution: { contextMemory: "standard" } })).toEqual({ ok: true, patch: { execution: { contextMemory: "standard" } } });
		expect(validateAccountConfigPatch({ execution: { contextMemory: null } })).toEqual({ ok: true, patch: { execution: { contextMemory: null } } });
		const bad = validateAccountConfigPatch({ execution: { contextMemory: "alto" } });
		expect(bad.ok).toBe(false);
		if (!bad.ok) expect(bad.errors[0]).toEqual({ path: "execution.contextMemory", message: "Use standard ou economy." });
	});
	it("null na leitura não remove nada nem quebra", () => {
		expect(parseAccountConfig({ v: 1, models: null, jev: { mcp: null } })).toEqual({ v: 1 });
	});
});

describe("validateAccountConfigPatch (escrita estrita)", () => {
	it("aceita patch válido e null de remoção", () => {
		expect(ok({ models: { default: "openai/gpt-4o-mini", fallbacks: ["a/b", "c/d"] }, jev: null, execution: { maxSteps: null } })).toEqual({
			models: { default: "openai/gpt-4o-mini", fallbacks: ["a/b", "c/d"] },
			jev: null,
			execution: { maxSteps: null },
		});
	});
	it("rejeita chave desconhecida em qualquer nível", () => {
		expect(errorsOf({ banana: 1 })).toEqual(["banana"]);
		expect(errorsOf({ models: { apiKey: "x" } })).toEqual(["models.apiKey"]);
		expect(errorsOf({ jev: { features: { nope: "on" } } })).toEqual(["jev.features.nope"]);
	});
	it("rejeita enum, tipo e número fora do preset", () => {
		expect(errorsOf({ jev: { mcp: "on" } })).toEqual(["jev.mcp"]);
		expect(errorsOf({ providers: { chatgptEnabled: "true" } })).toEqual(["providers.chatgptEnabled"]);
		expect(errorsOf({ execution: { maxOutputTokens: 1000 } })).toEqual(["execution.maxOutputTokens"]);
		expect(errorsOf({ execution: { toolResultMaxChars: 999 } })).toEqual(["execution.toolResultMaxChars"]);
		expect(errorsOf({ execution: { toolResultMaxChars: 20_000.5 } })).toEqual(["execution.toolResultMaxChars"]);
		expect(errorsOf({ execution: { toolResultMaxChars: 50_000 } })).toEqual([]);
		expect(errorsOf({ execution: { maxSteps: 501 } })).toEqual(["execution.maxSteps"]);
		expect(errorsOf({ execution: { maxSteps: 150 } })).toEqual(["execution.maxSteps"]);
		expect(errorsOf({ execution: { maxWallMinutes: 0 } })).toEqual(["execution.maxWallMinutes"]);
		expect(errorsOf({ execution: { maxRunCostUsd: 0.15 } })).toEqual(["execution.maxRunCostUsd"]);
		expect(errorsOf({ general: { defaultBotLanguage: "fr-FR" } })).toEqual(["general.defaultBotLanguage"]);
		expect(errorsOf({ models: "x" })).toEqual(["models"]);
	});
	it("valida ids de modelo: caracteres, tamanho e provedor", () => {
		expect(errorsOf({ models: { default: "a b" } })).toEqual(["models.default"]);
		expect(errorsOf({ models: { default: "a".repeat(201) } })).toEqual(["models.default"]);
		expect(errorsOf({ models: { default: "chatgpt/gpt-5" } })).toEqual([]);
		expect(errorsOf({ models: { maintenance: "chatgpt/gpt-5", vision: "chatgpt/x", image: "chatgpt/y" } })).toEqual([
			"models.maintenance",
			"models.vision",
			"models.image",
		]);
		expect(errorsOf({ models: { stt: "openai/whisper-large-v3" } })).toEqual([]);
		expect(errorsOf({ models: { stt: "whisper-1" } })).toEqual([]);
		expect(errorsOf({ models: { stt: null } })).toEqual([]);
		expect(errorsOf({ models: { stt: "chatgpt/x" } })).toEqual(["models.stt"]);
		expect(errorsOf({ models: { stt: "a b" } })).toEqual(["models.stt"]);
		expect(errorsOf({ models: { stt: "a".repeat(201) } })).toEqual(["models.stt"]);
		expect(errorsOf({ models: { stt: 3 } })).toEqual(["models.stt"]);
		expect(parseAccountConfig({ v: 1, models: { stt: "x/y" } })).toEqual({ v: 1, models: { stt: "x/y" } });
		expect(parseAccountConfig({ v: 1, models: { default: "a/b" } }).models?.stt).toBeUndefined();
		expect(errorsOf({ models: { fallbacks: ["a/b", "a/b"] } })).toEqual(["models.fallbacks"]);
		expect(errorsOf({ models: { fallbacks: ["a", "b", "c", "d"] } })).toEqual(["models.fallbacks"]);
		expect(errorsOf({ models: { fallbacks: ["chatgpt/x"] } })).toEqual(["models.fallbacks"]);
	});
	it("v diferente de 1 é erro; v 1 é aceito", () => {
		expect(errorsOf({ v: 2 })).toEqual(["v"]);
		expect(errorsOf({ v: 1 })).toEqual([]);
	});
	it("não é objeto = erro", () => {
		for (const raw of [null, [], "x", 3]) expect(errorsOf(raw)).toEqual(["config"]);
	});
	it("mais de 4 KB é erro", () => {
		const big = { models: { fallbacks: ["a".repeat(ACCOUNT_CONFIG_MAX_BYTES)] } };
		expect(errorsOf(big)).toEqual(["config"]);
	});
	it("aceita novos presets de maxSteps (100, 200, 300, 500)", () => {
		for (const steps of [100, 200, 300, 500]) {
			expect(ok({ execution: { maxSteps: steps } })).toEqual({ execution: { maxSteps: steps } });
		}
	});
	it("aceita maxRunCostUsd com valores válidos e null", () => {
		for (const cost of [0.05, 0.10, 0.25, 0.50, 1.00, null]) {
			const result = ok({ execution: { maxRunCostUsd: cost } });
			expect(result.execution?.maxRunCostUsd).toEqual(cost);
		}
	});
});

describe("mergeAccountConfig (merge patch)", () => {
	it("ausente não muda; valor novo sobrescreve; grupos se fundem", () => {
		const base = { v: 1, models: { default: "a/b" }, jev: { all: "on", features: { intent: "off" } } };
		const merged = mergeAccountConfig(base, ok({ jev: { features: { tools: "shadow" } }, models: { image: "x/y" } }));
		expect(merged).toEqual({
			v: 1,
			models: { default: "a/b", image: "x/y" },
			jev: { all: "on", features: { intent: "off", tools: "shadow" } },
		});
	});
	it("null remove a folha e o grupo vazio some", () => {
		const base = { v: 1, models: { default: "a/b" }, execution: { maxSteps: 100 } };
		expect(mergeAccountConfig(base, ok({ models: { default: null } }))).toEqual({ v: 1, execution: { maxSteps: 100 } });
		expect(mergeAccountConfig(base, ok({ execution: null }))).toEqual({ v: 1, models: { default: "a/b" } });
	});
	it("fallbacks é substituído por inteiro", () => {
		const base = { v: 1, models: { fallbacks: ["a/b", "c/d"] } };
		expect(mergeAccountConfig(base, ok({ models: { fallbacks: ["e/f"] } })).models?.fallbacks).toEqual(["e/f"]);
	});
	it("base inválida ou de outra versão parte do vazio", () => {
		expect(mergeAccountConfig({ v: 9, models: { default: "x" } }, ok({ jev: { mcp: "gate" } }))).toEqual({
			v: 1,
			jev: { mcp: "gate" },
		});
		expect(mergeAccountConfig(null, ok({}))).toEqual({ v: 1 });
	});
	it("não muta a entrada", () => {
		const base = { v: 1, models: { default: "a/b" } };
		mergeAccountConfig(base, ok({ models: { default: null } }));
		expect(base).toEqual({ v: 1, models: { default: "a/b" } });
	});
});

describe("general.timezone (fuso horário da conta)", () => {
	it("aceita um fuso IANA válido, mescla e persiste", () => {
		const patch = ok({ general: { timezone: "America/Sao_Paulo" } });
		expect(mergeAccountConfig({ v: 1 }, patch)).toEqual({ v: 1, general: { timezone: "America/Sao_Paulo" } });
		expect(parseAccountConfig({ v: 1, general: { timezone: "Europe/Lisbon", defaultBotLanguage: "en-US" } })).toEqual({
			v: 1,
			general: { timezone: "Europe/Lisbon", defaultBotLanguage: "en-US" },
		});
	});
	it("rejeita fuso inventado e aceita null (voltar ao automático)", () => {
		expect(errorsOf({ general: { timezone: "Marte/Olympus" } })).toEqual(["general.timezone"]);
		expect(errorsOf({ general: { timezone: "" } })).toEqual(["general.timezone"]);
		expect(errorsOf({ general: { timezone: null } })).toEqual([]);
		const cleared = mergeAccountConfig({ v: 1, general: { timezone: "UTC" } }, ok({ general: { timezone: null } }));
		expect(cleared.general?.timezone).toBeUndefined();
	});
	it("leitura tolerante descarta fuso inválido gravado", () => {
		expect(parseAccountConfig({ v: 1, general: { timezone: "nope" } })).toEqual({ v: 1 });
	});
});

describe("coding.verifier (Verificador inteligente)", () => {
	it("aceita booleano, recusa o resto e ausente herda o padrão", () => {
		const merged = mergeAccountConfig(null, ok({ coding: { verifier: false } }));
		expect(merged.coding?.verifier).toBe(false);
		expect(validateAccountConfigPatch({ coding: { verifier: "sim" } }).ok).toBe(false);
		expect(parseAccountConfig({ v: 1 }).coding?.verifier).toBeUndefined();
		const cleared = mergeAccountConfig(merged, ok({ coding: { verifier: null } }));
		expect(cleared.coding).toBeUndefined();
	});
});
