// Cache local da conversa (AsyncStorage): o chat abre na hora com as últimas mensagens e a rede atualiza por cima.
// Mesma ideia do cache da home: a chave leva servidor + e-mail + conversa (trocar de conta nunca mostra o fio da
// outra), só vai para o disco o que a tela desenha, e `clearChatCache` apaga tudo ao sair.
import type { CacheStorage } from "./home-cache";
import type { ChatItem, ConfirmStatus, QuestionnaireStatus, TaskItem } from "./chat-types";

export const CHAT_CACHE_VERSION = 1;
const ALL_VERSIONS_PREFIX = "atlas.chat.";
const PREFIX = `${ALL_VERSIONS_PREFIX}v${CHAT_CACHE_VERSION}:`;
export const CHAT_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** Só o fim da conversa: as últimas mensagens bastam para abrir na hora (o resto se busca rolando). */
export const CHAT_CACHE_MAX_ITEMS = 40;
/** O AsyncStorage do Android lê cada valor por uma janela de ~2 MB: o cache fica bem abaixo disso. */
export const CHAT_CACHE_MAX_BYTES = 400_000;
/** Texto de cada mensagem no disco: o suficiente para abrir na hora (o resto vem do servidor). */
export const CHAT_CACHE_MAX_TEXT = 4_000;
const MAX_TEXT = CHAT_CACHE_MAX_TEXT;

export const chatCacheKey = (serverUrl: string, email: string, conversationId: string) => `${PREFIX}${serverUrl}|${email.toLowerCase()}|${conversationId}`;

export type CachedChat = { items: ChatItem[]; savedAt: number };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const isString = (value: unknown): value is string => typeof value === "string";

const CONFIRM: readonly ConfirmStatus[] = ["pending", "approved", "rejected", "failed"];
const QUESTIONNAIRE: readonly QuestionnaireStatus[] = ["pending", "submitted", "dismissed"];
const TASK: readonly TaskItem["status"][] = ["pending", "in_progress", "completed"];
const WEB_CARDS = ["chart", "page", "file", "routine", "login", "images", "proposal", "approval"] as const;

function pickTasks(value: unknown): TaskItem[] | null {
	if (!Array.isArray(value)) return null;
	const out: TaskItem[] = [];
	for (const entry of value) {
		if (!isRecord(entry) || !isString(entry.content) || !TASK.includes(entry.status as TaskItem["status"])) return null;
		out.push({ content: entry.content.slice(0, 200), status: entry.status as TaskItem["status"] });
	}
	return out;
}

/** Reconstrói campo a campo: qualquer chave a mais no disco não passa, e item estranho vira `null`. */
export function pickItem(value: unknown): ChatItem | null {
	if (!isRecord(value) || !isString(value.id) || !isString(value.kind)) return null;
	const base = { id: value.id, ...(isString(value.createdAt) ? { createdAt: value.createdAt } : {}) };
	switch (value.kind) {
		case "user":
			return isString(value.text) ? { ...base, kind: "user", text: value.text.slice(0, MAX_TEXT) } : null;
		case "assistant":
			return isString(value.text) ? { ...base, kind: "assistant", text: value.text.slice(0, MAX_TEXT), ...(isString(value.runId) ? { runId: value.runId } : {}) } : null;
		case "marker":
			return isString(value.text) ? { ...base, kind: "marker", text: value.text.slice(0, 200) } : null;
		case "task-list": {
			const items = pickTasks(value.items);
			return items && isString(value.runId) ? { ...base, kind: "task-list", runId: value.runId, items } : null;
		}
		case "confirm":
			if (!isString(value.confirmId) || !isString(value.title) || !CONFIRM.includes(value.status as ConfirmStatus)) return null;
			return {
				...base,
				kind: "confirm",
				confirmId: value.confirmId,
				title: value.title.slice(0, 300),
				status: value.status as ConfirmStatus,
				...(isString(value.description) ? { description: value.description.slice(0, 1_000) } : {}),
				...(isString(value.confirmLabel) ? { confirmLabel: value.confirmLabel.slice(0, 60) } : {}),
				...(isString(value.cancelLabel) ? { cancelLabel: value.cancelLabel.slice(0, 60) } : {}),
			};
		case "questionnaire":
			// Respostas e perguntas inteiras não vão para o disco: o cartão reabre pelo servidor. Aqui fica só o que o fio desenha.
			if (!isString(value.questionnaireId) || !isString(value.title) || !QUESTIONNAIRE.includes(value.status as QuestionnaireStatus)) return null;
			return { ...base, kind: "questionnaire", questionnaireId: value.questionnaireId, title: value.title.slice(0, 300), items: [], status: value.status as QuestionnaireStatus };
		case "web-card":
			if (!isString(value.title) || !isString(value.key) || !WEB_CARDS.includes(value.card as (typeof WEB_CARDS)[number])) return null;
			return { ...base, kind: "web-card", card: value.card as (typeof WEB_CARDS)[number], title: value.title.slice(0, 200), key: value.key };
		default:
			return null;
	}
}

export function serializeChat(items: readonly ChatItem[], now: number): string {
	// Só o que o servidor gravou: balão otimista (`msg-*`) e fala em andamento (`cu-*`) não vão para o disco.
	// Cartão que espera resposta (confirm/questionário pendente) fica de fora: o estado de verdade vem do servidor.
	const settled = items.filter((item) => !item.id.startsWith("msg-") && !item.id.startsWith("cu-") && !(item.kind === "questionnaire" && item.status === "pending") && !(item.kind === "confirm" && item.status === "pending"));
	let picked = settled.slice(-CHAT_CACHE_MAX_ITEMS).map(pickItem).filter((item): item is ChatItem => item !== null);
	let text = JSON.stringify({ v: CHAT_CACHE_VERSION, savedAt: now, items: picked });
	while (text.length > CHAT_CACHE_MAX_BYTES && picked.length > 1) {
		picked = picked.slice(Math.ceil(picked.length / 4));
		text = JSON.stringify({ v: CHAT_CACHE_VERSION, savedAt: now, items: picked });
	}
	return text;
}

export function parseChat(raw: string | null, now: number): CachedChat | null {
	if (!raw) return null;
	try {
		const data = JSON.parse(raw) as { v?: unknown; savedAt?: unknown; items?: unknown } | null;
		if (!data || data.v !== CHAT_CACHE_VERSION || typeof data.savedAt !== "number" || !Array.isArray(data.items)) return null;
		if (now - data.savedAt > CHAT_CACHE_MAX_AGE_MS) return null;
		return { items: data.items.map(pickItem).filter((item): item is ChatItem => item !== null), savedAt: data.savedAt };
	} catch {
		return null;
	}
}

export async function loadChatCache(storage: CacheStorage, key: string, now: number): Promise<CachedChat | null> {
	try {
		return parseChat(await storage.getItem(key), now);
	} catch {
		return null;
	}
}

export async function saveChatCache(storage: CacheStorage, key: string, items: readonly ChatItem[], now: number): Promise<void> {
	try {
		await storage.setItem(key, serializeChat(items, now));
	} catch {
		// cache é só conveniência: disco cheio ou bloqueado não pode quebrar a tela
	}
}

/** Apaga o cache de todas as conversas de todas as contas e versões. Devolve `false` se falhou (nunca lança). */
export async function clearChatCache(storage: CacheStorage): Promise<boolean> {
	try {
		const keys = (await storage.getAllKeys()).filter((key) => key.startsWith(ALL_VERSIONS_PREFIX));
		await Promise.all(keys.map((key) => storage.removeItem(key)));
		return true;
	} catch {
		return false;
	}
}

/**
 * Escritor do cache com "época": `invalidate()` (sair, trocar de conta) faz qualquer gravação que ainda estava em voo
 * se desfazer ao terminar (a mesma ideia da guarda de geração da home), então nada de uma conta velha sobra no disco.
 */
export function createChatCacheWriter(storage: CacheStorage) {
	let epoch = 0;
	return {
		invalidate(): void {
			epoch += 1;
		},
		async write(key: string, items: readonly ChatItem[], now: number): Promise<void> {
			const started = epoch;
			await saveChatCache(storage, key, items, now);
			if (epoch !== started) await storage.removeItem(key).catch(() => undefined);
		},
	};
}
