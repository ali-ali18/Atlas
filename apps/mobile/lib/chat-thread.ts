// Fio da conversa: do que o servidor grava (`SessionMessage`) ao que a tela desenha, e a junção do gravado com o
// que só existe ao vivo (balão do usuário ainda não gravado, fala em andamento, cartões do run). Porta enxuta do
// `use-atlas-chat.ts` / `thread-merge.ts` / `thread-live.ts` do web: o gravado manda, o ao vivo preenche o resto.
import { BOT_LINK_ROLE, formatSourceMarker, isCardConfirmToken, type MessageSource, parseBotLinkCard, parseBotMessageContent, parseConversationCard, type PersistedConversationCard, type SessionMessage } from "@workspace/shared";
import type { BotTag, ChatItem, Reaction, TaskItem } from "./chat-types";
import { applyDecidedProposals, botProfileToItem, botProposalToItem, proposalKey } from "./bot-cards";
import { parseReplyTo } from "./reply-quote";

const CARD_ROLES = new Set([
	"skill", "confirm", "login", "file", "routine", "tool-budget", "jev-status", "provider-fallback", "subagents", "routine-proposal", "bot-proposal",
	"images", "code-run", "chart", "page", "task-list", "compaction", "revised-draft", "questionnaire", "bot-profile", "skill-proposal",
]);

/** Texto que os botões dos cartões enviam ("confirmado: …", "recusado: …", "cancela isso"): não é fala, não aparece. */
export function isCardProtocolText(text: string): boolean {
	return isCardConfirmToken(text) || /^cancela isso$/i.test(text.trim());
}

/** Identidade do painel no cartão (abre a tela nativa): só o que cabe no fio, sem o spec (a tela busca no servidor). */
export function pageRef(pageId: string, revision: number, sourceCount: number): { pageId: string; revision: number; sourceCount: number } {
	return { pageId, revision, sourceCount };
}

/** Identidade do arquivo no cartão (abre a folha do documento): id, mime e tamanho, sem o conteúdo. */
export function fileRef(artifactId: string, mime: string | undefined, size: number | undefined): { fileId: string; mime?: string; size?: number } {
	return { fileId: artifactId, ...(mime ? { mime } : {}), ...(typeof size === "number" && Number.isFinite(size) ? { size } : {}) };
}

export function cardToItem(id: string, card: PersistedConversationCard, createdAt?: string): ChatItem | null {
	const base = { id, ...(createdAt ? { createdAt } : {}) };
	switch (card.kind) {
		case "confirm":
			// Aprovação de comando, segredos, chave de e-mail e GitHub têm telas próprias no web.
			if (card.devApproval || card.secretsRequest || card.emailKeyRequest || card.githubIdentity) {
				return { ...base, kind: "web-card", card: "approval", title: card.title, key: `confirm:${card.confirmId}` };
			}
			return {
				...base,
				kind: "confirm",
				confirmId: card.confirmId,
				title: card.title,
				status: card.status,
				...(card.description ? { description: card.description } : {}),
				...(card.confirmLabel ? { confirmLabel: card.confirmLabel } : {}),
				...(card.cancelLabel ? { cancelLabel: card.cancelLabel } : {}),
			};
		case "questionnaire":
			return {
				...base,
				kind: "questionnaire",
				questionnaireId: card.questionnaireId,
				title: card.title,
				items: card.items,
				status: card.status,
				...(card.description ? { description: card.description } : {}),
				...(card.answers ? { answers: card.answers } : {}),
			};
		case "task-list":
			return { ...base, kind: "task-list", runId: card.runId, items: card.items };
		case "compaction":
			return { ...base, kind: "marker", text: `Conversa compactada · ${card.before} → ${card.after}` };
		case "chart":
			return { ...base, kind: "web-card", card: "chart", title: "Gráfico", key: `chart:${card.chartId}` };
		case "page":
			return { ...base, kind: "web-card", card: "page", title: card.title, key: `page:${card.pageId}`, ...pageRef(card.pageId, card.revision, card.sourceCount) };
		case "file":
			return { ...base, kind: "web-card", card: "file", title: card.filename, key: `file:${card.artifactId}`, ...fileRef(card.artifactId, card.mime, card.size) };
		case "routine":
			return { ...base, kind: "web-card", card: "routine", title: card.title ?? "Rotina", key: `routine:${card.routineId ?? id}` };
		case "login":
			return { ...base, kind: "web-card", card: "login", title: `Entrar em ${card.site}`, key: `login:${card.loginId}` };
		case "images":
			return { ...base, kind: "web-card", card: "images", title: "Imagens", key: `images:${id}` };
		case "bot-proposal":
			return botProposalToItem(id, card, createdAt);
		case "bot-profile":
			return botProfileToItem(id, card, createdAt);
		case "routine-proposal":
			return { ...base, kind: "web-card", card: "proposal", title: "Proposta de rotina", key: `${card.kind}:${id}` };
		default:
			// habilidade, subagentes, orçamento de ferramenta, revisão, execução de código: ficam só no web.
			return null;
	}
}

/** Reações vindas do servidor (máximo uma por ator, emoji curto); nada válido = sem reações. */
function validReactions(raw: SessionMessage["reactions"]): Reaction[] | null {
	if (!Array.isArray(raw)) return null;
	const out: Reaction[] = [];
	for (const reaction of raw) {
		if ((reaction.actor !== "user" && reaction.actor !== "bot") || typeof reaction.emoji !== "string") continue;
		const emoji = reaction.emoji.trim();
		if (!emoji || emoji.length > 16 || out.some((item) => item.actor === reaction.actor)) continue;
		out.push({ actor: reaction.actor, emoji });
	}
	return out.length ? out : null;
}

const sourceKey = (source: MessageSource) => `${source.kind}|${source.label}|${source.at}`;

/**
 * Marcador "Rotina · Resumo da agenda · 07:00" acima da fala que abre um trecho da mesma origem (rotina, lembrete,
 * evento), como o `SourceMarker` do web. Falas seguidas da mesma execução ficam sob um marcador só.
 */
export function withSourceMarkers(items: readonly ChatItem[], timeZone?: string): ChatItem[] {
	const out: ChatItem[] = [];
	let previous: string | null = null;
	for (const item of items) {
		// Qualquer item sem origem (fala do usuário, cartão, lista de tarefas) fecha o trecho, como o `sourceMarkerIds` do web.
		const key = item.kind === "assistant" && item.source ? sourceKey(item.source) : null;
		if (item.kind === "assistant" && item.source && key !== previous) {
			out.push({ id: `source-${item.id}`, kind: "marker", text: formatSourceMarker(item.source, timeZone), ...(item.createdAt ? { createdAt: item.createdAt } : {}) });
		}
		previous = key;
		out.push(item);
	}
	return out;
}

/** Uma linha gravada do servidor vira o que a tela desenha; `null` = não aparece (protocolo de cartão, vazia, só do web). */
export function sessionMessageToItem(message: SessionMessage): ChatItem | null {
	const createdAt = message.createdAt;
	const role = message.role as string;
	if (role === BOT_LINK_ROLE) {
		const link = parseBotLinkCard(message.content);
		return link ? { id: message.id, kind: "marker", createdAt, text: `Enviou mensagem para ${link.botName}${link.title ? `: ${link.title}` : ""}` } : null;
	}
	// Fala trocada entre bots (origem `bot`): não é do usuário. Fica marcada para o fio virar "N mensagens com X".
	if (message.origin === "bot" && (role === "user" || role === "assistant")) {
		const framed = role === "user" ? parseBotMessageContent(message.content) : null;
		if (role === "assistant" && !message.content.trim()) return null;
		const bot: BotTag = {
			kind: role === "assistant" ? "answer" : (framed?.kind ?? "request"),
			...(message.fromBotId ? { fromBotId: message.fromBotId } : {}),
			...(message.fromBotName ? { fromBotName: message.fromBotName } : {}),
			...(message.botMessageId ? { botMessageId: message.botMessageId } : {}),
		};
		return { id: message.id, kind: role, text: framed?.text ?? message.content, createdAt, bot };
	}
	const reactions = validReactions(message.reactions);
	// `replyTo` é do contrato novo do servidor (pode faltar em servidor antigo): lido sem confiar no formato.
	const replyTo = parseReplyTo((message as { replyTo?: unknown }).replyTo);
	if (role === "user") {
		if (isCardProtocolText(message.content)) return null;
		return { id: message.id, kind: "user", text: message.content, createdAt, ...(reactions ? { reactions } : {}), ...(replyTo ? { replyTo } : {}) };
	}
	if (role === "assistant") {
		if (!message.content.trim()) return null;
		return {
			id: message.id,
			kind: "assistant",
			text: message.content,
			createdAt,
			...(message.runId ? { runId: message.runId } : {}),
			...(reactions ? { reactions } : {}),
			...(message.source ? { source: message.source } : {}),
			...(replyTo ? { replyTo } : {}),
		};
	}
	if (CARD_ROLES.has(role)) {
		const card = parseConversationCard(message.content);
		return card ? cardToItem(message.id, card, createdAt) : null;
	}
	return null;
}

export type MessagePage = { messages: SessionMessage[]; hasMore: boolean };

export function parsePage(body: unknown): MessagePage | null {
	if (typeof body !== "object" || body === null) return null;
	const { messages, hasMore } = body as { messages?: unknown; hasMore?: unknown };
	if (!Array.isArray(messages)) return null;
	const rows = messages.filter(
		(row): row is SessionMessage =>
			typeof row === "object" && row !== null && typeof (row as SessionMessage).id === "string" && typeof (row as SessionMessage).role === "string" && typeof (row as SessionMessage).content === "string" && typeof (row as SessionMessage).createdAt === "string",
	);
	return { messages: rows, hasMore: hasMore === true };
}

export type PageCursor = { createdAt: string; id: string };

/** O mais antigo da página (a lista vem do mais antigo para o mais novo): de onde buscar as mais velhas. */
export function oldestCursor(rows: readonly { id: string; createdAt: string }[]): PageCursor | null {
	const first = rows[0];
	return first ? { createdAt: first.createdAt, id: first.id } : null;
}

export const PAGE_SIZE = 30;

/** Caminho da página de mensagens (mesmos parâmetros do web: `limit`, `beforeCreatedAt`, `beforeId`). */
export function messagesPath(conversationId: string, options: { limit?: number; before?: PageCursor | null } = {}): string {
	const params: string[] = [];
	if (options.limit !== undefined) params.push(`limit=${options.limit}`);
	if (options.before) params.push(`beforeCreatedAt=${encodeURIComponent(options.before.createdAt)}`, `beforeId=${encodeURIComponent(options.before.id)}`);
	return `/v1/conversations/${encodeURIComponent(conversationId)}/messages${params.length ? `?${params.join("&")}` : ""}`;
}

/** Mensagens mais velhas entram antes; o que já está na lista (mesmo id) não repete. */
export function prependOlder(current: readonly ChatItem[], older: readonly ChatItem[]): ChatItem[] {
	const known = new Set(current.map((item) => item.id));
	return [...older.filter((item) => !known.has(item.id)), ...current];
}

/**
 * Junta o fim recém-buscado com o que a tela já tem: as mais antigas ficam, o fim vem do servidor. Se o fim buscado
 * não alcança nada do que está na tela (lacuna), vale só o que veio e o resto se busca rolando para cima.
 */
export function mergeTail(current: readonly ChatItem[], tail: readonly ChatItem[]): { items: ChatItem[]; gap: boolean } {
	const first = tail[0];
	if (!first) return { items: [...current], gap: false };
	const index = current.findIndex((item) => item.id === first.id);
	if (index >= 0) return { items: [...current.slice(0, index), ...tail], gap: false };
	const known = new Set(current.map((item) => item.id));
	const overlaps = tail.some((item) => known.has(item.id));
	if (overlaps) {
		// o início do fim buscado é mais novo que o início da tela: o que casa fica no lugar do servidor
		const firstKnown = tail.findIndex((item) => known.has(item.id));
		const at = current.findIndex((item) => item.id === tail[firstKnown]!.id);
		return { items: [...current.slice(0, at), ...tail.slice(firstKnown)], gap: false };
	}
	return { items: [...tail], gap: true };
}

// ---- gravado × ao vivo -------------------------------------------------------------------------------------

function normalize(text: string): string {
	return text.trim().split(/\s+/).join(" ");
}

/** Falas curtas ("Ok.") repetem entre turnos: só as longas contam como a mesma fala. */
const MIN_COVERED_LENGTH = 16;

/** O texto já existe nas linhas gravadas do assistente: igual a uma linha ou à junção de linhas consecutivas. */
export function persistedAssistantCovers(rows: readonly ChatItem[], text: string): boolean {
	const target = normalize(text);
	if (!target) return false;
	for (let start = 0; start < rows.length; start += 1) {
		let joined = "";
		for (let end = start; end < rows.length; end += 1) {
			const item = rows[end];
			if (!item || item.kind !== "assistant") break;
			joined = joined ? `${joined} ${normalize(item.text)}` : normalize(item.text);
			if (joined === target) return true;
			if (!target.startsWith(joined)) break;
		}
	}
	return false;
}

/** Identidade de um cartão entre ao vivo e gravado (igual ao `cardDedupeKey` do web): o merge nunca mostra os dois. */
export function cardKey(item: ChatItem): string | null {
	switch (item.kind) {
		case "confirm":
			return `confirm|${item.confirmId}`;
		case "questionnaire":
			return `questionnaire|${item.questionnaireId}`;
		case "task-list":
			return `task-list|${item.runId}`;
		case "bot-proposal":
		case "bot-profile":
			return proposalKey(item);
		case "web-card":
			return item.key;
		default:
			return null;
	}
}

/**
 * A tela = o gravado (fonte de verdade) + o que só existe ao vivo e o servidor ainda não gravou, no fim.
 * - balão do usuário otimista (`msg-*`): some quando há linha gravada com o mesmo texto depois dele;
 * - fala em andamento (`cu-*`): some quando as linhas gravadas já a cobrem;
 * - cartão ao vivo com a identidade de um gravado: vale o gravado; só a lista de tarefas ao vivo do mesmo run
 *   substitui os passos do gravado (é a mais nova), no lugar dele.
 */
export function reconcile(persistedRaw: readonly ChatItem[], liveRaw: readonly ChatItem[]): ChatItem[] {
	// Proposta decidida em qualquer cópia (gravada ou ao vivo) vale nas duas: o decidido vence (como o web).
	const decided = applyDecidedProposals([...persistedRaw, ...liveRaw]);
	const persisted = decided.slice(0, persistedRaw.length);
	const live = decided.slice(persistedRaw.length);
	const persistedKeys = new Map<string, number>();
	persisted.forEach((item, index) => {
		const key = cardKey(item);
		if (key) persistedKeys.set(key, index);
	});
	const result = persisted.map((item) => {
		if (item.kind !== "task-list") return item;
		const liveList = live.find((candidate) => candidate.kind === "task-list" && candidate.runId === item.runId);
		return liveList && liveList.kind === "task-list" ? { ...item, items: liveList.items } : item;
	});
	const consumed = new Set<string>();
	const knownLive = new Set(persisted.map((item) => item.id));
	for (const item of live) {
		if (knownLive.has(item.id)) continue;
		if (item.kind === "user") {
			// A otimista casa com a linha gravada de mesmo texto enviada depois dela (uma por vez).
			const key = normalize(item.text);
			const match = persisted.find((row) => row.kind === "user" && !consumed.has(row.id) && normalize(row.text) === key && !isOlderThan(row, item));
			if (match) {
				consumed.add(match.id);
				// O servidor ainda não devolveu a citação (ou é uma versão antiga): a pílula não some no meio da troca.
				if (item.replyTo && match.kind === "user" && !match.replyTo) result[persisted.indexOf(match)] = { ...match, replyTo: item.replyTo };
				continue;
			}
		} else if (item.kind === "assistant") {
			if (!item.text.trim()) continue;
			if (normalize(item.text).length >= MIN_COVERED_LENGTH && persistedAssistantCovers(persisted, item.text)) continue;
		} else {
			const key = cardKey(item);
			const at = key ? persistedKeys.get(key) : undefined;
			if (at !== undefined) {
				// Painel atualizado ao vivo (revisão maior) antes de o servidor gravar a nova: vale a revisão mais nova, na posição do gravado.
				result[at] = mergePageCard(result[at]!, item);
				continue;
			}
		}
		result.push(item);
	}
	return dedupeKeys(result);
}

function isOlderThan(row: ChatItem, optimistic: ChatItem): boolean {
	// A otimista nasce agora (`msg-<epoch>-…`); uma linha gravada anterior ao envio não é a dela.
	const sent = Number(optimistic.id.split("-")[1]);
	const at = row.createdAt ? Date.parse(row.createdAt) : Number.NaN;
	return Number.isFinite(sent) && Number.isFinite(at) && at < sent - 60_000;
}

type WebCardItem = Extract<ChatItem, { kind: "web-card" }>;

/** Painel com revisão: o cartão de revisão mais nova segura o conteúdo (título, revisão, fontes), na posição e com o id do outro. */
export function mergePageCard(keeper: ChatItem, other: ChatItem): ChatItem {
	if (keeper.kind !== "web-card" || other.kind !== "web-card" || keeper.card !== "page" || other.card !== "page") return keeper;
	if ((other.revision ?? 0) <= (keeper.revision ?? 0)) return keeper;
	const merged: WebCardItem = { ...other, id: keeper.id, ...(keeper.createdAt ? { createdAt: keeper.createdAt } : {}) };
	return merged;
}

/** Cartões iguais (mesma identidade) aparecem uma vez, o primeiro (painel: na posição do primeiro, com a revisão mais nova); ids repetidos também. */
export function dedupeKeys(items: readonly ChatItem[]): ChatItem[] {
	const ids = new Set<string>();
	const keys = new Map<string, number>();
	const out: ChatItem[] = [];
	for (const item of items) {
		if (ids.has(item.id)) continue;
		ids.add(item.id);
		const key = cardKey(item);
		if (key) {
			const at = keys.get(key);
			if (at !== undefined) {
				out[at] = mergePageCard(out[at]!, item);
				continue;
			}
			keys.set(key, out.length);
		}
		out.push(item);
	}
	return out;
}

// ---- lista de tarefas ----------------------------------------------------------------------------------------

export function taskListProgress(items: readonly TaskItem[]) {
	const total = items.length;
	const done = items.filter((item) => item.status === "completed").length;
	const current = items.find((item) => item.status === "in_progress") ?? items.find((item) => item.status === "pending");
	return { total, done, allDone: total > 0 && done === total, current };
}

/** Linha da doca: "2/5 · Montar a planilha" (tudo concluído: "5/5 · Tudo pronto"). */
export function taskListDockLine(items: readonly TaskItem[]): string {
	const { total, done, allDone, current } = taskListProgress(items);
	return `${done}/${total} · ${allDone ? "Tudo pronto" : (current?.content ?? "")}`.replace(/ · $/, "");
}

/** Linha que fica no fio depois do run: "Tarefas · 5/5 concluídas" (parou no meio: "Tarefas · 3/5"). */
export function taskListSettledLabel(items: readonly TaskItem[]): string {
	const { total, done, allDone } = taskListProgress(items);
	return allDone ? `Tarefas · ${done}/${total} concluídas` : `Tarefas · ${done}/${total}`;
}

type TaskListItem = Extract<ChatItem, { kind: "task-list" }>;

/**
 * Lista de tarefas do run em andamento: a última `task-list` depois da última mensagem da pessoa, só enquanto o
 * run está ativo e, quando se sabe o run, só a dele (amarrada ao run ativo: lista de um run antigo nunca fica
 * presa na doca). Ela vive na doca do composer e não aparece no fio; sem run ativo, volta ao fio como resumo.
 */
export function dockedTaskList(items: readonly ChatItem[], runActive: boolean, activeRunId?: string | null): TaskListItem | null {
	if (!runActive) return null;
	let lastUser = -1;
	for (let index = items.length - 1; index >= 0; index -= 1) {
		if (items[index]!.kind === "user") {
			lastUser = index;
			break;
		}
	}
	for (let index = items.length - 1; index > lastUser; index -= 1) {
		const item = items[index]!;
		if (item.kind !== "task-list" || item.items.length === 0) continue;
		if (activeRunId && item.runId !== "local" && item.runId !== activeRunId) continue;
		return item;
	}
	return null;
}

/**
 * O cartão de tarefas mostra a tarefa em execução só durante um run, e só o do run ativo. Um cartão de outro run (ou o
 * "local" de uma execução antiga) fica como resumo, mesmo com outro run correndo.
 */
export function taskCardActive(cardRunId: string, activeRunId: string | null, running: boolean): boolean {
	return running && activeRunId !== null && cardRunId === activeRunId;
}
