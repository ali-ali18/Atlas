import { randomUUID } from "node:crypto";
import { emitUserNeeded } from "./user-needed.js";
import {
	BOT_LINK_ROLE,
	BOT_REPLY_SLA_MS,
	OPEN_BOT_REQUESTS_MAX,
	OPEN_BOT_REQUESTS_WINDOW_MS,
	OPEN_BOT_REQUEST_STATUSES,
	botOverdueLabel,
	isBotRequestOverdue,
	parseBotLinkCard,
	type OpenBotRequest,
	BOT_MESSAGE_MAX_CHARS,
	BOT_MESSAGE_MAX_DEPTH,
	clampBotMessageTitle,
	formatPendingItemsForModel,
	frameBotMessage,
	needFromCardRow,
	parseBotNeedsUserCard,
	pickEffectiveModel,
	planBotSend,
	resolveTargetBot,
	serializeBotLinkCard,
	type BotChainContext,
	type BotNeed,
	type BotExchangeItem,
	type BotExchangeResponse,
	type BotRosterEntry,
} from "@workspace/shared";
import { prisma } from "./client.js";
import { getBotModelForUser } from "./bots.js";
import { getAccountConfig } from "./settings.js";
import { createAgentRun, listActiveRunsForConversation } from "./runs.js";
import { botDecidesForOthers, hasAutoDecision, isChainAttended, isDecidableNeed, listPendingNeeds } from "./bot-pending.js";

/**
 * Conversa entre bots (`send_to_bot`). A mensagem é um outbox (`bot_messages`):
 *  1. `sendBotMessage` (tool) grava `pending`;
 *  2. `processBotMessages` (worker, em intervalo e quando algo muda) entrega ao
 *     destino (cria o run `origin: "bot"`; ocupado = adia e tenta de novo);
 *  3. quando o run do destino termina, a resposta vira `replied`;
 *  4. a resposta é gravada na conversa do remetente e o acorda com um run novo.
 * Encaminhar: se o destino chamou `send_to_bot` no run, a mensagem original fica
 * `waiting` e só responde ao remetente quando a resposta do encaminhamento chegar.
 */

/** Erro com mensagem limpa para o modelo (vira erro de tool). */
export class BotMessageError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "BotMessageError";
	}
}

/** Teto de envios de UM run (evita laço dentro do mesmo turno). */
export const BOT_RUN_MAX_SENDS = 5;
/** `delivering`/`replying` parados há mais que isso voltam para a fila. */
export const BOT_MESSAGE_STALE_MS = 2 * 60_000;
const SWEEP_BATCH = 20;
/** Status que ainda esperam algo (não fecham o pai em `waiting`). */
const OPEN_STATUSES = ["pending", "delivering", "delivered", "waiting", "replied", "replying", "reply_delivered"];

type Listener = () => void;
const createdListeners = new Set<Listener>();

/** O worker assina para entregar na hora em vez de esperar o próximo intervalo. */
export function onBotMessageCreated(listener: Listener): () => void {
	createdListeners.add(listener);
	return () => createdListeners.delete(listener);
}

export async function listUserBotRoster(userId: string): Promise<BotRosterEntry[]> {
	if (!userId.trim() || userId === "default") return [];
	const rows = await prisma.bot.findMany({
		// Grupos (bots com membros) não conversam: só bots de verdade.
		where: { ownerId: userId, memberIds: { isEmpty: true } },
		orderBy: { createdAt: "asc" },
		select: { id: true, name: true, description: true, snippet: true, isPrimary: true },
	});
	return rows;
}

/** Contexto da cadeia do run (profundidade, raiz e a mensagem que ele atende). */
export async function getBotChainContext(runId: string, userId: string): Promise<BotChainContext | null> {
	const message = await prisma.botMessage.findFirst({
		where: { userId, OR: [{ toRunId: runId }, { wakeRunId: runId }] },
		orderBy: { createdAt: "desc" },
	});
	if (!message) return null;
	if (message.toRunId === runId) {
		return { rootId: message.rootId, depth: message.depth, servingId: message.id };
	}
	// Run que acordou o remetente: se ele atendia outra mensagem (encaminhamento), continua atendendo-a.
	const parent = message.parentId
		? await prisma.botMessage.findFirst({ where: { id: message.parentId, userId }, select: { id: true, status: true } })
		: null;
	return {
		rootId: message.rootId,
		depth: message.depth,
		servingId: parent && parent.status === "waiting" ? parent.id : null,
	};
}

export type SendBotMessageResult = { id: string; targetId: string; targetName: string };

/** Valida e grava a mensagem (`pending`). Lança `BotMessageError` com texto limpo. */
export async function sendBotMessage(input: {
	userId: string;
	fromBotId: string | null | undefined;
	fromRunId?: string | null;
	bot: string;
	message: string;
	title?: string;
}): Promise<SendBotMessageResult> {
	const userId = input.userId.trim();
	if (!userId || userId === "default" || !input.fromBotId) {
		throw new BotMessageError("send_to_bot só funciona dentro da conversa de um bot.");
	}
	const message = input.message.trim();
	if (!message) throw new BotMessageError("A mensagem não pode ser vazia.");
	if (message.length > BOT_MESSAGE_MAX_CHARS) {
		throw new BotMessageError(`Mensagem longa demais (máx. ${BOT_MESSAGE_MAX_CHARS} caracteres). Resuma ou use um arquivo.`);
	}
	const roster = await listUserBotRoster(userId);
	if (!roster.some((bot) => bot.id === input.fromBotId)) {
		throw new BotMessageError("Bot remetente não encontrado.");
	}
	const resolved = resolveTargetBot(input.bot ?? "", roster, input.fromBotId);
	if (!resolved.ok) throw new BotMessageError(resolved.error);

	const context = input.fromRunId ? await getBotChainContext(input.fromRunId, userId) : null;
	const chainCount = context ? await prisma.botMessage.count({ where: { userId, rootId: context.rootId } }) : 0;
	const plan = planBotSend({ context, chainCount });
	if (!plan.ok) throw new BotMessageError(plan.error);
	if (input.fromRunId) {
		const sentByRun = await prisma.botMessage.count({ where: { userId, fromRunId: input.fromRunId } });
		if (sentByRun >= BOT_RUN_MAX_SENDS) {
			throw new BotMessageError(`Limite de ${BOT_RUN_MAX_SENDS} mensagens para outros bots por turno. Encerre o turno e aguarde as respostas.`);
		}
	}

	const [from, to] = await Promise.all([
		prisma.bot.findFirst({ where: { id: input.fromBotId, ownerId: userId }, select: { conversationId: true } }),
		prisma.bot.findFirst({ where: { id: resolved.bot.id, ownerId: userId }, select: { conversationId: true } }),
	]);
	const title = clampBotMessageTitle(input.title ?? "", message);
	const id = randomUUID();
	await prisma.botMessage.create({
		data: {
			id,
			userId,
			fromBotId: input.fromBotId,
			toBotId: resolved.bot.id,
			fromConversationId: from?.conversationId ?? null,
			toConversationId: to?.conversationId ?? null,
			fromRunId: input.fromRunId ?? null,
			rootId: plan.rootId ?? id,
			parentId: plan.parentId,
			depth: plan.depth,
			title,
			content: message,
		},
	});
	// Marcador "Enviou mensagem para X" na conversa do remetente (não vai ao modelo: role próprio).
	if (from?.conversationId) {
		await prisma.conversationMessage
			.create({
				data: {
					conversationId: from.conversationId,
					role: BOT_LINK_ROLE,
					content: serializeBotLinkCard({ v: 1, kind: "sent", botMessageId: id, botId: resolved.bot.id, botName: resolved.bot.name, title }),
				},
			})
			.catch((error) => console.error("[bot-messages] sent marker failed", error));
	}
	for (const listener of createdListeners) {
		try {
			listener();
		} catch {
			// ouvinte nunca derruba a tool
		}
	}
	return { id, targetId: resolved.bot.id, targetName: resolved.bot.name };
}

/** Marca/desmarca o bot principal do dono (no máximo um). `false` se o bot não é do usuário. */
export async function setPrimaryBot(userId: string, botId: string, primary: boolean): Promise<boolean> {
	if (!userId.trim() || userId === "default") return false;
	return prisma.$transaction(async (tx) => {
		const bot = await tx.bot.findFirst({ where: { id: botId, ownerId: userId }, select: { id: true } });
		if (!bot) return false;
		if (primary) {
			await tx.bot.updateMany({ where: { ownerId: userId, isPrimary: true, id: { not: botId } }, data: { isPrimary: false } });
		}
		await tx.bot.update({ where: { id: botId }, data: { isPrimary: primary } });
		return true;
	});
}

export const BOT_EXCHANGE_DEFAULT_LIMIT = 50;
export const BOT_EXCHANGE_MAX_LIMIT = 100;

/**
 * Mensagens trocadas entre dois bots do usuário (nos dois sentidos), em ordem
 * cronológica. Pagina "para trás": devolve as `limit` mais recentes (ou as
 * anteriores a `cursor`, um ISO de `createdAt`). `null` = algum dos bots não é
 * do usuário (ou os dois são o mesmo).
 */
export async function listBotExchange(input: {
	userId: string;
	botId: string;
	peerBotId: string;
	limit?: number;
	cursor?: string | null;
}): Promise<BotExchangeResponse | null> {
	const userId = input.userId.trim();
	if (!userId || userId === "default" || !input.botId || !input.peerBotId || input.botId === input.peerBotId) return null;
	const owned = await prisma.bot.findMany({
		where: { ownerId: userId, id: { in: [input.botId, input.peerBotId] } },
		select: { id: true },
	});
	if (owned.length !== 2) return null;
	const limit = Math.min(Math.max(Math.trunc(input.limit ?? BOT_EXCHANGE_DEFAULT_LIMIT) || BOT_EXCHANGE_DEFAULT_LIMIT, 1), BOT_EXCHANGE_MAX_LIMIT);
	const before = input.cursor ? new Date(input.cursor) : null;
	const rows = await prisma.botMessage.findMany({
		where: {
			userId,
			OR: [
				{ fromBotId: input.botId, toBotId: input.peerBotId },
				{ fromBotId: input.peerBotId, toBotId: input.botId },
			],
			...(before && !Number.isNaN(before.getTime()) ? { createdAt: { lt: before } } : {}),
		},
		orderBy: { createdAt: "desc" },
		take: limit + 1,
	});
	const page = rows.slice(0, limit);
	const messages: BotExchangeItem[] = page.reverse().map((row) => ({
		id: row.id,
		rootId: row.rootId,
		fromBotId: row.fromBotId,
		toBotId: row.toBotId,
		title: row.title,
		content: row.content,
		replyContent: row.replyContent,
		status: row.status,
		createdAt: row.createdAt.toISOString(),
		repliedAt: row.repliedAt ? row.repliedAt.toISOString() : null,
	}));
	return { messages, nextCursor: rows.length > limit ? (messages[0]?.createdAt ?? null) : null };
}

export type BotMessageDeps = {
	/** Enfileira o job do run (worker); `false` = a reconciliação de runs `queued` repete. */
	enqueueRun: (runId: string) => Promise<boolean>;
	/** Modelo padrão quando nem o bot nem a conta definem. */
	envDefaultModel: string;
	now?: () => Date;
	/** Injetáveis em teste; padrão: db. */
	createRun?: typeof createAgentRun;
	activeRuns?: typeof listActiveRunsForConversation;
	resolveModel?: (botId: string, userId: string, envDefault: string) => Promise<string>;
};

export async function resolveBotModel(botId: string, userId: string, envDefault: string): Promise<string> {
	const botModel = await getBotModelForUser(botId, userId);
	const accountDefault = botModel ? undefined : (await getAccountConfig(userId).catch(() => null))?.models?.default;
	return pickEffectiveModel({ botModel, envDefault: accountDefault ?? envDefault });
}

export async function ensureBotConversation(botId: string, userId: string, current: string | null): Promise<string> {
	if (current) return current;
	const conversation = await prisma.conversation.create({ data: { userId } });
	await prisma.bot.updateMany({ where: { id: botId, ownerId: userId, conversationId: null }, data: { conversationId: conversation.id } });
	const bot = await prisma.bot.findFirst({ where: { id: botId, ownerId: userId }, select: { conversationId: true } });
	return bot?.conversationId ?? conversation.id;
}

/**
 * Cria o run (`origin: "bot"`) numa conversa de bot e grava a mensagem de origem
 * "bot" nela. `null` = conversa ocupada (outro run ativo): quem chama adia.
 */
async function startBotRun(input: {
	userId: string;
	botId: string;
	conversationId: string;
	text: string;
	from: { id: string; name: string };
	botMessageId: string;
	deps: BotMessageDeps;
}): Promise<{ runId: string } | null> {
	if ((await (input.deps.activeRuns ?? listActiveRunsForConversation)(input.conversationId)).length > 0) return null;
	const model = await (input.deps.resolveModel ?? resolveBotModel)(input.botId, input.userId, input.deps.envDefaultModel);
	const run = await (input.deps.createRun ?? createAgentRun)({
		userId: input.userId,
		model,
		request: {
			botId: input.botId,
			conversationId: input.conversationId,
			origin: "bot",
			objective: input.text,
			messages: [{ role: "user", content: input.text }],
			// A mensagem é gravada abaixo, com remetente; sem espelho duplicado.
			silent: true,
		},
	});
	// Corrida: um run ativo entrou na conversa entre a checagem e o create.
	if (run.origin !== "bot") return null;
	await prisma.conversationMessage.create({
		data: {
			conversationId: input.conversationId,
			role: "user",
			content: input.text,
			origin: "bot",
			fromBotId: input.from.id,
			fromBotName: input.from.name,
			botMessageId: input.botMessageId,
		},
	});
	await input.deps.enqueueRun(run.id).catch((error) => {
		console.error(`[bot-messages] enqueue failed run=${run.id}`, error);
		return false;
	});
	return { runId: run.id };
}

/** Entrega uma mensagem `pending` ao destino. */
async function deliverPending(id: string, deps: BotMessageDeps): Promise<"delivered" | "busy" | "failed" | "skipped"> {
	const claimed = await prisma.botMessage.updateMany({ where: { id, status: "pending" }, data: { status: "delivering" } });
	if (claimed.count !== 1) return "skipped";
	const message = await prisma.botMessage.findUniqueOrThrow({ where: { id } });
	const revert = () => prisma.botMessage.updateMany({ where: { id, status: "delivering" }, data: { status: "pending" } });
	try {
		const [from, to] = await Promise.all([
			prisma.bot.findFirst({ where: { id: message.fromBotId, ownerId: message.userId }, select: { id: true, name: true } }),
			prisma.bot.findFirst({ where: { id: message.toBotId, ownerId: message.userId }, select: { id: true, name: true, conversationId: true } }),
		]);
		if (!from || !to) {
			// Destino sumiu: a resposta de erro volta ao remetente (se ele ainda existir).
			await prisma.botMessage.update({
				where: { id },
				data: {
					status: from ? "replied" : "failed",
					replyContent: "Não foi possível entregar: o bot de destino não existe mais.",
					error: "target_missing",
					repliedAt: new Date(),
				},
			});
			return "failed";
		}
		const conversationId = await ensureBotConversation(to.id, message.userId, to.conversationId);
		const started = await startBotRun({
			userId: message.userId,
			botId: to.id,
			conversationId,
			text: frameBotMessage("request", from.name, message.content),
			from,
			botMessageId: id,
			deps,
		});
		if (!started) {
			await revert();
			return "busy";
		}
		await prisma.botMessage.update({
			where: { id },
			data: { status: "delivered", toRunId: started.runId, toConversationId: conversationId, deliveredAt: new Date() },
		});
		return "delivered";
	} catch (error) {
		console.error(`[bot-messages] deliver failed id=${id}`, error);
		await revert().catch(() => undefined);
		return "failed";
	}
}

/** Run do destino parado esperando o usuário (login/captcha pausam o run; o resto termina o turno). */
const PARKED_RUN_STATUSES = ["paused", "waiting_user", "waiting_external"];
const NEED_LOGIN_TYPES: readonly string[] = ["login", "captcha", "connector"];
const NEEDS_DEDUPE_SCAN = 60;

/**
 * Conversas que enxergam o pedido: a do remetente e a da raiz da cadeia (onde o
 * humano começou). Sobe por quem enviou o pai (o run remetente atendia outro pedido).
 */
async function chainConversationIds(message: {
	userId: string;
	fromConversationId: string | null;
	fromRunId: string | null;
}): Promise<string[]> {
	const found: string[] = [];
	if (message.fromConversationId) found.push(message.fromConversationId);
	let currentRunId = message.fromRunId;
	for (let hop = 0; hop < BOT_MESSAGE_MAX_DEPTH && currentRunId; hop += 1) {
		const parent = await prisma.botMessage.findFirst({
			where: { userId: message.userId, toRunId: currentRunId },
			select: { fromConversationId: true, fromRunId: true },
		});
		if (!parent) break;
		if (parent.fromConversationId) found.push(parent.fromConversationId);
		currentRunId = parent.fromRunId;
	}
	const unique = [...new Set(found)];
	return unique.length > 2 ? [unique[0]!, unique[unique.length - 1]!] : unique;
}

/** Grava (uma vez por card) o marcador "X precisa de você" na conversa. */
export async function postNeedsUserMarker(input: {
	conversationId: string;
	message: { id: string; toBotId: string; title: string };
	botName: string;
	need: BotNeed;
}): Promise<boolean> {
	const recent = await prisma.conversationMessage.findMany({
		where: { conversationId: input.conversationId, role: BOT_LINK_ROLE },
		orderBy: { createdAt: "desc" },
		take: NEEDS_DEDUPE_SCAN,
	});
	const duplicate = recent.some((row: { content: string }) => {
		const card = parseBotNeedsUserCard(row.content);
		return card !== null && card.botMessageId === input.message.id && card.need.cardId === input.need.cardId;
	});
	if (duplicate) return false;
	await prisma.conversationMessage.create({
		data: {
			conversationId: input.conversationId,
			role: BOT_LINK_ROLE,
			content: serializeBotLinkCard({
				v: 1,
				kind: "needs-user",
				botMessageId: input.message.id,
				botId: input.message.toBotId,
				botName: input.botName,
				title: input.message.title,
				need: input.need,
				status: "pending",
			}),
		},
	});
	emitUserNeeded({
		conversationId: input.conversationId,
		cardId: input.need.cardId,
		detail: input.need.item?.title ? `${input.botName}: ${input.need.item.title}` : input.message.title,
	});
	return true;
}

/**
 * Pedido entregue cujo bot de destino parou esperando o usuário (card de login,
 * captcha, aprovação...): relaya um marcador acionável ao remetente e à raiz da
 * cadeia. Roda ANTES de `settleDelivered` (o run pode terminar o turno com o card).
 */
async function relayNeedsUser(): Promise<number> {
	const rows = await prisma.botMessage.findMany({
		where: { status: "delivered", toRunId: { not: null }, toConversationId: { not: null } },
		orderBy: { createdAt: "asc" },
		take: SWEEP_BATCH,
	});
	let posted = 0;
	for (const message of rows) posted += await relayMessageNeeds(message, { settled: false });
	return posted;
}

/**
 * Marcadores de um pedido: um por card pendente do destino. Com "Decidir pelos
 * outros bots" ligado no remetente (cadeia com humano), os itens que ele pode decidir
 * (comando, escrita, MCP, questionário) esperam a decisão dele; só chegam ao usuário
 * quando ele escala, não decide (`settled`: o run dele já terminou) ou a corrida falha.
 */
async function relayMessageNeeds(
	message: Awaited<ReturnType<typeof prisma.botMessage.findMany>>[number],
	opts: { settled: boolean },
): Promise<number> {
	if (!message.toConversationId || !message.toRunId) return 0;
	const needs = await listPendingNeeds({ ...message, toConversationId: message.toConversationId });
	if (needs.length === 0) return 0;
	const run = await prisma.agentRun.findUnique({ where: { id: message.toRunId }, select: { status: true } });
	const targets = await chainConversationIds(message);
	if (targets.length === 0) return 0;
	const bot = await prisma.bot.findFirst({ where: { id: message.toBotId, ownerId: message.userId }, select: { name: true } });
	const deciderOn = needs.some(isDecidableNeed) && (await botDecidesForOthers(message.fromBotId, message.userId)) && (await isChainAttended(message));
	let posted = 0;
	for (const need of needs) {
		// Login: só depois que o run realmente parou (o card nasce um instante antes da pausa).
		if (NEED_LOGIN_TYPES.includes(need.type) && !(run && PARKED_RUN_STATUSES.includes(run.status))) continue;
		if (deciderOn && isDecidableNeed(need)) {
			if (!opts.settled) continue;
			if (message.fromConversationId && (await hasAutoDecision(message.fromConversationId, need.cardId))) continue;
		}
		for (const conversationId of targets) {
			if (await postNeedsUserMarker({ conversationId, message, botName: bot?.name ?? "Bot", need })) posted += 1;
		}
	}
	return posted;
}

/** O orquestrador não quis/pôde decidir: o card chega ao usuário (nas conversas da cadeia). */
export async function escalatePendingNeed(input: { message: { id: string; userId: string; toBotId: string; title: string; fromConversationId: string | null; fromRunId: string | null }; need: Parameters<typeof postNeedsUserMarker>[0]["need"]; botName: string }): Promise<number> {
	const targets = await chainConversationIds(input.message);
	let posted = 0;
	for (const conversationId of targets) {
		if (await postNeedsUserMarker({ conversationId, message: input.message, botName: input.botName, need: input.need })) posted += 1;
	}
	return posted;
}

/**
 * Marcadores "precisa de você" ainda pendentes, mais antigos primeiro. O varredor roda a cada poucos
 * segundos: os predicados são literais e IGUAIS aos do índice parcial
 * `conversation_messages_needs_user_pending_idx` (migration 20261201000000), assim o Postgres lê só esse
 * índice minúsculo em vez de varrer `conversation_messages` inteira. Mudou o texto aqui? Mude o índice junto.
 */
export async function listPendingNeedsUserMarkers(limit: number): Promise<Array<{ id: string; content: string }>> {
	return prisma.$queryRaw<Array<{ id: string; content: string }>>`
		SELECT "id", "content" FROM "conversation_messages"
		WHERE "role" = 'bot-link'
		  AND "content" LIKE '%"kind":"needs-user"%'
		  AND "content" LIKE '%"status":"pending"%'
		ORDER BY "createdAt" ASC
		LIMIT ${limit}
	`;
}

/** O pedido relayado foi atendido (card resolvido, run retomado/encerrado ou card sumiu): marca como resolvido. */
async function resolveNeedsUser(seen: { markers: number }): Promise<number> {
	const rows = await listPendingNeedsUserMarkers(SWEEP_BATCH * 2);
	seen.markers = rows.length;
	let resolved = 0;
	for (const row of rows) {
		const card = parseBotNeedsUserCard(row.content);
		if (!card || card.status !== "pending") continue;
		const cardRow = await prisma.conversationMessage.findUnique({ where: { id: card.need.cardId } });
		let pending =
			cardRow !== null &&
			needFromCardRow({
				rowId: cardRow.id,
				conversationId: cardRow.conversationId,
				role: cardRow.role,
				content: cardRow.content,
				targetRunId: card.need.runId,
			}) !== null;
		if (pending && card.need.runId && NEED_LOGIN_TYPES.includes(card.need.type)) {
			const run = await prisma.agentRun.findUnique({ where: { id: card.need.runId }, select: { status: true } });
			if (!run || !PARKED_RUN_STATUSES.includes(run.status)) pending = false;
		}
		if (pending) continue;
		await prisma.conversationMessage.update({
			where: { id: row.id },
			data: { content: serializeBotLinkCard({ ...card, status: "resolved" }) },
		});
		resolved += 1;
	}
	return resolved;
}

export function isTerminal(status: string): boolean {
	return !["queued", "running", "waiting_user", "waiting_external", "paused", "retrying"].includes(status);
}

function replyTextFor(run: { status: string; resultText: string | null; error: string | null }): string {
	if (run.status === "completed") return run.resultText?.trim() || "(O bot terminou sem uma resposta em texto.)";
	const partial = run.resultText?.trim();
	return partial || `Não consegui concluir o pedido (${run.error?.trim() || run.status}).`;
}

/** Bloco `[pending_items]` com os cards do destino que ainda esperam o usuário ("" = nenhum). */
async function pendingItemsBlock(message: Awaited<ReturnType<typeof prisma.botMessage.findMany>>[number]): Promise<string> {
	if (!message.toConversationId) return "";
	try {
		const needs = await listPendingNeeds({ ...message, toConversationId: message.toConversationId });
		const items = needs.flatMap((need) => (need.item ? [need.item] : []));
		if (items.length === 0) return "";
		return `

[O bot de destino parou esperando o usuário. Itens pendentes abaixo; veja as regras de decide_bot_pending.]
${formatPendingItemsForModel(items)}`;
	} catch (error) {
		console.error("[bot-messages] pending items failed", error);
		return "";
	}
}

/** Run do destino terminou: vira resposta, ou espera o encaminhamento. */
async function settleDelivered(): Promise<number> {
	const rows = await prisma.botMessage.findMany({
		where: { status: "delivered", toRunId: { not: null } },
		orderBy: { createdAt: "asc" },
		take: SWEEP_BATCH,
	});
	let settled = 0;
	for (const message of rows) {
		const run = await prisma.agentRun.findUnique({
			where: { id: message.toRunId! },
			select: { status: true, resultText: true, error: true },
		});
		if (!run) {
			await prisma.botMessage.updateMany({
				where: { id: message.id, status: "delivered" },
				data: { status: "replied", replyContent: "Não consegui concluir o pedido (execução não encontrada).", repliedAt: new Date() },
			});
			settled += 1;
			continue;
		}
		if (!isTerminal(run.status)) continue;
		const forwarded = run.status === "completed" && (await prisma.botMessage.count({ where: { parentId: message.id } })) > 0;
		// O orquestrador também lê o que o destino deixou esperando o usuário (item estruturado).
		const pendingBlock = forwarded ? "" : await pendingItemsBlock(message);
		const result = await prisma.botMessage.updateMany({
			where: { id: message.id, status: "delivered" },
			data: forwarded ? { status: "waiting" } : { status: "replied", replyContent: `${replyTextFor(run)}${pendingBlock}`, repliedAt: new Date() },
		});
		settled += result.count;
	}
	return settled;
}

/**
 * Run que acordou o remetente terminou. Se ele atendia outra mensagem
 * (encaminhamento) e nada mais está em aberto, a resposta dele responde a ela.
 */
async function closeWoken(): Promise<number> {
	const rows = await prisma.botMessage.findMany({
		where: { status: "reply_delivered", wakeRunId: { not: null } },
		orderBy: { createdAt: "asc" },
		take: SWEEP_BATCH,
	});
	let closed = 0;
	for (const message of rows) {
		const run = await prisma.agentRun.findUnique({
			where: { id: message.wakeRunId! },
			select: { status: true, resultText: true, error: true },
		});
		if (run && !isTerminal(run.status)) continue;
		const claimed = await prisma.botMessage.updateMany({ where: { id: message.id, status: "reply_delivered" }, data: { status: "closed" } });
		if (claimed.count !== 1) continue;
		closed += 1;
		// O orquestrador acordou e terminou: o que ele não decidiu nem escalou vai ao usuário.
		await relayMessageNeeds(message, { settled: true }).catch((error) => console.error("[bot-messages] settle relay failed", error));
		if (!message.parentId) continue;
		const parent = await prisma.botMessage.findFirst({ where: { id: message.parentId, status: "waiting" } });
		if (!parent) continue;
		const open = await prisma.botMessage.count({ where: { parentId: parent.id, status: { in: OPEN_STATUSES } } });
		if (open > 0) continue;
		await prisma.botMessage.updateMany({
			where: { id: parent.id, status: "waiting" },
			data: {
				status: "replied",
				replyContent: run ? replyTextFor(run) : "Não consegui concluir o pedido.",
				repliedAt: new Date(),
			},
		});
	}
	return closed;
}

/** Grava a resposta na conversa do remetente e o acorda. */
async function deliverReply(id: string, deps: BotMessageDeps): Promise<"delivered" | "busy" | "failed" | "skipped"> {
	const claimed = await prisma.botMessage.updateMany({ where: { id, status: "replied" }, data: { status: "replying" } });
	if (claimed.count !== 1) return "skipped";
	const message = await prisma.botMessage.findUniqueOrThrow({ where: { id } });
	const revert = () => prisma.botMessage.updateMany({ where: { id, status: "replying" }, data: { status: "replied" } });
	try {
		const [sender, target] = await Promise.all([
			prisma.bot.findFirst({ where: { id: message.fromBotId, ownerId: message.userId }, select: { id: true, conversationId: true } }),
			prisma.bot.findFirst({ where: { id: message.toBotId, ownerId: message.userId }, select: { id: true, name: true } }),
		]);
		if (!sender) {
			await prisma.botMessage.update({ where: { id }, data: { status: "failed", error: "sender_missing" } });
			return "failed";
		}
		const conversationId = await ensureBotConversation(sender.id, message.userId, sender.conversationId);
		const started = await startBotRun({
			userId: message.userId,
			botId: sender.id,
			conversationId,
			text: frameBotMessage("reply", target?.name ?? "removido", message.replyContent ?? ""),
			from: { id: message.toBotId, name: target?.name ?? "removido" },
			botMessageId: id,
			deps,
		});
		if (!started) {
			await revert();
			return "busy";
		}
		await prisma.botMessage.update({ where: { id }, data: { status: "reply_delivered", wakeRunId: started.runId } });
		await clearOverdue(message).catch((error) => console.error("[bot-messages] clear overdue failed", error));
		return "delivered";
	} catch (error) {
		console.error(`[bot-messages] reply failed id=${id}`, error);
		await revert().catch(() => undefined);
		return "failed";
	}
}

/** Marcador "Enviou mensagem para X" do pedido, na conversa do remetente (do mesmo dono). */
async function findSentMarker(message: { id: string; userId: string; fromConversationId: string | null }) {
	if (!message.fromConversationId) return null;
	const row = await prisma.conversationMessage.findFirst({
		where: {
			conversationId: message.fromConversationId,
			conversation: { userId: message.userId },
			role: BOT_LINK_ROLE,
			content: { contains: `"botMessageId":${JSON.stringify(message.id)}` },
		},
		select: { id: true, content: true },
	});
	const card = row ? parseBotLinkCard(row.content) : null;
	return row && card ? { rowId: row.id, card } : null;
}

/**
 * Prazo de resposta (BOT_REPLY_SLA_MS): pedido ainda em aberto depois dele ganha, uma vez, o aviso
 * no marcador do remetente ("Bobinho ainda não respondeu"). O pedido continua aberto: a resposta
 * tardia ainda chega e limpa o aviso.
 */
async function flagOverdue(now: Date): Promise<number> {
	const rows = await prisma.botMessage.findMany({
		where: {
			status: { in: [...OPEN_BOT_REQUEST_STATUSES] },
			createdAt: { lt: new Date(now.getTime() - BOT_REPLY_SLA_MS), gt: new Date(now.getTime() - OPEN_BOT_REQUESTS_WINDOW_MS) },
			fromConversationId: { not: null },
		},
		orderBy: { createdAt: "desc" },
		take: SWEEP_BATCH,
		select: { id: true, userId: true, toBotId: true, status: true, createdAt: true, fromConversationId: true },
	});
	let flagged = 0;
	for (const message of rows) {
		if (!isBotRequestOverdue(message, now)) continue;
		const marker = await findSentMarker(message);
		if (!marker || marker.card.overdue) continue;
		const overdue = { label: botOverdueLabel(marker.card.botName, message.status), at: now.toISOString() };
		await prisma.conversationMessage.update({ where: { id: marker.rowId }, data: { content: serializeBotLinkCard({ ...marker.card, overdue }) } });
		flagged += 1;
	}
	return flagged;
}

/** A resposta chegou: o marcador perde o aviso de atraso (melhor esforço). */
async function clearOverdue(message: { id: string; userId: string; fromConversationId: string | null }): Promise<void> {
	const marker = await findSentMarker(message);
	if (!marker?.card.overdue) return;
	const { overdue: _overdue, ...card } = marker.card;
	await prisma.conversationMessage.update({ where: { id: marker.rowId }, data: { content: serializeBotLinkCard(card) } });
}

/** Pedidos deste bot a outros bots ainda sem resposta (do mesmo dono, últimas 24 h). */
export async function listOpenBotRequests(input: { userId: string; fromBotId: string; now?: Date }): Promise<OpenBotRequest[]> {
	const now = input.now ?? new Date();
	const rows = await prisma.botMessage.findMany({
		where: {
			userId: input.userId,
			fromBotId: input.fromBotId,
			status: { in: [...OPEN_BOT_REQUEST_STATUSES] },
			createdAt: { gt: new Date(now.getTime() - OPEN_BOT_REQUESTS_WINDOW_MS) },
		},
		orderBy: { createdAt: "desc" },
		take: OPEN_BOT_REQUESTS_MAX,
		select: { toBotId: true, title: true, status: true, createdAt: true },
	});
	if (rows.length === 0) return [];
	const bots = await prisma.bot.findMany({ where: { id: { in: rows.map((row) => row.toBotId) }, ownerId: input.userId }, select: { id: true, name: true } });
	const names = new Map(bots.map((bot) => [bot.id, bot.name]));
	return rows.map((row) => ({ botName: names.get(row.toBotId) ?? "bot removido", title: row.title, status: row.status, createdAt: row.createdAt }));
}

async function recoverStale(now: Date): Promise<void> {
	const before = new Date(now.getTime() - BOT_MESSAGE_STALE_MS);
	await prisma.botMessage.updateMany({ where: { status: "delivering", updatedAt: { lt: before } }, data: { status: "pending" } });
	await prisma.botMessage.updateMany({ where: { status: "replying", updatedAt: { lt: before } }, data: { status: "replied" } });
}

export type BotMessageSweepResult = {
	delivered: number;
	busy: number;
	replies: number;
	settled: number;
	needsUser: number;
	overdue: number;
	/** Ainda há pedido aberto ou marcador "precisa de você" pendente: o worker volta a varrer logo. */
	inFlight: boolean;
};

/** Um passo do outbox (idempotente; várias instâncias do worker podem rodar juntas). */
export async function processBotMessages(deps: BotMessageDeps): Promise<BotMessageSweepResult> {
	const now = (deps.now ?? (() => new Date()))();
	const result: BotMessageSweepResult = { delivered: 0, busy: 0, replies: 0, settled: 0, needsUser: 0, overdue: 0, inFlight: false };
	const seen = { markers: 0 };
	await recoverStale(now).catch((error) => console.error("[bot-messages] recover failed", error));
	// Antes de encerrar: o destino pode ter terminado o turno com um card esperando o usuário.
	result.needsUser += await relayNeedsUser().catch((error) => (console.error("[bot-messages] relay needs-user failed", error), 0));
	result.needsUser += await resolveNeedsUser(seen).catch((error) => (console.error("[bot-messages] resolve needs-user failed", error), 0));
	result.settled += await settleDelivered().catch((error) => (console.error("[bot-messages] settle failed", error), 0));
	result.settled += await closeWoken().catch((error) => (console.error("[bot-messages] close failed", error), 0));
	result.overdue += await flagOverdue(now).catch((error) => (console.error("[bot-messages] overdue failed", error), 0));

	const pending = await prisma.botMessage.findMany({ where: { status: "pending" }, orderBy: { createdAt: "asc" }, take: SWEEP_BATCH, select: { id: true } });
	for (const row of pending) {
		const outcome = await deliverPending(row.id, deps);
		if (outcome === "delivered") result.delivered += 1;
		if (outcome === "busy") result.busy += 1;
	}
	const replies = await prisma.botMessage.findMany({ where: { status: "replied" }, orderBy: { repliedAt: "asc" }, take: SWEEP_BATCH, select: { id: true } });
	for (const row of replies) {
		const outcome = await deliverReply(row.id, deps);
		if (outcome === "delivered") result.replies += 1;
		if (outcome === "busy") result.busy += 1;
	}
	// Erro na leitura conta como "em andamento": melhor varrer de novo logo do que dormir com trabalho aberto.
	const open = await prisma.botMessage
		.findFirst({ where: { status: { in: OPEN_STATUSES } }, select: { id: true } })
		.catch(() => ({ id: "unknown" }));
	result.inFlight = open !== null || seen.markers > 0;
	return result;
}
