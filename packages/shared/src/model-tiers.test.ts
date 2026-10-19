import { describe, expect, it } from "vitest";
import { mergeAccountConfig, parseAccountConfig, validateAccountConfigPatch } from "./account-config.js";
import { resolveEffectiveConfig, parseRunConfigSnapshot, toRunConfigSnapshot } from "./effective-config.js";
import {
	hasModelTiers,
	mergeModelTiers,
	nextTierUp,
	normalizeModelTiers,
	readBotModelTiers,
	registeredTierModels,
	tierModelList,
	withBotModelTiers,
} from "./model-tiers.js";

const resolve = (config: unknown) => resolveEffectiveConfig({ user: { config }, env: {} });

describe("normalizeModelTiers", () => {
	it("mantém ids válidos, sem repetição, até 3 por nível; nível sem modelo some", () => {
		expect(
			normalizeModelTiers({
				easy: ["a/x", "a/x", "b/y", "c/z", "d/w"],
				medium: [],
				hard: ["inválido id", "e/v"],
				extra: ["f/u"],
			}),
		).toEqual({ easy: ["a/x", "b/y", "c/z"], hard: ["e/v"] });
	});
	it("lixo vira vazio", () => {
		expect(normalizeModelTiers(null)).toEqual({});
		expect(normalizeModelTiers("x")).toEqual({});
		expect(normalizeModelTiers({ easy: "a/x" })).toEqual({});
	});
});

describe("ajudantes dos níveis", () => {
	it("hasModelTiers e nextTierUp", () => {
		expect(hasModelTiers({})).toBe(false);
		expect(hasModelTiers({ medium: ["a/x"] })).toBe(true);
		expect(nextTierUp("easy")).toBe("medium");
		expect(nextTierUp("medium")).toBe("hard");
		expect(nextTierUp("hard")).toBeNull();
	});
	it("nível vazio herda a lista informada", () => {
		expect(tierModelList({ easy: ["a/x"] }, "easy", ["d/m", "r/1"])).toEqual(["a/x"]);
		expect(tierModelList({ easy: ["a/x"] }, "hard", ["d/m", "r/1"])).toEqual(["d/m", "r/1"]);
		expect(tierModelList(undefined, "easy", ["d/m"])).toEqual(["d/m"]);
	});
	it("modelos cadastrados, sem repetição, de Fácil a Difícil", () => {
		expect(registeredTierModels({ hard: ["c/z", "a/x"], easy: ["a/x", "b/y"] })).toEqual(["a/x", "b/y", "c/z"]);
		expect(registeredTierModels(undefined)).toEqual([]);
	});
	it("nível do bot vence o da conta; o que o bot não definiu herda", () => {
		expect(mergeModelTiers({ easy: ["a/x"], hard: ["c/z"] }, { hard: ["b/y"] })).toEqual({ easy: ["a/x"], hard: ["b/y"] });
		expect(mergeModelTiers({ easy: ["a/x"] }, {})).toEqual({ easy: ["a/x"] });
	});
	it("política do bot: lê, grava sem perder outras chaves e remove quando vazio", () => {
		const policy = withBotModelTiers({ codingModel: "k/c" }, { easy: ["a/x"], medium: [] });
		expect(policy).toEqual({ codingModel: "k/c", modelTiers: { easy: ["a/x"] } });
		expect(readBotModelTiers(policy)).toEqual({ easy: ["a/x"] });
		expect(withBotModelTiers(policy, { easy: [] })).toEqual({ codingModel: "k/c" });
		expect(readBotModelTiers(null)).toEqual({});
	});
});

describe("configuração da conta", () => {
	it("aceita níveis e o switch do revisor; recusa repetição, mais de 3 e id ruim", () => {
		const ok = validateAccountConfigPatch({ models: { tiers: { easy: ["a/x", "b/y"], hard: ["c/z"] }, classifyWithReviewer: true } });
		expect(ok.ok).toBe(true);
		for (const bad of [{ easy: ["a/x", "a/x"] }, { easy: ["a/x", "b/y", "c/z", "d/w"] }, { easy: ["id ruim"] }, { easy: "a/x" }]) {
			const result = validateAccountConfigPatch({ models: { tiers: bad } });
			expect(result.ok).toBe(false);
		}
		expect(validateAccountConfigPatch({ models: { tiers: { fácil: ["a/x"] } } }).ok).toBe(false);
	});
	it("null remove o nível (volta a herdar) sem mexer nos outros", () => {
		const base = { v: 1, models: { tiers: { easy: ["a/x"], hard: ["c/z"] } } };
		const result = validateAccountConfigPatch({ models: { tiers: { easy: null } } });
		if (!result.ok) throw new Error("patch recusado");
		expect(mergeAccountConfig(base, result.patch).models?.tiers).toEqual({ hard: ["c/z"] });
	});
	it("leitura tolerante descarta o nível inválido", () => {
		expect(parseAccountConfig({ v: 1, models: { tiers: { easy: ["a/x"], medium: ["id ruim"] } } }).models?.tiers).toEqual({ easy: ["a/x"] });
	});
});

describe("configuração efetiva: nível vazio = comportamento de hoje", () => {
	it("sem níveis: vazio, origem padrão, revisor desligado e nada no snapshot", () => {
		const e = resolve({ v: 1, models: { default: "u/default", fallbacks: ["r/1"] } });
		expect(e.models.tiers).toEqual({ value: {}, source: "default" });
		expect(e.models.classifyWithReviewer).toEqual({ value: false, source: "default" });
		const snap = toRunConfigSnapshot(e);
		expect(snap.modelTiers).toBeUndefined();
		expect(snap.classifyWithReviewer).toBeUndefined();
		expect(snap.fallbackModels).toEqual(["r/1"]);
		expect(e.models.default.value).toBe("u/default");
	});
	it("com níveis: origem usuário; vão ao snapshot e ele continua válido", () => {
		const e = resolve({ v: 1, models: { tiers: { easy: ["a/x", "b/y"] }, classifyWithReviewer: true } });
		expect(e.models.tiers).toEqual({ value: { easy: ["a/x", "b/y"] }, source: "user" });
		expect(e.models.classifyWithReviewer).toEqual({ value: true, source: "user" });
		const snap = toRunConfigSnapshot(e);
		expect(snap.modelTiers).toEqual({ easy: ["a/x", "b/y"] });
		expect(snap.classifyWithReviewer).toBe(true);
		expect(parseRunConfigSnapshot(JSON.parse(JSON.stringify(snap)))).toEqual(snap);
		expect(parseRunConfigSnapshot({ ...snap, modelTiers: "x" })).toBeNull();
		expect(parseRunConfigSnapshot({ ...snap, classifyWithReviewer: "sim" })).toBeNull();
	});
	it("lista de nível vazia no config não conta como configurada", () => {
		expect(resolve({ v: 1, models: { tiers: { easy: [] } } }).models.tiers.source).toBe("default");
	});
});
