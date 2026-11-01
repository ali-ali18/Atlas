import { describe, expect, it } from "vitest";
import { validateAccountConfigPatch } from "./account-config.js";
import { parseRunConfigSnapshot, resolveEffectiveConfig, toRunConfigSnapshot } from "./effective-config.js";
import {
	availableReasoningEfforts,
	canDisableReasoning,
	effortForModel,
	formatReasoningEffort,
	parseReasoningEffort,
	readBotReasoningEffort,
	readRunReasoningEffort,
	resolveReasoningEffort,
	supportsReasoningEffort,
	withBotReasoningEffort,
} from "./reasoning-effort.js";

const withReasoning = { supportedParameters: ["tools", "reasoning"] };
const withoutReasoning = { supportedParameters: ["tools"] };

describe("parseReasoningEffort", () => {
	it("aceita só os quatro níveis exatos", () => {
		expect(["off", "low", "medium", "high"].map(parseReasoningEffort)).toEqual(["off", "low", "medium", "high"]);
		for (const bad of ["", "LOW", "minimal", "xhigh", 3, null, undefined, {}]) expect(parseReasoningEffort(bad)).toBeUndefined();
	});
});

describe("suporte por modelo", () => {
	it("exige OpenRouter e raciocínio no catálogo", () => {
		expect(supportsReasoningEffort("anthropic/claude-sonnet-5.5", withReasoning)).toBe(true);
		expect(supportsReasoningEffort("anthropic/claude-sonnet-5.5", withoutReasoning)).toBe(false);
		expect(supportsReasoningEffort("openai/gpt-4o")).toBe(false);
		expect(supportsReasoningEffort("someone/unknown-model")).toBe(false);
	});

	it("outros provedores nunca recebem o controle", () => {
		expect(supportsReasoningEffort("chatgpt/gpt-5")).toBe(false);
		expect(supportsReasoningEffort("anthropic/claude-sonnet-5.5", withReasoning)).toBe(true);
		expect(supportsReasoningEffort("opencode-go/glm-5", withReasoning)).toBe(false);
	});

	it("Desligado só nos modelos que desligam de verdade", () => {
		expect(canDisableReasoning("anthropic/claude-sonnet-5.5", withReasoning)).toBe(true);
		expect(canDisableReasoning("openai/gpt-5")).toBe(false);
		expect(canDisableReasoning("openai/gpt-5.1", withReasoning)).toBe(true);
		expect(canDisableReasoning("deepseek/deepseek-r1", withReasoning)).toBe(false);
		expect(canDisableReasoning("anthropic/claude-3-haiku", withoutReasoning)).toBe(false);
	});

	it("lista os níveis oferecidos", () => {
		expect(availableReasoningEfforts("anthropic/claude-sonnet-5.5", withReasoning)).toEqual(["off", "low", "medium", "high"]);
		expect(availableReasoningEfforts("openai/gpt-5")).toEqual(["low", "medium", "high"]);
		expect(availableReasoningEfforts("openai/gpt-4o")).toEqual([]);
	});
});

describe("effortForModel", () => {
	it("não envia nada sem escolha ou sem suporte", () => {
		expect(effortForModel(undefined, "openai/gpt-5")).toBeUndefined();
		expect(effortForModel("high", "openai/gpt-4o")).toBeUndefined();
	});
	it("Desligado vira Baixo no modelo que não desliga", () => {
		expect(effortForModel("off", "openai/gpt-5")).toBe("low");
		expect(effortForModel("off", "anthropic/claude-sonnet-5.5", withReasoning)).toBe("off");
		expect(effortForModel("medium", "openai/gpt-5")).toBe("medium");
	});
});

describe("precedência e política do bot", () => {
	it("pedido > bot > conta > nada", () => {
		expect(resolveReasoningEffort({ requested: "high", policyJson: { reasoningEffort: "low" }, account: "medium" })).toBe("high");
		expect(resolveReasoningEffort({ policyJson: { reasoningEffort: "low" }, account: "medium" })).toBe("low");
		expect(resolveReasoningEffort({ account: "medium" })).toBe("medium");
		expect(resolveReasoningEffort({ requested: "bogus", policyJson: { reasoningEffort: "bogus" } })).toBeUndefined();
	});
	it("withBotReasoningEffort preserva outras chaves e limpa com null", () => {
		const policy = { engine: "v2", reasoningEffort: "low" };
		expect(withBotReasoningEffort(policy, "high")).toEqual({ engine: "v2", reasoningEffort: "high" });
		expect(withBotReasoningEffort(policy, null)).toEqual({ engine: "v2" });
		expect(withBotReasoningEffort(null, "low")).toEqual({ reasoningEffort: "low" });
		expect(readBotReasoningEffort(withBotReasoningEffort(null, "medium"))).toBe("medium");
	});
	it("lê o nível gravado no run", () => {
		expect(readRunReasoningEffort({ reasoningEffort: "low", contextLength: 1 })).toBe("low");
		expect(readRunReasoningEffort(null)).toBeUndefined();
	});
	it("resume em frase", () => {
		expect(formatReasoningEffort("low")).toBe("Raciocínio: Baixo");
		expect(formatReasoningEffort(undefined)).toBe("Raciocínio: Padrão do modelo");
	});
});

describe("padrão da conta", () => {
	it("valida o patch e leva o nível ao snapshot do run", () => {
		expect(validateAccountConfigPatch({ models: { reasoningEffort: "low" } }).ok).toBe(true);
		expect(validateAccountConfigPatch({ models: { reasoningEffort: "extreme" } }).ok).toBe(false);
		const effective = resolveEffectiveConfig({ user: { config: { v: 1, models: { reasoningEffort: "medium" } } }, env: {} });
		expect(effective.models.reasoningEffort).toEqual({ value: "medium", source: "user" });
		const snapshot = toRunConfigSnapshot(effective);
		expect(snapshot.reasoningEffort).toBe("medium");
		expect(parseRunConfigSnapshot(JSON.parse(JSON.stringify(snapshot)))?.reasoningEffort).toBe("medium");
	});
	it("sem escolha, o snapshot não leva nada", () => {
		const snapshot = toRunConfigSnapshot(resolveEffectiveConfig({ user: { config: { v: 1 } }, env: {} }));
		expect(snapshot.reasoningEffort).toBeUndefined();
	});
});
