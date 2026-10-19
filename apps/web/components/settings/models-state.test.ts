import assert from "node:assert/strict";
import test from "node:test";
import type { OpenRouterModel } from "@workspace/shared";
import {
	MODEL_SETTING_OPENROUTER_ONLY,
	dictationDefaultLabel,
	fallbacksInheritLabel,
	fallbacksPatch,
	modelInheritLabel,
	modelPatch,
	modelPickerValue,
	modelsForSetting,
	removeFallbackAt,
	setFallbackAt,
	transcriptionPickerModels,
	userFallbacks,
} from "./models-state";

const model = (
	id: string,
	name: string,
	input: string[] | undefined,
	output: string[] | undefined,
): OpenRouterModel => ({
	id,
	name,
	provider: id.split("/")[0]!,
	contextLength: 1000,
	inputModalities: input,
	outputModalities: output,
});

const catalog = [
	model("openai/gpt-4o-mini", "OpenAI: GPT-4o mini", ["text", "image"], ["text"]),
	model("deepseek/deepseek-v4", "DeepSeek: V4", ["text"], ["text"]),
	model("google/imagen", "Google: Imagen", ["text"], ["image"]),
];

test("herdar mostra a origem e o nome curto do modelo; valor do usuário não herda", () => {
	assert.equal(
		modelInheritLabel({ value: "openai/gpt-4o-mini", source: "env" }, catalog, "nenhum"),
		"Herdar (GPT-4o mini)",
	);
	assert.equal(
		modelInheritLabel({ value: "openai/gpt-4o-mini", source: "default" }, catalog, "nenhum"),
		"Herdar (GPT-4o mini)",
	);
	assert.equal(modelInheritLabel({ value: "openai/gpt-4o-mini", source: "user" }, catalog, "nenhum"), null);
});

test("sem valor herdado mostra o texto do que acontece (imagem desligada, sem reserva)", () => {
	assert.equal(
		modelInheritLabel({ value: undefined, source: "default" }, catalog, "desligado"),
		"Herdar (desligado)",
	);
});

test("id fora do catálogo aparece como está", () => {
	assert.equal(
		modelInheritLabel({ value: "novo/modelo-x", source: "env" }, catalog, "nenhum"),
		"Herdar (novo/modelo-x)",
	);
});

test("valor do seletor: o do usuário, ou vazio (Herdar) enquanto herda", () => {
	assert.equal(modelPickerValue({ value: "a/b", source: "user" }), "a/b");
	assert.equal(modelPickerValue({ value: "a/b", source: "env" }), "");
	assert.equal(modelPickerValue({ value: undefined, source: "default" }), "");
});

test("limpar (escolher Herdar) vira null no PATCH; escolher um modelo envia o id", () => {
	assert.deepEqual(modelPatch("default", ""), { models: { default: null } });
	assert.deepEqual(modelPatch("vision", "openai/gpt-4o-mini"), { models: { vision: "openai/gpt-4o-mini" } });
	assert.deepEqual(modelPatch("image", "google/imagen"), { models: { image: "google/imagen" } });
	assert.deepEqual(modelPatch("maintenance", ""), { models: { maintenance: null } });
});

test("visão lista só modelos que aceitam imagem; imagem só os que geram imagem", () => {
	assert.deepEqual(modelsForSetting("vision", catalog).map((m) => m.id), ["openai/gpt-4o-mini"]);
	assert.deepEqual(modelsForSetting("image", catalog).map((m) => m.id), ["google/imagen"]);
});

test("padrão e manutenção não filtram por capacidade", () => {
	assert.equal(modelsForSetting("default", catalog).length, 3);
	assert.equal(modelsForSetting("maintenance", catalog).length, 3);
});

test("catálogo sem modalidades não filtra (o servidor valida na escrita)", () => {
	const bare = [model("a/x", "A: X", undefined, undefined), model("b/y", "B: Y", undefined, undefined)];
	assert.equal(modelsForSetting("vision", bare).length, 2);
	assert.equal(modelsForSetting("image", bare).length, 2);
});

test("reservas: herdadas não viram lista editável; mostra os nomes herdados", () => {
	const inherited = { value: ["openai/gpt-4o-mini", "deepseek/deepseek-v4"], source: "env" as const };
	assert.deepEqual(userFallbacks(inherited), []);
	assert.equal(
		fallbacksInheritLabel(inherited, catalog),
		"Herdar (GPT-4o mini, V4)",
	);
	assert.equal(fallbacksInheritLabel({ value: [], source: "default" }, catalog), "Herdar (nenhum)");
	assert.deepEqual(userFallbacks({ value: ["a/b"], source: "user" }), ["a/b"]);
	assert.equal(fallbacksInheritLabel({ value: ["a/b"], source: "user" }, catalog), null);
});

test("reservas: até 3, sem repetição; trocar e remover mantêm a ordem", () => {
	let list: string[] = [];
	list = setFallbackAt(list, 0, "a/1");
	list = setFallbackAt(list, 1, "a/2");
	list = setFallbackAt(list, 2, "a/3");
	assert.deepEqual(list, ["a/1", "a/2", "a/3"]);
	assert.deepEqual(setFallbackAt(list, 3, "a/4"), list, "o quarto não entra");
	assert.deepEqual(setFallbackAt(list, 0, "a/2"), list, "repetido em outra posição não muda nada");
	assert.deepEqual(setFallbackAt(list, 1, "a/2"), list, "mesmo id na mesma posição é inofensivo");
	assert.deepEqual(setFallbackAt(list, 1, "b/9"), ["a/1", "b/9", "a/3"]);
	assert.deepEqual(setFallbackAt(list, 0, ""), list, "id vazio é ignorado");
	assert.deepEqual(removeFallbackAt(list, 1), ["a/1", "a/3"]);
});

test("reservas: lista vazia volta a herdar (null); com itens envia a lista", () => {
	assert.deepEqual(fallbacksPatch([]), { models: { fallbacks: null } });
	assert.deepEqual(fallbacksPatch(["a/1", "a/2"]), { models: { fallbacks: ["a/1", "a/2"] } });
});

test("ditado: patch grava models.stt; vazio volta a herdar; só modelos OpenRouter/OpenAI-direto", () => {
	assert.deepEqual(modelPatch("stt", "elevenlabs/scribe-v2"), { models: { stt: "elevenlabs/scribe-v2" } });
	assert.deepEqual(modelPatch("stt", ""), { models: { stt: null } });
	assert.equal(MODEL_SETTING_OPENROUTER_ONLY.stt, true);
});

test("ditado: lista do servidor vira modelos do seletor e o rótulo padrão usa só o nome", () => {
	const picker = transcriptionPickerModels([
		{ id: "openai/whisper-large-v3", name: "OpenAI: Whisper Large V3", vendor: "openai", pricePerMinuteUsd: 0.00045 },
		{ id: "whisper-1", name: "Whisper", vendor: "openai", pricePerMinuteUsd: 0.006 },
	]);
	assert.deepEqual(picker.map((m) => m.id), ["openai/whisper-large-v3", "whisper-1"]);
	assert.equal(dictationDefaultLabel("openai/whisper-large-v3", picker), "Padrão (Whisper Large V3)");
	assert.equal(dictationDefaultLabel("desconhecido/x", picker), "Padrão (desconhecido/x)");
});

test("avisos de capacidade por função", async () => {
	const { modelSettingWarning } = await import("./models-state");
	const models = [
		{ id: "acme/chat-only", name: "Chat", provider: "acme", contextLength: 8000, inputModalities: ["text"], supportedParameters: ["temperature"] },
		{ id: "openai/gpt-5", name: "GPT-5", provider: "openai", contextLength: 400000, inputModalities: ["text", "image"] },
	];
	assert.match(modelSettingWarning("maintenance", "acme/chat-only", models) ?? "", /ferramentas/);
	assert.match(modelSettingWarning("vision", "acme/chat-only", models) ?? "", /não lê imagens/);
	assert.equal(modelSettingWarning("vision", "openai/gpt-5", models), null);
	assert.equal(modelSettingWarning("maintenance", "openai/gpt-5", models), null);
	assert.equal(modelSettingWarning("maintenance", "", models), null);
	assert.equal(modelSettingWarning("image", "acme/chat-only", models), null);
});

test("níveis: só a lista do usuário aparece; a herdada some", async () => {
	const { userTierModels } = await import("./models-state");
	assert.deepEqual(userTierModels({ value: { easy: ["a/x"] }, source: "user" }, "easy"), ["a/x"]);
	assert.deepEqual(userTierModels({ value: { easy: ["a/x"] }, source: "user" }, "hard"), []);
	assert.deepEqual(userTierModels({ value: {}, source: "default" }, "easy"), []);
});

test("níveis: acrescenta até 3, sem repetir, e sobe uma posição", async () => {
	const { setTierModelAt, moveTierModelUp } = await import("./models-state");
	assert.deepEqual(setTierModelAt([], 0, "a/x"), ["a/x"]);
	assert.deepEqual(setTierModelAt(["a/x", "b/y"], 2, "c/z"), ["a/x", "b/y", "c/z"]);
	assert.deepEqual(setTierModelAt(["a/x", "b/y", "c/z"], 3, "d/w"), ["a/x", "b/y", "c/z"]);
	assert.deepEqual(setTierModelAt(["a/x", "b/y"], 2, "a/x"), ["a/x", "b/y"]);
	assert.deepEqual(setTierModelAt(["a/x", "b/y"], 1, "c/z"), ["a/x", "c/z"]);
	assert.deepEqual(moveTierModelUp(["a/x", "b/y", "c/z"], 2), ["a/x", "c/z", "b/y"]);
	assert.deepEqual(moveTierModelUp(["a/x", "b/y"], 0), ["a/x", "b/y"]);
});

test("níveis: patch grava o nível; lista vazia volta a herdar (null); revisor liga e desliga", async () => {
	const { tierPatch, classifyWithReviewerPatch } = await import("./models-state");
	assert.deepEqual(tierPatch("medium", ["a/x", "b/y"]), { models: { tiers: { medium: ["a/x", "b/y"] } } });
	assert.deepEqual(tierPatch("medium", []), { models: { tiers: { medium: null } } });
	assert.deepEqual(classifyWithReviewerPatch(true), { models: { classifyWithReviewer: true } });
});
