// Escolha de modelo do chat (Automático, ou um modelo + esforço), salva por conversa, e o que ela vira no corpo do
// `POST /v1/runs`. O formato do corpo é o do web (`createAgentRun` em `apps/web/lib/atlas-api.ts`, montado em
// `use-atlas-chat.ts`): `model` (+ `reasoningEffort` só com modelo escolhido) ou `modelAuto: true`; a API valida em
// `apps/api/src/routes/runs.ts` e decide em `apps/api/src/chat/effective-model.ts`.
import { effortForModel, parseReasoningEffort, type ModelCatalogInfo, type ReasoningEffort } from "@workspace/shared";
import type { CacheStorage } from "./home-cache";

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
	const effort = choice.effort ? (info ? effortForModel(choice.effort, choice.model, info) : choice.effort) : undefined;
	return { model: choice.model, ...(effort ? { reasoningEffort: effort } : {}) };
}

/** O que o seletor marca: a escolha salva ou, sem ela, o modelo fixo do bot (sem modelo fixo, o Automático). */
export function currentSelection(choice: ModelChoice | null, botModel: string | null): ModelChoice {
	if (choice) return choice;
	return botModel ? { mode: "model", model: botModel } : { mode: "auto" };
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
