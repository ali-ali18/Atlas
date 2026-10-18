import assert from "node:assert/strict";
import test from "node:test";
import {
	JEV_FEATURES,
	LLM_TIMEOUT_PRESET_VALUES,
	type AccountSettingsResponse,
	type UpdateAccountSettingsInput,
} from "@workspace/shared";
import {
	SAVE_ERROR_FALLBACK,
	applyOptimisticPatch,
	commitSettingsChange,
	inheritLabel,
	saveErrorMessage,
} from "./account-settings-state";

function view(language: "pt-BR" | "en-US", source: "user" | "env" | "default"): AccountSettingsResponse {
	return {
		settings: { sandboxAutoStart: true },
		config: {},
		effective: { general: { defaultBotLanguage: { value: language, source } } },
		capabilities: { openrouterKey: true, isOwner: true },
	} as unknown as AccountSettingsResponse;
}

const language = (v: AccountSettingsResponse) => v.effective.general.defaultBotLanguage;

test("inheritLabel mostra a origem do valor herdado e some quando é do usuário", () => {
	assert.equal(inheritLabel("env", "pt-BR"), "Herdar (pt-BR)");
	assert.equal(inheritLabel("default", "pt-BR"), "Herdar (pt-BR)");
	assert.equal(inheritLabel("user", "pt-BR"), null);
});

test("otimista: idioma novo vira valor do usuário; null (herdar) não inventa valor", () => {
	const before = view("pt-BR", "env");
	assert.deepEqual(language(applyOptimisticPatch(before, { general: { defaultBotLanguage: "en-US" } })), {
		value: "en-US",
		source: "user",
	});
	assert.equal(applyOptimisticPatch(before, { general: { defaultBotLanguage: null } }), before);
	assert.equal(applyOptimisticPatch(before, {}), before);
	assert.equal(language(before).value, "pt-BR", "não muta a visão original");
});

test("saveErrorMessage só repassa erro de validação (400); o resto vira mensagem genérica", () => {
	assert.equal(saveErrorMessage({ status: 400, message: "Use pt-BR, en-US ou es-ES." }), "Use pt-BR, en-US ou es-ES.");
	assert.equal(saveErrorMessage({ status: 503, message: "Failed to update settings" }), SAVE_ERROR_FALLBACK);
	assert.equal(saveErrorMessage(new Error("boom")), SAVE_ERROR_FALLBACK);
	assert.equal(saveErrorMessage(undefined), SAVE_ERROR_FALLBACK);
});

test("commit com sucesso: PATCH leva só o patch, tela vê o otimista e fica com a resposta do servidor", async () => {
	const before = view("pt-BR", "env");
	const server = view("en-US", "user");
	const sent: UpdateAccountSettingsInput[] = [];
	const seen: AccountSettingsResponse[] = [];
	const result = await commitSettingsChange({
		view: before,
		patch: { general: { defaultBotLanguage: "en-US" } },
		send: async (input) => {
			sent.push(input);
			return server;
		},
		onOptimistic: (next) => seen.push(next),
	});
	assert.deepEqual(sent, [{ config: { general: { defaultBotLanguage: "en-US" } } }]);
	assert.equal(language(seen[0]!).value, "en-US");
	assert.deepEqual(result, { ok: true, view: server });
});

test("commit com erro: faz rollback para a visão anterior e devolve o erro em pt-BR", async () => {
	const before = view("pt-BR", "env");
	const seen: AccountSettingsResponse[] = [];
	const result = await commitSettingsChange({
		view: before,
		patch: { general: { defaultBotLanguage: "en-US" } },
		send: async () => {
			throw Object.assign(new Error("Failed to update settings"), { status: 503 });
		},
		onOptimistic: (next) => seen.push(next),
	});
	assert.equal(language(seen[0]!).value, "en-US", "mostrou a escolha antes de falhar");
	assert.equal(result.ok, false);
	assert.equal(result.view, before, "volta ao valor anterior");
	assert.equal(result.ok === false && result.error, SAVE_ERROR_FALLBACK);
});

test("voltar a herdar manda null no PATCH", async () => {
	const sent: UpdateAccountSettingsInput[] = [];
	await commitSettingsChange({
		view: view("en-US", "user"),
		patch: { general: { defaultBotLanguage: null } },
		send: async (input) => {
			sent.push(input);
			return view("pt-BR", "env");
		},
	});
	assert.deepEqual(sent, [{ config: { general: { defaultBotLanguage: null } } }]);
});

test("otimista: plano ChatGPT e modelos viram valor do usuário; null (herdar) não inventa valor", () => {
	const before = {
		settings: { sandboxAutoStart: true },
		config: {},
		effective: {
			providers: { chatgptEnabled: { value: false, source: "env" } },
			models: { default: { value: "a/b", source: "env" }, fallbacks: { value: [], source: "default" } },
		},
		capabilities: { openrouterKey: true, isOwner: true },
	} as unknown as AccountSettingsResponse;
	const after = applyOptimisticPatch(before, {
		providers: { chatgptEnabled: true },
		models: { default: "c/d", fallbacks: ["e/f"] },
	});
	const effective = after.effective as unknown as Record<string, Record<string, unknown>>;
	assert.deepEqual(effective.providers!.chatgptEnabled, { value: true, source: "user" });
	assert.deepEqual(effective.models!.default, { value: "c/d", source: "user" });
	assert.deepEqual(effective.models!.fallbacks, { value: ["e/f"], source: "user" });
	assert.equal(applyOptimisticPatch(before, { providers: { chatgptEnabled: null } }), before);
	assert.equal(applyOptimisticPatch(before, { models: { default: null, fallbacks: null } }), before);
	assert.deepEqual((before.effective as unknown as Record<string, Record<string, unknown>>).providers!.chatgptEnabled, {
		value: false,
		source: "env",
	});
});

test("rollback: PATCH de modelo recusado (400) devolve a visão anterior e a mensagem do servidor", async () => {
	const before = {
		settings: { sandboxAutoStart: true },
		config: {},
		effective: { models: { default: { value: "a/b", source: "env" } } },
		capabilities: { openrouterKey: true, isOwner: true },
	} as unknown as AccountSettingsResponse;
	const result = await commitSettingsChange({
		view: before,
		patch: { models: { default: "chatgpt/gpt-5" } },
		send: async () => {
			throw Object.assign(new Error("Ative o plano ChatGPT em Configurações → Provedores para usar este modelo"), { status: 400 });
		},
	});
	assert.equal(result.ok, false);
	assert.equal(result.view, before);
	assert.ok(!result.ok && /Ative o plano ChatGPT/.test(result.error));
});

function fullView(): AccountSettingsResponse {
	const feature = { value: "off", source: "default" };
	return {
		settings: { sandboxAutoStart: true },
		config: { v: 1 },
		effective: {
			jev: { mcp: { value: "off", source: "default" }, features: Object.fromEntries(JEV_FEATURES.map((f) => [f, feature])) },
			execution: { discipline: { value: true, source: "default" } },
			sandboxAutoStart: { value: true, source: "default" },
		},
		capabilities: { openrouterKey: true, isOwner: true },
	} as unknown as AccountSettingsResponse;
}

test("otimista: Jev geral vale para os recursos sem escolha própria; o recurso próprio prevalece", () => {
	const after = applyOptimisticPatch(
		applyOptimisticPatch(fullView(), { jev: { features: { intent: "on" } } }),
		{ jev: { all: "shadow" } },
	);
	assert.equal(after.config.jev?.all, "shadow");
	assert.deepEqual(after.effective.jev.features.intent, { value: "on", source: "user" });
	assert.deepEqual(after.effective.jev.features.tools, { value: "shadow", source: "user" });
	assert.deepEqual(applyOptimisticPatch(fullView(), { jev: { mcp: "gate" } }).effective.jev.mcp, { value: "gate", source: "user" });
});

test("otimista: execução (preset vira prazos do contrato) e navegador", () => {
	const view = fullView();
	const execution = applyOptimisticPatch(view, {
		execution: { discipline: false, contextEconomy: false, llmTimeoutPreset: "short", maxSteps: 25 },
	}).effective.execution;
	assert.deepEqual(execution.discipline, { value: false, source: "user" });
	assert.deepEqual(execution.contextEconomy, { value: false, source: "user" });
	assert.deepEqual(applyOptimisticPatch(view, { execution: { reactionOnly: false } }).effective.execution.reactionOnly, { value: false, source: "user" });
	assert.deepEqual(
		applyOptimisticPatch(view, { execution: { contextMemory: "economy" } }).effective.execution.contextMemory,
		{ value: "economy", source: "user" },
	);
	assert.deepEqual(execution.llmTimeouts, { value: LLM_TIMEOUT_PRESET_VALUES.short, source: "user" });
	assert.deepEqual(execution.maxSteps, { value: 25, source: "user" });
	const sandbox = applyOptimisticPatch(view, {}, { sandboxAutoStart: false });
	assert.deepEqual(sandbox.effective.sandboxAutoStart, { value: false, source: "user" });
	assert.equal(sandbox.settings.sandboxAutoStart, false);
	assert.equal(view.settings.sandboxAutoStart, true, "não muta a visão original");
});

test("commit: sandboxAutoStart vai no mesmo PATCH e erro devolve a visão anterior", async () => {
	const before = fullView();
	const sent: UpdateAccountSettingsInput[] = [];
	const result = await commitSettingsChange({
		view: before,
		patch: {},
		extra: { sandboxAutoStart: false },
		send: async (input) => {
			sent.push(input);
			throw { status: 503, message: "x" };
		},
	});
	assert.deepEqual(sent, [{ sandboxAutoStart: false }], "config vazio não vai no PATCH");
	assert.equal(result.ok, false);
	assert.equal(result.view, before);
});

test("applyOptimisticPatch: escolher modelo de ditado já aparece como valor do usuário", () => {
	const before = { ...view("pt-BR", "default"), effective: { models: { stt: { value: undefined, source: "default" } } } } as unknown as AccountSettingsResponse;
	const after = applyOptimisticPatch(before, { models: { stt: "elevenlabs/scribe-v2" } });
	assert.deepEqual(after.effective.models.stt, { value: "elevenlabs/scribe-v2", source: "user" });
	assert.equal(applyOptimisticPatch(before, { models: { stt: null } }), before);
});
