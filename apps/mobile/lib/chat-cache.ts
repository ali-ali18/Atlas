// Cache local da conversa (AsyncStorage): o chat abre na hora com as últimas mensagens e a rede atualiza por cima.
// Mesma ideia do cache da home: a chave leva servidor + e-mail + conversa (trocar de conta nunca mostra o fio da
// outra), só vai para o disco o que a tela desenha, e `clearChatCache` apaga tudo ao sair.
import type { CacheStorage } from "./home-cache";
import type { BotTag, ChatItem, ConfirmStatus, ProposalStatus, QuestionnaireStatus, TaskItem } from "./chat-types";

// v2: cartões de proposta de bot passaram a ser nativos (o v1 guardava a linha "Abrir no navegador"). v3: a fala trocada entre bots
// ganhou a marca `bot` (vira o marcador "N mensagens com X"); o cache antigo é descartado em vez de adivinhar pelo texto.

export const CHAT_CACHE_VERSION = 3;
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
const PROPOSAL: readonly ProposalStatus[] = ["pending", "approved", "rejected"];
const PROFILE_FIELDS = ["name", "snippet", "description", "openRouterModel"] as const;
const BOT_KINDS: readonly BotTag["kind"][] = ["request", "reply", "answer"];
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

/** Origem "outro bot" da fala: sem ela (cache antigo) a fala volta como balão comum e a rede corrige por cima. */
function pickBotTag(value: unknown): BotTag | null {
	if (!isRecord(value) || !BOT_KINDS.includes(value.kind as BotTag["kind"])) return null;
	return {
		kind: value.kind as BotTag["kind"],
		...(isString(value.fromBotId) ? { fromBotId: value.fromBotId.slice(0, 100) } : {}),
		...(isString(value.fromBotName) ? { fromBotName: value.fromBotName.slice(0, 100) } : {}),
		...(isString(value.botMessageId) ? { botMessageId: value.botMessageId.slice(0, 100) } : {}),
	};
}

/** Reconstrói campo a campo: qualquer chave a mais no disco não passa, e item estranho vira `null`. */
export function pickItem(value: unknown): ChatItem | null {
	if (!isRecord(value) || !isString(value.id) || !isString(value.kind)) return null;
	const base = { id: value.id, ...(isString(value.createdAt) ? { createdAt: value.createdAt } : {}) };
	switch (value.kind) {
		case "user": {
			const bot = pickBotTag(value.bot);
			return isString(value.text) ? { ...base, kind: "user", text: value.text.slice(0, MAX_TEXT), ...(bot ? { bot } : {}) } : null;
		}
		case "assistant": {
			const bot = pickBotTag(value.bot);
			return isString(value.text) ? { ...base, kind: "assistant", text: value.text.slice(0, MAX_TEXT), ...(isString(value.runId) ? { runId: value.runId } : {}), ...(bot ? { bot } : {}) } : null;
		}
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
		case "bot-proposal": {
			// Só o que o cartão desenha; o texto longo (briefing, primeira tarefa) é cortado.
			if (!isString(value.proposalId) || !isString(value.name) || !isString(value.description) || !isString(value.color) || !isString(value.shape) || !PROPOSAL.includes(value.status as ProposalStatus)) return null;
			return {
				...base,
				kind: "bot-proposal",
				proposalId: value.proposalId,
				status: value.status as ProposalStatus,
				name: value.name.slice(0, 80),
				description: value.description.slice(0, 600),
				color: value.color.slice(0, 20),
				shape: value.shape.slice(0, 40),
				model: isString(value.model) ? value.model.slice(0, 120) : null,
				skills: Array.isArray(value.skills) ? value.skills.filter(isString).slice(0, 5).map((skill) => skill.slice(0, 60)) : [],
				firstTask: isString(value.firstTask) ? value.firstTask.slice(0, 600) : null,
				...(isString(value.botId) ? { botId: value.botId } : {}),
			};
		}
		case "bot-profile": {
			if (!isString(value.proposalId) || !isString(value.botId) || !PROPOSAL.includes(value.status as ProposalStatus) || !Array.isArray(value.fields) || !isRecord(value.before) || !isRecord(value.after)) return null;
			const fields = value.fields.filter((field): field is (typeof PROFILE_FIELDS)[number] => PROFILE_FIELDS.includes(field as (typeof PROFILE_FIELDS)[number]));
			if (fields.length === 0) return null;
			const text = (raw: unknown) => (isString(raw) ? raw.slice(0, 600) : null);
			const before = { name: text(value.before.name) ?? "", snippet: text(value.before.snippet) ?? "", description: text(value.before.description), openRouterModel: text(value.before.openRouterModel) };
			const after: Extract<ChatItem, { kind: "bot-profile" }>["after"] = {};
			if (isString(value.after.name)) after.name = value.after.name.slice(0, 80);
			if (isString(value.after.snippet)) after.snippet = value.after.snippet.slice(0, 200);
			if (isString(value.after.description) || value.after.description === null) after.description = text(value.after.description);
			if (isString(value.after.openRouterModel) || value.after.openRouterModel === null) after.openRouterModel = text(value.after.openRouterModel);
			return { ...base, kind: "bot-profile", proposalId: value.proposalId, botId: value.botId, status: value.status as ProposalStatus, fields, before, after };
		}
		case "web-card":
			if (!isString(value.title) || !isString(value.key) || !WEB_CARDS.includes(value.card as (typeof WEB_CARDS)[number])) return null;
			// `pageId` só vale em painel e só se for texto curto: cache antigo (sem ele) cai no "Abrir no navegador".
			return {
				...base,
				kind: "web-card",
				card: value.card as (typeof WEB_CARDS)[number],
				title: value.title.slice(0, 200),
				key: value.key,
				...(value.card === "page" && isString(value.pageId) && value.pageId.length > 0 && value.pageId.length <= 160 ? { pageId: value.pageId } : {}),
				...(value.card === "page" && typeof value.revision === "number" && Number.isFinite(value.revision) ? { revision: value.revision } : {}),
				...(value.card === "page" && typeof value.sourceCount === "number" && Number.isFinite(value.sourceCount) ? { sourceCount: value.sourceCount } : {}),
				// Arquivo: id curto, mime em texto curto e tamanho finito e não negativo; sem eles o cartão cai no navegador.
				...(value.card === "file" && isString(value.fileId) && value.fileId.length > 0 && value.fileId.length <= 160 ? { fileId: value.fileId } : {}),
				...(value.card === "file" && isString(value.fileId) && value.fileId.length > 0 && value.fileId.length <= 160 && isString(value.mime) && value.mime.length > 0 && value.mime.length <= 120 ? { mime: value.mime } : {}),
				...(value.card === "file" && isString(value.fileId) && value.fileId.length > 0 && value.fileId.length <= 160 && typeof value.size === "number" && Number.isFinite(value.size) && value.size >= 0 ? { size: value.size } : {}),
			};
		default:
			return null;
	}
}

export function serializeChat(items: readonly ChatItem[], now: number): string {
	// Só o que o servidor gravou: balão otimista (`msg-*`) e fala em andamento (`cu-*`) não vão para o disco.
	// Cartão que espera resposta (confirm/questionário pendente) fica de fora: o estado de verdade vem do servidor.
	const settled = items.filter((item) => !item.id.startsWith("msg-") && !item.id.startsWith("cu-") && !(item.kind === "questionnaire" && item.status === "pending") && !(item.kind === "confirm" && item.status === "pending") && !((item.kind === "bot-proposal" || item.kind === "bot-profile") && item.status === "pending"));
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
