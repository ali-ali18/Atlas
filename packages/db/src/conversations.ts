import type {
	ChatRole,
	ComputerUseEvent,
	ConversationRole,
	SessionMessage,
	SkillListItemData,
} from "@workspace/shared";
import {
	parseComposioToolkitSlug,
	parseLoginConnector,
	parseLoginVaultOffer,
	foldAutomatedMessages,
	isPersistedMessageOrigin,
	isMessageSourceKind,
	isLlmChatRole,
	LLM_CHAT_ROLES,
	parseConversationCard,
	parseDevApprovalInfo,
	parseSecretsRequestInfo,
	parseEmailKeyRequestInfo,
	parseGithubIdentityInfo,
	parsePlanInfo,
	parseSkillProposalCard,
	serializeConversationCard,
	SUPERSEDED_CARD_DETAIL,
	type PersistedBotProfileCard,
	type PersistedSkillProposalCard,
	type PersistedConversationCard,
	type PersistedQuestionnaireCard,
	type PersistedJevStatusCard,
	type PersistedSkillCard,
	type QuestionnaireCardItem,
} from "@workspace/shared";
import { prisma } from "./client.js";
import { currentMessageRunId } from "./message-run-context.js";
import { approvalDetail, emitUserNeeded } from "./user-needed.js";
import { loadReactionsByMessage } from "./message-reactions.js";

const CHAT_ROLES: readonly ChatRole[] = LLM_CHAT_ROLES;

/** Não revela qual recurso ou vínculo de posse falhou. */
export class ResourceOwnershipError extends Error {
	readonly code = "RESOURCE_NOT_FOUND";
	constructor() {
		super("Recurso não encontrado");
		this.name = "ResourceOwnershipError";
	}
}

function toSessionMessage(row: {
	id: string;
	conversationId: string;
	role: string;
	content: string;
	origin?: string | null;
	fromBotId?: string | null;
	fromBotName?: string | null;
	botMessageId?: string | null;
	sourceKind?: string | null;
	sourceLabel?: string | null;
	sourceAt?: Date | null;
	runId?: string | null;
	createdAt: Date;
}): SessionMessage {
	return {
		id: row.id,
		conversationId: row.conversationId,
		role: row.role as ConversationRole,
		content: row.content,
		...(row.origin ? { origin: row.origin } : {}),
		...(row.fromBotId ? { fromBotId: row.fromBotId } : {}),
		...(row.fromBotName ? { fromBotName: row.fromBotName } : {}),
		...(row.botMessageId ? { botMessageId: row.botMessageId } : {}),
		...(row.role === "assistant" && row.runId ? { runId: row.runId } : {}),
		...(isMessageSourceKind(row.sourceKind) && row.sourceLabel && row.sourceAt
			? { source: { kind: row.sourceKind, label: row.sourceLabel, at: row.sourceAt.toISOString() } }
			: {}),
		createdAt: row.createdAt.toISOString(),
	};
}

export async function createConversation(userId?: string): Promise<{ id: string }> {
	if (!userId?.trim() || userId === "default") throw new ResourceOwnershipError();
	const conversation = await prisma.conversation.create({
		data: { userId },
	});
	return { id: conversation.id };
}

/** Legado só fica disponível após o claim validado reatribuir seu dono. */
export async function getOwnedConversation(
	id: string,
	userId: string,
): Promise<{ id: string } | null> {
	if (!userId.trim() || userId === "default") return null;
	const row = await prisma.conversation.findFirst({
		where: { id, userId, OR: [{ bot: { is: null } }, { bot: { is: { ownerId: userId } } }] },
		select: { id: true },
	});
	return row ? { id: row.id } : null;
}

/** Confirmações de ação externa exigem dono explícito da conversa. */
export async function getStrictOwnedConversation(id: string, userId: string): Promise<{ id: string; botId: string | null } | null> {
	if (!userId.trim() || userId === "default") return null;
	const row = await prisma.conversation.findFirst({
		where: { id, userId, bot: { is: { ownerId: userId } } },
		select: { id: true, bot: { select: { id: true } } },
	});
	return row ? { id: row.id, botId: row.bot?.id ?? null } : null;
}

export async function listConversationMessages(
	conversationId: string,
	limit = 100,
	before?: { createdAt: string; id: string },
): Promise<SessionMessage[]> {
	// Janela móvel: as ÚLTIMAS `limit` (thread mostra o fim da conversa).
	// `take` com `asc` retornaria as mais ANTIGAS e o F5 "voltava no tempo".
	// Cursor opcional (createdAt + id) pagina para trás sem pular/duplicar.
	// A rota pede limit + 1 para detectar se existe outra página.
	const take = Math.max(1, Math.min(201, Math.floor(limit) || 100));
	const cursor =
		before && !Number.isNaN(Date.parse(before.createdAt)) && before.id
			? { createdAt: new Date(before.createdAt), id: before.id }
			: null;
	const rows = await prisma.conversationMessage.findMany({
		where: {
			conversationId,
			...(cursor
				? {
						OR: [
							{ createdAt: { lt: cursor.createdAt } },
							{ createdAt: cursor.createdAt, id: { lt: cursor.id } },
						],
					}
				: {}),
		},
		orderBy: [{ createdAt: "desc" }, { id: "desc" }],
		take,
	});

	const ordered = rows.reverse();
	await expireOrphanedConfirmRows(conversationId, ordered).catch(() => undefined);
	// Reações das falas (cartões não têm). Falha aqui não derruba a conversa: some só o emoji.
	const reactions = await loadReactionsByMessage(ordered.filter((row) => row.role === "user" || row.role === "assistant").map((row) => row.id)).catch(() => new Map());
	return ordered.map((row) => {
		const message = toSessionMessage(row);
		const own = reactions.get(row.id);
		return own?.length ? { ...message, reactions: own } : message;
	});
}

/** Folga para o cartão recém-gravado: a intenção pendente é salva por quem o emitiu, quase junto. */
const ORPHAN_CONFIRM_GRACE_MS = 60_000;

/**
 * Cartão de aprovação gravado como "pendente" cuja intenção no servidor já não existe (venceu, foi consumida
 * por outro caminho ou substituída por um pedido novo) não pode mais ser decidido: o clique não faz nada.
 * Deixá-lo pendente fazia o app, ao reabrir, voltar a pedir autorização sem o agente ter pedido. Marca como
 * expirado (grava e já devolve assim na lista). Muta `rows` no lugar.
 */
export async function expireOrphanedConfirmRows(
	conversationId: string,
	rows: Array<{ id: string; role: string; content: string; createdAt: Date }>,
	now: number = Date.now(),
): Promise<number> {
	const stale: Array<{ row: (typeof rows)[number]; card: Extract<NonNullable<ReturnType<typeof parseConversationCard>>, { kind: "confirm" }> }> = [];
	for (const row of rows) {
		if (row.role !== "confirm" || now - row.createdAt.getTime() < ORPHAN_CONFIRM_GRACE_MS) continue;
		const card = parseConversationCard(row.content);
		if (card?.kind === "confirm" && card.status === "pending") stale.push({ row, card });
	}
	if (stale.length === 0) return 0;
	const intentRow = await prisma.skillPendingIntent.findUnique({ where: { conversationId } }).catch(() => null);
	const live = intentRow && intentRow.expiresAt.getTime() > now && intentRow.kind === "confirm" ? ((intentRow.payload as { confirmId?: string } | null) ?? {}) : null;
	let changed = 0;
	for (const { row, card } of stale) {
		if (live && (!live.confirmId || live.confirmId === card.confirmId)) continue;
		const content = serializeConversationCard({ ...card, status: "rejected", outcome: { ok: false, detail: SUPERSEDED_CARD_DETAIL } });
		await prisma.conversationMessage.update({ where: { id: row.id }, data: { content } }).catch(() => undefined);
		row.content = content;
		changed += 1;
	}
	return changed;
}

export async function appendConversationMessage(
	conversationId: string,
	role: ChatRole,
	content: string,
	origin?: string | null,
	/** Mensagem entre bots: remetente e vínculo com a cadeia. */
	bot?: { fromBotId?: string | null; fromBotName?: string | null; botMessageId?: string | null },
): Promise<SessionMessage> {
	if (!CHAT_ROLES.includes(role)) {
		throw new Error(`Invalid message role: ${role}`);
	}

	const existing = await prisma.conversation.findUnique({
		where: { id: conversationId },
		select: { id: true },
	});
	if (!existing) {
		throw new Error("Conversation not found");
	}

	const row = await prisma.conversationMessage.create({
		data: {
			conversationId,
			role,
			content,
			...(isPersistedMessageOrigin(origin) ? { origin } : {}),
			...(bot?.fromBotId ? { fromBotId: bot.fromBotId } : {}),
			...(bot?.fromBotName ? { fromBotName: bot.fromBotName } : {}),
			...(bot?.botMessageId ? { botMessageId: bot.botMessageId } : {}),
			...(role === "assistant" && currentMessageRunId() ? { runId: currentMessageRunId() } : {}),
		},
	});

	return toSessionMessage(row);
}

/**
 * Fala do assistente no instante em que ela acontece no run (resposta da triagem, texto de um passo com
 * tools). `createdAt` é o relógio do servidor na emissão, nunca o do início/fim do run: a ordem da thread
 * (createdAt, id) fica igual à ordem real em que usuário e assistente se alternaram. Não repete a fala idêntica que já é a última da
 * conversa (retry/retomada do run). Devolve null se já existia.
 */
export async function appendRunAssistantSegment(
	conversationId: string,
	content: string,
	options: { createdAt?: Date } = {},
): Promise<SessionMessage | null> {
	const text = content.trim();
	if (!text) return null;
	// Retry/retomada do run reemite o mesmo passo: a mesma fala logo depois dela mesma não entra duas vezes.
	const last = await prisma.conversationMessage.findFirst({
		where: { conversationId },
		orderBy: [{ createdAt: "desc" }, { id: "desc" }],
		select: { role: true, content: true },
	});
	if (last?.role === "assistant" && last.content === text) return null;
	const row = await prisma.conversationMessage.create({
		data: { conversationId, role: "assistant", content: text, ...(options.createdAt ? { createdAt: options.createdAt } : {}), ...(currentMessageRunId() ? { runId: currentMessageRunId() } : {}) },
	});
	return toSessionMessage(row);
}

/** Grava o card na timeline, imediatamente após o pedido do usuário. */
export async function appendConversationCard(
	conversationId: string,
	card: PersistedConversationCard | PersistedSkillProposalCard,
	options: { createdAt?: Date } = {},
): Promise<SessionMessage> {
	const existing = await prisma.conversation.findUnique({
		where: { id: conversationId },
		select: { id: true },
	});
	if (!existing) {
		throw new Error("Conversation not found");
	}

	const row = await prisma.conversationMessage.create({
		data: {
			conversationId,
			role: card.kind,
			content: serializeConversationCard(card),
			...(options.createdAt ? { createdAt: options.createdAt } : {}),
			...(currentMessageRunId() ? { runId: currentMessageRunId() } : {}),
		},
	});

	return toSessionMessage(row);
}

/** Persiste uma decisão JEV na conversa do dono, uma vez por chamada MCP. */
export async function persistJevStatusCard(
	conversationId: string,
	userId: string,
	card: PersistedJevStatusCard,
): Promise<SessionMessage | null> {
	const normalized = parseConversationCard(serializeConversationCard(card));
	if (normalized?.kind !== "jev-status") return null;
	const conversation = await prisma.conversation.findFirst({
		where: { id: conversationId, userId, bot: { is: { ownerId: userId } } },
		select: { id: true },
	});
	if (!conversation) return null;
	const existing = await prisma.conversationMessage.findMany({
		where: { conversationId, role: "jev-status" },
		orderBy: { createdAt: "desc" },
		take: 100,
	});
	const duplicate = existing.find((row) => {
		const prior = parseConversationCard(row.content);
		return prior?.kind === "jev-status" &&
			prior.runId === normalized.runId && prior.toolCallId === normalized.toolCallId;
	});
	if (duplicate) return toSessionMessage(duplicate);
	return appendConversationCard(conversationId, normalized);
}

function stripEventType(event: { type: string } & Record<string, unknown>): Record<string, unknown> {
	const { type: _type, startedAt: _startedAt, ...rest } = event;
	return rest;
}

export async function persistConversationCardFromEvent(
	conversationId: string | null | undefined,
	event: ComputerUseEvent | { type: string } & Record<string, unknown>,
	options: { runStartedAt?: Date } = {},
): Promise<void> {
	if (!conversationId) return;
	if (event.type === "images") {
		const card = parseConversationCard(JSON.stringify({ v: 1, kind: "images", origin: "assistant", items: event.items, ...(typeof event.caption === "string" ? { caption: event.caption } : {}) }));
		if (card?.kind === "images") await appendConversationCard(conversationId, card);
		return;
	}
	// Execução do run_code: o cartão nasce no instante em que a chamada começou (ordem real na thread).
	if (event.type === "code-run") {
		const card = parseConversationCard(JSON.stringify({ v: 1, kind: "code-run", ...stripEventType(event) }));
		if (card?.kind !== "code-run") return;
		const startedAt = typeof event.startedAt === "string" ? new Date(event.startedAt) : undefined;
		await appendConversationCard(conversationId, card, startedAt && !Number.isNaN(startedAt.getTime()) ? { createdAt: startedAt } : {});
		return;
	}
	// Gráfico nativo do run_code (*.chart.json): o spec validado fica no próprio cartão.
	if (event.type === "chart") {
		const card = parseConversationCard(JSON.stringify({ v: 1, kind: "chart", ...stripEventType(event) }));
		if (card?.kind === "chart") await appendConversationCard(conversationId, card);
		return;
	}
	if (event.type === "skill") {
		const action = event.action;
		if (
			action !== "created" &&
			action !== "updated" &&
			action !== "deleted" &&
			action !== "shown" &&
			action !== "listed" &&
			action !== "cleaned"
		) {
			return;
		}
		const items = Array.isArray(event.items)
			? (event.items as SkillListItemData[])
			: undefined;
		const card: PersistedSkillCard = {
			v: 1,
			kind: "skill",
			action,
			...(typeof event.title === "string" ? { title: event.title } : {}),
			...(typeof event.capabilityKey === "string"
				? { capabilityKey: event.capabilityKey }
				: {}),
			...(typeof event.versionNumber === "number"
				? { versionNumber: event.versionNumber }
				: {}),
			...(typeof event.detail === "string" ? { detail: event.detail } : {}),
			...(items ? { items } : {}),
			...(typeof event.draftCount === "number" ? { draftCount: event.draftCount } : {}),
			...(event.learned === true && typeof event.skillId === "string" ? { learned: true, skillId: event.skillId } : {}),
		};
		await appendConversationCard(conversationId, card);
		return;
	}
	if (event.type === "login") {
		if (typeof event.loginId !== "string" || typeof event.site !== "string" || typeof event.url !== "string") return;
		// Um card por loginId: o evento de "done" atualiza o existente.
		if (event.status === "done") {
			await markLoginCardDone(conversationId, event.loginId);
			return;
		}
		const existing = await findLoginCard(conversationId, event.loginId);
		if (existing) return;
		await appendConversationCard(conversationId, {
			v: 1,
			kind: "login",
			loginId: event.loginId,
			site: event.site,
			url: event.url,
			status: "pending",
			...(typeof event.runId === "string" ? { runId: event.runId } : {}),
			...(event.reason === "captcha" ? { reason: "captcha" as const } : {}),
			...(parseComposioToolkitSlug(event.composioToolkit) ? { composioToolkit: parseComposioToolkitSlug(event.composioToolkit)! } : {}),
			...(parseLoginConnector(event.connector) ? { connector: parseLoginConnector(event.connector)! } : {}),
			...(parseLoginVaultOffer(event.vault) ? { vault: parseLoginVaultOffer(event.vault)! } : {}),
			...(typeof event.vaultTried === "string" && event.vaultTried ? { vaultTried: event.vaultTried.slice(0, 400) } : {}),
			...(event.codeField === true ? { codeField: true as const } : {}),
		});
		emitUserNeeded({ conversationId, cardId: event.loginId, detail: `Entrar em ${event.site}` });
		return;
	}
	if (event.type === "file") {
		if (typeof event.artifactId !== "string" || typeof event.filename !== "string") return;
		await appendConversationCard(conversationId, {
			v: 1,
			kind: "file",
			artifactId: event.artifactId,
			filename: event.filename,
			mime: typeof event.mime === "string" ? event.mime : "application/octet-stream",
			size: typeof event.size === "number" ? event.size : 0,
			format:
				event.format === "docx" || event.format === "pdf" || event.format === "xlsx" || event.format === "pptx"
					? event.format
					: "text",
			version: typeof event.version === "number" && event.version >= 1 ? event.version : 1,
			...(typeof event.runId === "string" ? { runId: event.runId } : {}),
		});
		return;
	}
	if (event.type === "confirm") {
		if (typeof event.confirmId !== "string" || typeof event.title !== "string") return;
		// A conversa tem uma só intenção pendente: um pedido novo de comando/escrita substitui o anterior, e o
		// card antigo não pode ficar "Precisa de aprovação" para sempre acima do novo.
		if (parseDevApprovalInfo(event.devApproval)) await supersedePendingDevApprovals(conversationId, event.confirmId).catch(() => undefined);
		await appendConversationCard(conversationId, {
			v: 1,
			kind: "confirm",
			confirmId: event.confirmId,
			title: event.title,
			status: event.status === "approved" || event.status === "rejected" || event.status === "failed" ? event.status : "pending",
			...(typeof event.description === "string" ? { description: event.description } : {}),
			...(typeof event.confirmLabel === "string" ? { confirmLabel: event.confirmLabel } : {}),
			...(typeof event.cancelLabel === "string" ? { cancelLabel: event.cancelLabel } : {}),
			...(typeof event.alwaysLabel === "string" ? { alwaysLabel: event.alwaysLabel } : {}),
			...(typeof event.callKey === "string" ? { callKey: event.callKey } : {}),
			...(parseDevApprovalInfo(event.devApproval) ? { devApproval: parseDevApprovalInfo(event.devApproval) } : {}),
			...(parseSecretsRequestInfo(event.secretsRequest) ? { secretsRequest: parseSecretsRequestInfo(event.secretsRequest) } : {}),
			...(parseEmailKeyRequestInfo(event.emailKeyRequest) ? { emailKeyRequest: parseEmailKeyRequestInfo(event.emailKeyRequest) } : {}),
			...(parsePlanInfo(event.plan) ? { plan: parsePlanInfo(event.plan) } : {}),
			...(parseGithubIdentityInfo(event.githubIdentity) ? { githubIdentity: parseGithubIdentityInfo(event.githubIdentity) } : {}),
		});
		if (event.status !== "approved" && event.status !== "rejected" && event.status !== "failed") {
			const dev = parseDevApprovalInfo(event.devApproval);
			emitUserNeeded({
				conversationId,
				cardId: event.confirmId,
				detail: approvalDetail({ title: event.title, devApproval: dev ? { kind: dev.kind, command: dev.kind === "command" ? dev.command : undefined, path: dev.kind === "command" ? undefined : dev.path } : null }),
			});
		}
		return;
	}
	if (event.type === "questionnaire") {
		if (typeof event.questionnaireId !== "string" || event.questionnaireId.trim().length === 0) return;
		if (typeof event.title !== "string" || event.title.trim().length === 0) return;
		if (!Array.isArray(event.items) || event.items.length === 0) return;
		const card: PersistedQuestionnaireCard = {
			v: 1,
			kind: "questionnaire",
			questionnaireId: event.questionnaireId,
			title: event.title,
			status:
				event.status === "submitted" || event.status === "dismissed" || event.status === "pending"
					? event.status
					: "pending",
			...(typeof event.description === "string" ? { description: event.description } : {}),
			items: event.items as QuestionnaireCardItem[],
			...(event.purpose === "task" || event.purpose === "onboarding"
				? { purpose: event.purpose }
				: {}),
			...(typeof event.originalRequest === "string" && event.originalRequest.trim()
				? { originalRequest: event.originalRequest.trim().slice(0, 500) }
				: {}),
		};
		// Uma proposta por vez: substitui o pendente anterior do mesmo run
		// (mesmo questionnaireId) em vez de empilhar um segundo card.
		const recent = await prisma.conversationMessage.findMany({
			where: { conversationId, role: "questionnaire" },
			orderBy: { createdAt: "desc" },
			take: 10,
		});
		const match = recent.find((row) => {
			const current = parseConversationCard(row.content);
			return (
				current !== null &&
				current.kind === "questionnaire" &&
				current.questionnaireId === card.questionnaireId &&
				current.status === "pending"
			);
		}) ?? null;
		if (match) {
			await prisma.conversationMessage.update({
				where: { id: match.id },
				// Reposiciona no fim da thread (ordem é por createdAt): a
				// saudação/confirmação do run já foi persistida antes.
				data: {
					content: serializeConversationCard(card),
					createdAt: new Date(),
				},
			});
			if (card.status === "pending") emitUserNeeded({ conversationId, cardId: card.questionnaireId, detail: card.title });
			return;
		}
		await appendConversationCard(conversationId, card);
		if (card.status === "pending") emitUserNeeded({ conversationId, cardId: card.questionnaireId, detail: card.title });
		return;
	}
	if (event.type === "bot-profile") {
		if (typeof event.proposalId !== "string" || !event.proposalId.trim()) return;
		if (typeof event.botId !== "string" || !event.botId.trim()) return;
		// Normaliza pela mesma validação do parse (tamanhos, campos, status).
		const card = parseConversationCard(
			JSON.stringify({
				v: 1,
				kind: "bot-profile",
				proposalId: event.proposalId,
				botId: event.botId,
				before: event.before,
				after: event.after,
				fields: event.fields,
				status: event.status === "approved" || event.status === "rejected" ? event.status : "pending",
			}),
		);
		if (!card || card.kind !== "bot-profile") return;
		// Uma proposta por vez: substitui a pendente anterior do mesmo run
		// (mesmo proposalId) em vez de empilhar um segundo card.
		const recent = await prisma.conversationMessage.findMany({
			where: { conversationId, role: "bot-profile" },
			orderBy: { createdAt: "desc" },
			take: 10,
		});
		const match = recent.find((row) => {
			const current = parseConversationCard(row.content);
			return (
				current !== null &&
				current.kind === "bot-profile" &&
				current.proposalId === card.proposalId &&
				current.status === "pending"
			);
		}) ?? null;
		if (match) {
			await prisma.conversationMessage.update({
				where: { id: match.id },
				data: {
					content: serializeConversationCard(card),
					createdAt: new Date(),
				},
			});
			return;
		}
		await appendConversationCard(conversationId, card);
		return;
	}
	if (event.type === "bot-proposal") {
		const { type: _type, ...fields } = event;
		const card = parseConversationCard(JSON.stringify({ v: 1, kind: "bot-proposal", ...fields }));
		if (!card || card.kind !== "bot-proposal") return;
		// Uma proposta pendente por proposalId (reenvio no mesmo run não empilha).
		const recent = await prisma.conversationMessage.findMany({
			where: { conversationId, role: "bot-proposal" },
			orderBy: { createdAt: "desc" },
			take: 20,
		});
		const match = recent.find((row) => {
			const current = parseConversationCard(row.content);
			return current?.kind === "bot-proposal" && current.proposalId === card.proposalId;
		});
		if (match) {
			const current = parseConversationCard(match.content);
			if (current?.kind === "bot-proposal" && current.status !== "pending") return;
			await prisma.conversationMessage.update({
				where: { id: match.id },
				data: { content: serializeConversationCard(card), createdAt: new Date() },
			});
			return;
		}
		await appendConversationCard(conversationId, card);
		return;
	}
	if (event.type === "skill-proposal") {
		// Mesma validação do parse da timeline; uma proposta pendente por proposalId.
		const { type: _type, ...fields } = event;
		const card = parseSkillProposalCard(JSON.stringify({ v: 1, kind: "skill-proposal", ...fields }));
		if (!card) return;
		const match = await findSkillProposalRow(conversationId, card.proposalId, "pending");
		if (match) {
			await prisma.conversationMessage.update({
				where: { id: match.id },
				data: { content: serializeConversationCard(card), createdAt: new Date() },
			});
			return;
		}
		await appendConversationCard(conversationId, card);
		return;
	}
	if (event.type === "provider_fallback") {
		const card = parseConversationCard(
			JSON.stringify({
				v: 1,
				kind: "provider-fallback",
				from: event.from,
				to: event.to,
				message: event.message,
			}),
		);
		if (!card || card.kind !== "provider-fallback") return;
		// Run retomado/reenfileirado repete o aviso: um card por run e par de modelos.
		if (options.runStartedAt) {
			const content = serializeConversationCard(card);
			const recent = await prisma.conversationMessage.findMany({
				where: { conversationId, role: "provider-fallback" },
				orderBy: { createdAt: "desc" },
				take: 50,
			});
			if (recent.some((row) => row.content === content && row.createdAt >= options.runStartedAt!)) return;
		}
		await appendConversationCard(conversationId, card);
		return;
	}
	if (event.type === "tool_budget_extended") {
		if (typeof event.tool !== "string" || typeof event.from !== "number" || typeof event.to !== "number") {
			return;
		}
		const card = parseConversationCard(
			JSON.stringify({
				v: 1,
				kind: "tool-budget",
				tool: event.tool,
				from: event.from,
				to: event.to,
				connectorName: event.connectorName,
			}),
		);
		if (!card || card.kind !== "tool-budget") return;
		await appendConversationCard(conversationId, card);
		return;
	}
	if (event.type === "routine") {
		const action = event.action;
		if (action !== "created" && action !== "listed" && action !== "updated") {
			return;
		}
		await appendConversationCard(conversationId, {
			v: 1,
			kind: "routine",
			action,
			...(typeof event.title === "string" ? { title: event.title } : {}),
			...(typeof event.routineId === "string" ? { routineId: event.routineId } : {}),
			...(event.triggerType === "cron" || event.triggerType === "event"
				? { triggerType: event.triggerType }
				: {}),
			...(typeof event.detail === "string" ? { detail: event.detail } : {}),
			...(typeof event.hookUrl === "string" ? { hookUrl: event.hookUrl } : {}),
			...(typeof event.hookSecret === "string" ? { hookSecret: event.hookSecret } : {}),
			...(Array.isArray(event.items) ? { items: event.items } : {}),
		});
	}
}

/**
 * Marca um card de questionário como respondido, persistindo as respostas.
 * Só toca card pendente (nunca reabre submitted/dismissed). Retorna o card
 * atualizado ou `null` se não houver pendente com esse ID.
 */
export async function submitQuestionnaireCard(
	conversationId: string,
	questionnaireId: string,
	answers: Record<string, string | string[]>,
): Promise<PersistedQuestionnaireCard | null> {
	const recent = await prisma.conversationMessage.findMany({
		where: { conversationId, role: "questionnaire" },
		orderBy: { createdAt: "desc" },
		take: 10,
	});
	const match = recent.find((row) => {
		const current = parseConversationCard(row.content);
		return (
			current !== null &&
			current.kind === "questionnaire" &&
			current.questionnaireId === questionnaireId &&
			current.status === "pending"
		);
	}) ?? null;
	if (!match) return null;
	const current = parseConversationCard(match.content);
	if (!current || current.kind !== "questionnaire") return null;
	const updated: PersistedQuestionnaireCard = {
		...current,
		status: "submitted",
		answers,
	};
	await prisma.conversationMessage.update({
		where: { id: match.id },
		data: { content: serializeConversationCard(updated) },
	});
	return updated;
}

/**
 * Diz se há card de questionário pendente na conversa (para fallback de
 * boas-vindas: só garante pergunta padrão quando o agente não emitiu nenhuma).
 */
export async function hasPendingQuestionnaireCard(
	conversationId: string,
): Promise<boolean> {
	const recent = await prisma.conversationMessage.findMany({
		where: { conversationId, role: "questionnaire" },
		orderBy: { createdAt: "desc" },
		take: 10,
	});
	return recent.some((row) => {
		const current = parseConversationCard(row.content);
		return (
			current !== null &&
			current.kind === "questionnaire" &&
			current.status === "pending"
		);
	});
}

/**
 * Reposiciona um card de questionário para o fim da thread (ordem por
 * createdAt). Usado na conclusão do run: o card foi gravado durante a
 * execução e a saudação/confirmação só depois — sem o toque, o card
 * apareceria acima da saudação (ordem invertida).
 * Só toca card pendente (nunca submitted/dismissed já respondidos).
 */
export async function touchQuestionnaireCard(
	conversationId: string,
	questionnaireId: string,
): Promise<void> {
	const recent = await prisma.conversationMessage.findMany({
		where: { conversationId, role: "questionnaire" },
		orderBy: { createdAt: "desc" },
		take: 10,
	});
	const match = recent.find((row) => {
		const current = parseConversationCard(row.content);
		return (
			current !== null &&
			current.kind === "questionnaire" &&
			current.questionnaireId === questionnaireId &&
			current.status === "pending"
		);
	}) ?? null;
	if (!match) return;
	await prisma.conversationMessage.update({
		where: { id: match.id },
		data: { createdAt: new Date() },
	});
}

/**
 * Resolve uma proposta de perfil (gate humano): marca approved/rejected.
 * Só toca proposta pendente. Retorna o card atualizado ou `null`.
 */
export async function resolveBotProfileCard(
	conversationId: string,
	proposalId: string,
	status: "approved" | "rejected",
): Promise<PersistedBotProfileCard | null> {
	const recent = await prisma.conversationMessage.findMany({
		where: { conversationId, role: "bot-profile" },
		orderBy: { createdAt: "desc" },
		take: 10,
	});
	const match = recent.find((row) => {
		const current = parseConversationCard(row.content);
		return (
			current !== null &&
			current.kind === "bot-profile" &&
			current.proposalId === proposalId &&
			current.status === "pending"
		);
	}) ?? null;
	if (!match) return null;
	const current = parseConversationCard(match.content);
	if (!current || current.kind !== "bot-profile") return null;
	const updated: PersistedBotProfileCard = { ...current, status };
	await prisma.conversationMessage.update({
		where: { id: match.id },
		data: { content: serializeConversationCard(updated) },
	});
	return updated;
}

async function findSkillProposalRow(
	conversationId: string,
	proposalId: string,
	status: PersistedSkillProposalCard["status"],
) {
	const recent = await prisma.conversationMessage.findMany({
		where: { conversationId, role: "skill-proposal" },
		orderBy: { createdAt: "desc" },
		take: 20,
	});
	return (
		recent.find((row) => {
			const current = parseSkillProposalCard(row.content);
			return current !== null && current.proposalId === proposalId && current.status === status;
		}) ?? null
	);
}

/** Proposta de skill ainda pendente na conversa (a API aplica o que está gravado, nunca o que o cliente manda). */
export async function getPendingSkillProposal(
	conversationId: string,
	proposalId: string,
): Promise<PersistedSkillProposalCard | null> {
	const row = await findSkillProposalRow(conversationId, proposalId, "pending");
	return row ? parseSkillProposalCard(row.content) : null;
}

/** Marca a proposta de skill como aprovada/recusada. Só toca proposta pendente. */
export async function resolveSkillProposalCard(
	conversationId: string,
	proposalId: string,
	status: "approved" | "rejected",
): Promise<PersistedSkillProposalCard | null> {
	const row = await findSkillProposalRow(conversationId, proposalId, "pending");
	const current = row ? parseSkillProposalCard(row.content) : null;
	if (!row || !current) return null;
	const updated: PersistedSkillProposalCard = { ...current, status };
	await prisma.conversationMessage.update({ where: { id: row.id }, data: { content: serializeConversationCard(updated) } });
	return updated;
}

/**
 * Reposiciona uma proposta de perfil pendente para o fim da thread.
 * Mesmo motivo do questionário: gravada durante o run, texto final depois.
 */
export async function touchBotProfileCard(
	conversationId: string,
	proposalId: string,
): Promise<void> {
	const recent = await prisma.conversationMessage.findMany({
		where: { conversationId, role: "bot-profile" },
		orderBy: { createdAt: "desc" },
		take: 10,
	});
	const match = recent.find((row) => {
		const current = parseConversationCard(row.content);
		return (
			current !== null &&
			current.kind === "bot-profile" &&
			current.proposalId === proposalId &&
			current.status === "pending"
		);
	}) ?? null;
	if (!match) return;
	await prisma.conversationMessage.update({
		where: { id: match.id },
		data: { createdAt: new Date() },
	});
}

async function findLoginCard(conversationId: string, loginId: string) {
	const rows = await prisma.conversationMessage.findMany({
		where: { conversationId, role: "login" },
		orderBy: { createdAt: "desc" },
		take: 20,
	});
	for (const row of rows) {
		const card = parseConversationCard(row.content);
		if (card?.kind === "login" && card.loginId === loginId) return { row, card };
	}
	return null;
}

/** "Terminei": o card de login deixa de pedir ação (a retomada do run é do /resume). */
export async function markLoginCardDone(conversationId: string, loginId: string): Promise<void> {
	const found = await findLoginCard(conversationId, loginId);
	if (!found || found.card.status === "done") return;
	await prisma.conversationMessage.update({
		where: { id: found.row.id },
		data: { content: serializeConversationCard({ ...found.card, status: "done" }) },
	});
}

/** Cards de aprovação de código ainda pendentes (menos `exceptConfirmId`) viram recusados: foram substituídos por um pedido mais novo. */
export async function supersedePendingDevApprovals(conversationId: string, exceptConfirmId: string): Promise<number> {
	const rows = await prisma.conversationMessage.findMany({
		where: { conversationId, role: "confirm" },
		orderBy: { createdAt: "desc" },
		take: 50,
	});
	let changed = 0;
	for (const row of rows) {
		const card = parseConversationCard(row.content);
		if (!card || card.kind !== "confirm" || !card.devApproval || card.status !== "pending" || card.confirmId === exceptConfirmId) continue;
		await prisma.conversationMessage.update({
			where: { id: row.id },
			data: { content: serializeConversationCard({ ...card, status: "rejected", outcome: { ok: false, detail: SUPERSEDED_CARD_DETAIL } }) },
		});
		changed += 1;
	}
	return changed;
}

export async function updateConfirmCardStatus(
	conversationId: string,
	status: "pending" | "approved" | "rejected" | "failed",
	confirmId?: string,
	/** Quando informado, só mexe em conversa do dono (e de bot do dono). */
	ownerId?: string,
	/** Resultado da chamada executada: fica no card para o agente não pedir a mesma de novo. */
	outcome?: { ok: boolean; detail: string },
): Promise<void> {
	if (ownerId) {
		const owned = await prisma.conversation.findFirst({
			where: { id: conversationId, userId: ownerId, bot: { is: { ownerId } } },
			select: { id: true },
		});
		if (!owned) return;
	}
	const rows = await prisma.conversationMessage.findMany({
		where: { conversationId, role: "confirm" },
		orderBy: { createdAt: "desc" },
		take: 20,
	});
	const match =
		rows.find((row) => {
			const card = parseConversationCard(row.content);
			if (!card || card.kind !== "confirm") return false;
			if (confirmId) return card.confirmId === confirmId;
			return card.status === "pending";
		}) ?? null;
	if (!match) return;
	const current = parseConversationCard(match.content);
	if (!current || current.kind !== "confirm") return;
	await prisma.conversationMessage.update({
		where: { id: match.id },
		data: { content: serializeConversationCard({ ...current, status, ...(outcome ? { outcome: { ok: outcome.ok, detail: outcome.detail.slice(0, 2000) } } : {}) }) },
	});
}

/**
 * Chamada de conector (mesma tool + args) que o usuário já confirmou e a API já
 * executou nesta conversa. Evita pedir a mesma confirmação em laço.
 */
export async function findExecutedConfirmCall(
	conversationId: string,
	callKey: string,
	/** Janela em que a aprovação vale (padrão 15 min). */
	windowMs = 15 * 60_000,
): Promise<{ ok: boolean; detail: string } | null> {
	const rows = await prisma.conversationMessage.findMany({
		where: { conversationId, role: "confirm" },
		orderBy: { createdAt: "desc" },
		take: 30,
	});
	for (const row of rows) {
		const card = parseConversationCard(row.content);
		// Janela curta: o mesmo pedido horas depois pode ser legítimo e volta a pedir confirmação.
		if (Date.now() - row.createdAt.getTime() > windowMs) break;
		if (card?.kind === "confirm" && card.callKey === callKey && card.outcome) return card.outcome;
	}
	return null;
}

/**
 * Estado do cartão de confirmação mais recente da conversa (`dev`: é aprovação de sessão de código)
 * (`null` = não há). Serve para reconhecer um "Executar" repetido de um cartão
 * que já foi decidido: o clique duplicado não vira mensagem nem run novos.
 */
export async function getLatestConfirmCardStatus(
	conversationId: string,
): Promise<{ confirmId: string; status: "pending" | "approved" | "rejected" | "failed"; dev: boolean } | null> {
	const rows = await prisma.conversationMessage.findMany({
		where: { conversationId, role: "confirm" },
		orderBy: { createdAt: "desc" },
		take: 20,
	});
	for (const row of rows) {
		const card = parseConversationCard(row.content);
		if (card?.kind === "confirm") return { confirmId: card.confirmId, status: card.status, dev: Boolean(card.devApproval) };
	}
	return null;
}

/** Marca d'água da conversa: a última mensagem (qualquer papel) e quantas existem até ela. */
export type ConversationWatermark = { messageId: string; createdAt: string; count: number };

const upToAnchor = (anchor: { createdAt: Date; id: string }) => ({
	OR: [{ createdAt: { lt: anchor.createdAt } }, { createdAt: anchor.createdAt, id: { lte: anchor.id } }],
});

/** Marca d'água no instante em que o run começa a montar o histórico; `null` se a conversa está vazia. */
export async function getConversationWatermark(conversationId: string): Promise<ConversationWatermark | null> {
	const last = await prisma.conversationMessage.findFirst({
		where: { conversationId },
		orderBy: [{ createdAt: "desc" }, { id: "desc" }],
		select: { id: true, createdAt: true },
	});
	if (!last) return null;
	const count = await prisma.conversationMessage.count({ where: { conversationId, ...upToAnchor(last) } });
	return { messageId: last.id, createdAt: last.createdAt.toISOString(), count };
}

export type MessagesAfterWatermark =
	| { ok: true; messages: SessionMessage[] }
	| { ok: false; reason: "watermark_missing" | "history_shrunk" };

/**
 * Falas (usuário/assistente) gravadas DEPOIS da marca d'água e que não vieram do run informado (o que o run
 * gravou já está na conversa dele). Divergência por id: a mensagem da marca sumiu ou há menos mensagens até
 * ela do que havia = o histórico mudou e a conversa gravada não vale.
 */
export async function loadMessagesAfterWatermark(
	conversationId: string,
	watermark: { messageId: string; count: number },
	options: { excludeRunId: string; limit?: number },
): Promise<MessagesAfterWatermark> {
	const anchor = await prisma.conversationMessage.findFirst({
		where: { id: watermark.messageId, conversationId },
		select: { id: true, createdAt: true },
	});
	if (!anchor) return { ok: false, reason: "watermark_missing" };
	const countNow = await prisma.conversationMessage.count({ where: { conversationId, ...upToAnchor(anchor) } });
	if (countNow < watermark.count) return { ok: false, reason: "history_shrunk" };
	const rows = await prisma.conversationMessage.findMany({
		where: {
			conversationId,
			role: { in: [...LLM_CHAT_ROLES] },
			AND: [
				{ OR: [{ createdAt: { gt: anchor.createdAt } }, { createdAt: anchor.createdAt, id: { gt: anchor.id } }] },
				{ OR: [{ runId: null }, { runId: { not: options.excludeRunId } }] },
			],
		},
		orderBy: [{ createdAt: "asc" }, { id: "asc" }],
		take: options.limit ?? 200,
	});
	return { ok: true, messages: foldAutomatedMessages(rows.map(toSessionMessage).filter((row) => isLlmChatRole(row.role))) };
}

/**
 * Janela de histórico para o modelo. Saída de rotina/webhook anterior à última
 * mensagem do usuário não entra: ela empurrava a conversa real para fora da
 * janela e virava "a tarefa atual" num "tente de novo". A que veio depois da
 * última fala do usuário fica (ele pode estar respondendo a ela), rotulada e
 * agrupada como automatizada.
 */
export async function loadRecentConversationMessages(
	conversationId: string,
	limit = 40,
): Promise<SessionMessage[]> {
	const lastUser = await prisma.conversationMessage.findFirst({
		where: { conversationId, role: "user", origin: null },
		orderBy: { createdAt: "desc" },
		select: { createdAt: true },
	});
	const rows = await prisma.conversationMessage.findMany({
		where: {
			conversationId,
			role: { in: [...LLM_CHAT_ROLES] },
			// Conversa entre bots (origin "bot") é histórico normal: não some quando o usuário fala depois.
			...(lastUser ? { OR: [{ origin: null }, { origin: "bot" }, { createdAt: { gt: lastUser.createdAt } }] } : {}),
		},
		orderBy: { createdAt: "desc" },
		take: limit,
	});

	return foldAutomatedMessages(
		rows.reverse().map(toSessionMessage).filter((row) => isLlmChatRole(row.role)),
	);
}
