import {
	MAX_FALLBACK_MODELS,
	modelDisplayName,
	getModelCapabilities,
	modelSupportsImageInput,
	roleCapabilityWarning,
	type ModelRole,
	type AccountConfigPatch,
	type OpenRouterModel,
	type Resolved,
	type TranscriptionModel,
} from "@workspace/shared";
import { inheritLabel } from "./account-settings-state";

/** Cada modelo configurável da conta (as chaves de `config.models`). */
export type ModelSetting = "default" | "maintenance" | "vision" | "image" | "coding" | "stt";

/** O padrão aceita qualquer provedor; os demais são só OpenRouter (o contrato recusa `chatgpt/*`). */
export const MODEL_SETTING_OPENROUTER_ONLY: Record<ModelSetting, boolean> = {
	default: false,
	maintenance: true,
	vision: true,
	image: true,
	coding: false,
	stt: true,
};

/** Função de cada configuração para checar capacidade (ditado e imagem gerada não exigem visão nem ferramentas). */
const SETTING_ROLE: Partial<Record<ModelSetting, ModelRole>> = {
	default: "default",
	coding: "coding",
	maintenance: "maintenance",
	vision: "vision",
};

/** Aviso quando o modelo escolhido não tem a capacidade que a função exige; `null` = tudo certo (ou sem escolha). */
export function modelSettingWarning(
	setting: ModelSetting,
	id: string,
	models: readonly OpenRouterModel[],
): string | null {
	const role = SETTING_ROLE[setting];
	if (!role || !id) return null;
	return roleCapabilityWarning(role, getModelCapabilities(id, models.find((model) => model.id === id)));
}

/** Modelos de ditado no formato do seletor (o id já traz o vendor, ou é da lista fixa da OpenAI). */
export function transcriptionPickerModels(models: readonly TranscriptionModel[]): OpenRouterModel[] {
	return models.map((model) => ({
		id: model.id,
		name: model.name,
		provider: model.vendor,
		contextLength: null,
	}));
}

/** "Padrão (Whisper Large V3)": o modelo que vale quando a conta não escolhe. */
export function dictationDefaultLabel(defaultModel: string, models: readonly OpenRouterModel[]): string {
	return `Padrão (${modelLabel(defaultModel, models)})`;
}

/**
 * Catálogo oferecido ao seletor de cada configuração. Filtra por capacidade
 * quando o catálogo a expõe (visão = aceita imagem na entrada; imagem = gera
 * imagem na saída). Catálogo sem modalidades (ou sem ninguém com a capacidade)
 * não filtra: o servidor valida o id na escrita.
 */
export function modelsForSetting(
	setting: ModelSetting,
	models: readonly OpenRouterModel[],
): OpenRouterModel[] {
	if (setting === "vision") return keepIfAnyMatch(models, modelSupportsImageInput);
	if (setting === "image") {
		return keepIfAnyMatch(models, (model) => model?.outputModalities?.includes("image") === true);
	}
	return [...models];
}

function keepIfAnyMatch(
	models: readonly OpenRouterModel[],
	test: (model: OpenRouterModel | undefined) => boolean,
): OpenRouterModel[] {
	const matching = models.filter(test);
	return matching.length > 0 ? matching : [...models];
}

/** Nome curto de um id (sem o prefixo do fornecedor); id fora do catálogo aparece como está. */
export function modelLabel(id: string, models: readonly OpenRouterModel[]): string {
	const known = models.find((model) => model.id === id);
	return known ? modelDisplayName(known.name, known.id) : id;
}

/** "Herdar (GPT-4o mini)"; sem valor herdado, `emptyText` ("desligado"). Origem `user` não herda: `null`. */
export function modelInheritLabel(
	resolved: Resolved<string | undefined>,
	models: readonly OpenRouterModel[],
	emptyText: string,
): string | null {
	return inheritLabel(resolved.source, resolved.value ? modelLabel(resolved.value, models) : emptyText);
}

/** Valor do seletor: o id escolhido pelo usuário, ou "" (= "Herdar") enquanto herda. */
export function modelPickerValue(resolved: Resolved<string | undefined>): string {
	return resolved.source === "user" ? (resolved.value ?? "") : "";
}

/** Escolher o item "Herdar" do seletor devolve "", que vira `null` (remove a chave). */
export function modelPatch(setting: ModelSetting, id: string): AccountConfigPatch {
	return { models: { [setting]: id || null } };
}

export function fallbacksInheritLabel(
	resolved: Resolved<string[]>,
	models: readonly OpenRouterModel[],
): string | null {
	const text = resolved.value.length > 0 ? resolved.value.map((id) => modelLabel(id, models)).join(", ") : "nenhum";
	return inheritLabel(resolved.source, text);
}

/** Lista de reserva do usuário (herdada não conta: some a lista editável até ele adicionar). */
export function userFallbacks(resolved: Resolved<string[]>): string[] {
	return resolved.source === "user" ? [...resolved.value] : [];
}

/**
 * Troca a reserva `index` por `id` (ou acrescenta, se `index` é o fim). Sem
 * repetição e até `MAX_FALLBACK_MODELS`; escolher um id que já está em outra
 * posição não muda nada.
 */
export function setFallbackAt(list: readonly string[], index: number, id: string): string[] {
	if (!id || list.some((item, at) => item === id && at !== index)) return [...list];
	const next = [...list];
	if (index >= next.length) {
		if (next.length >= MAX_FALLBACK_MODELS) return next;
		next.push(id);
	} else {
		next[index] = id;
	}
	return next;
}

export function removeFallbackAt(list: readonly string[], index: number): string[] {
	return list.filter((_, at) => at !== index);
}

/** Lista vazia volta a herdar (`null`); a API recusa lista vazia como "valor do usuário". */
export function fallbacksPatch(list: readonly string[]): AccountConfigPatch {
	return { models: { fallbacks: list.length > 0 ? [...list] : null } };
}
