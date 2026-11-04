// Escolha de modelo do chat (Automático, ou um modelo + esforço), salva por conversa, e o que ela vira no corpo do
// `POST /v1/runs`. O formato do corpo é o do web (`createAgentRun` em `apps/web/lib/atlas-api.ts`, montado em
// `use-atlas-chat.ts`): `model` (+ `reasoningEffort` só com modelo escolhido) ou `modelAuto: true`; a API valida em
// `apps/api/src/routes/runs.ts` e decide em `apps/api/src/chat/effective-model.ts`.
import { effortForModel, parseModelRef, parseReasoningEffort, type ModelCatalogInfo, type ReasoningEffort } from "@workspace/shared";
import type { CacheStorage } from "./home-cache";
import { findOption, type BotModelInfo, type ModelCatalog } from "./model-catalog";

export type ModelChoice = { mode: "auto" } | { mode: "model"; model: string; effort?: ReasoningEffort };

/** Campos do corpo do run que a escolha controla. Vazio = o servidor decide (modelo do bot; sem modelo, o Automático). */
export type RunModelFields = { model?: string; modelAuto?: true; reasoningEffort?: ReasoningEffort };

/** Nível sugerido no seletor ("Recomendado"): decisão de produto do app, não vem do backend. */
export const RECOMMENDED_EFFORT: ReasoningEffort = "medium";

const MODEL_ID_MAX = 200;

/**
 * Corpo do run a partir da escolha:
 * - sem escolha: nada (o servidor respeita o modelo fixo do bot; mandar `modelAuto: true` aqui o ignorava);
 * - Automático: `modelAuto: true` e nenhum modelo;
 * - modelo: `model`, sem `modelAuto`, e `reasoningEffort` só se o modelo aceita níveis. Com o catálogo em mãos o nível
 *   passa pelo mesmo filtro do web ("Desligado" vira "Baixo" onde o modelo não desliga); sem catálogo, o nível salvo
 *   (escolhido numa tela que só o oferece a quem suporta) segue e o servidor ignora o que não valer.
 */
export function runModelFields(choice: ModelChoice | null, infoOf?: (modelId: string) => ModelCatalogInfo | undefined): RunModelFields {
	if (!choice) return {};
	if (choice.mode === "auto") return { modelAuto: true };
	const info = infoOf?.(choice.model);
	// Sem o catálogo (app recém-aberto, folha ainda não abriu) não se sabe se o modelo desliga o raciocínio: "off" não vai.
	const effort = choice.effort ? (info ? effortForModel(choice.effort, choice.model, info) : choice.effort === "off" ? undefined : choice.effort) : undefined;
	return { model: choice.model, ...(effort ? { reasoningEffort: effort } : {}) };
}

/**
 * O que o seletor marca: a escolha salva ou, sem ela, o que a API vai fazer: bot com níveis próprios roda no Automático,
 * bot com modelo fixo usa o modelo, bot sem nenhum dos dois roda no Automático. Sem ler o bot, `unknown`: não marca nada.
 */
export function currentSelection(choice: ModelChoice | null, bot: BotModelInfo | null): ModelChoice | { mode: "unknown" } {
	if (choice) return choice;
	if (!bot?.known) return { mode: "unknown" };
	if (bot.tiers || !bot.model) return { mode: "auto" };
	return { mode: "model", model: bot.model };
}

/** Escolha cujo modelo sumiu do catálogo (e não é o do bot) deixa de valer. Só descarta o que dá para afirmar que sumiu. */
export function reconcileWithCatalog(choice: ModelChoice | null, catalog: ModelCatalog): ModelChoice | null {
	if (!choice || choice.mode !== "model") return choice;
	if (findOption(catalog, choice.model) || choice.model === catalog.bot.model) return choice;
	// Modelo de plano ChatGPT ou de chave própria só se descarta com todas as fontes lidas; os do catálogo geral, sempre.
	let own = false;
	try {
		own = parseModelRef(choice.model).provider !== "openrouter";
	} catch {
		own = false;
	}
	return own && !catalog.complete ? choice : null;
}

/**
 * Abriu a conversa e leu a escolha salva: qual vale agora. Chat novo que acabou de criar a conversa (`previousConversationId`
 * nulo) mantém a escolha que já estava na tela, e uma escolha feita enquanto lia nunca é pisada pelo valor lido.
 */
export function reconcileLoaded(input: { saved: ModelChoice | null; current: ModelChoice | null; previousConversationId: string | null; changedDuringLoad: boolean }): ModelChoice | null {
	if (input.changedDuringLoad) return input.current;
	if (input.previousConversationId === null) return input.current ?? input.saved;
	return input.saved;
}

// ---- persistência por conversa -----------------------------------------------------------------------------------
// O prefixo `atlas.chat.` faz o `clearChatCache` (sair da conta) apagar a escolha junto com o cache das conversas.

export const MODEL_CHOICE_VERSION = 1;
const PREFIX = `atlas.chat.model.v${MODEL_CHOICE_VERSION}:`;

export const modelChoiceKey = (serverUrl: string, email: string, conversationId: string) => `${PREFIX}${serverUrl}|${email.toLowerCase()}|${conversationId}`;

export function serializeModelChoice(choice: ModelChoice): string {
	return JSON.stringify(choice.mode === "auto" ? { v: MODEL_CHOICE_VERSION, mode: "auto" } : { v: MODEL_CHOICE_VERSION, mode: "model", model: choice.model, ...(choice.effort ? { effort: choice.effort } : {}) });
}

/** Valor salvo -> escolha. Qualquer coisa fora do formato (JSON quebrado, versão antiga, modelo vazio ou enorme) = sem escolha. */
export function parseModelChoice(raw: string | null): ModelChoice | null {
	if (!raw) return null;
	try {
		const value = JSON.parse(raw) as unknown;
		if (typeof value !== "object" || value === null) return null;
		const record = value as Record<string, unknown>;
		if (record.v !== MODEL_CHOICE_VERSION) return null;
		if (record.mode === "auto") return { mode: "auto" };
		if (record.mode !== "model" || typeof record.model !== "string") return null;
		const model = record.model.trim();
		if (!model || model.length > MODEL_ID_MAX) return null;
		const effort = parseReasoningEffort(record.effort);
		return { mode: "model", model, ...(effort ? { effort } : {}) };
	} catch {
		return null;
	}
}

/** Nunca lança: disco bloqueado ou cheio = sem escolha salva (o seletor volta ao padrão do bot). */
export async function loadModelChoice(storage: CacheStorage, key: string): Promise<ModelChoice | null> {
	try {
		return parseModelChoice(await storage.getItem(key));
	} catch {
		return null;
	}
}

export async function saveModelChoice(storage: CacheStorage, key: string, choice: ModelChoice | null): Promise<void> {
	try {
		if (choice) await storage.setItem(key, serializeModelChoice(choice));
		else await storage.removeItem(key);
	} catch {
		// conveniência: a escolha vale nesta sessão mesmo sem disco
	}
}
