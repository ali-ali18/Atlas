import { prisma } from "./client.js";
import { appendConversationCard, appendConversationMessage, getOwnedConversation, ResourceOwnershipError } from "./conversations.js";
import { withMessageRunId } from "./message-run-context.js";
import { resolveUserFileCards } from "./file-attachments.js";
import { imageAttachmentsOf, resolveUserImagesCard } from "./image-attachments.js";
import { settleRoutineRunForAgentRun } from "./routines.js";
import type {
	AgentRun,
	AgentRunCheckpoint,
	AgentRunOrigin,
	AgentRunStatus,
	AgentStepStatus,
	AgentStepType,
	CreateAgentRunRequest,
	CreateRunInputRequest,
	RunEventRecord,
	RunInputMode,
	RunInputRecord,
	RunInputStatus,
	RunUsage,
} from "@workspace/shared";
import { AGENT_RUNTIME_CHECKPOINT_VERSION, buildMessageSource, LIVE_RUN_INPUT_MODES, isCardConfirmToken, isPersistedMessageOrigin, normalizeRunInputMode, openItems, parseTaskLedger, parseToolResultStatus, redactSecrets } from "@workspace/shared";
import type { ToolResultStatus } from "@workspace/shared";
import type { ComputerUseEvent, ConversationTaskContext, ResearchNote, TaskLedger } from "@workspace/shared";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { ownerIds } from "./mcp-connections.js";
import { getGroupAuthor, isGroupConversation } from "./group-lookup.js";

export const ACTIVE_STATUSES: AgentRunStatus[] = [
	"queued",
	"running",
	"waiting_user",
	"waiting_external",
	"paused",
	"retrying",
];

/**
 * F4 — a conversa pode ter sido apagada no meio do run. Sem ela, finalize e
 * steer terminam sem gravar a mensagem (sem FK `conversation_messages`).
 */
export async function conversationAlive(
	conversationId: string,
): Promise<boolean> {
	const row = await prisma.conversation
		.findUnique({ where: { id: conversationId }, select: { id: true } })
		.catch(() => null);
	return row !== null;
}

function asStatus(value: string): AgentRunStatus {
	return value as AgentRunStatus;
}

function asOrigin(value: string): AgentRunOrigin {
	return value as AgentRunOrigin;
}

function toIso(value: Date | null | undefined): string | null {
	return value ? value.toISOString() : null;
}

function mapRun(row: {
	id: string;
	userId: string;
	botId: string | null;
	conversationId: string | null;
	origin: string;
	parentRunId?: string | null;
	objective: string;
	status: string;
	model: string;
	maxSteps: number;
	sandboxSessionId: string | null;
	error: string | null;
	resultText: string | null;
	cancelRequested: boolean;
	budgetJson?: unknown;
	usageJson?: unknown;
	createdAt: Date;
	updatedAt: Date;
	startedAt: Date | null;
	finishedAt: Date | null;
}): AgentRun {
	return {
		id: row.id,
		userId: row.userId,
		botId: row.botId,
		conversationId: row.conversationId,
		origin: asOrigin(row.origin),
		parentRunId: row.parentRunId ?? null,
		objective: row.objective,
		status: asStatus(row.status),
		model: row.model,
		maxSteps: row.maxSteps,
		sandboxSessionId: row.sandboxSessionId,
		error: row.error,
		resultText: row.resultText,
		cancelRequested: row.cancelRequested,
		budgetJson: (row.budgetJson as unknown) ?? null,
		usageJson: (row.usageJson as unknown) ?? null,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
		startedAt: toIso(row.startedAt),
		finishedAt: toIso(row.finishedAt),
	};
}

function lastUserObjective(messages: CreateAgentRunRequest["messages"]): string {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const message = messages[i];
		if (message?.role === "user" && message.content.trim().length > 0) {
			return message.content.trim();
		}
	}
	return "Objetivo não informado";
}

function isUniqueActiveRunConflict(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: string }).code === "P2002"
	);
}

/** Fallback quando a janela do modelo é desconhecida (decisão QA). */
export const DEFAULT_CONTEXT_LENGTH = 128_000;

function normalizeContextLength(value: unknown): number | null {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		return null;
	}
	return Math.floor(value);
}

/**
 * Monta o budgetJson persistido: budget do request + contextLength da Fase 0.
 * Preserva o comportamento antigo (undefined quando não há nada).
 */
function buildStoredBudget(
	budget: CreateAgentRunRequest["budget"],
	contextLength: number | null | undefined,
	modelAuto?: boolean,
): Prisma.InputJsonValue | undefined {
	const window = normalizeContextLength(contextLength);
	if (budget === undefined && window === null && !modelAuto) return undefined;
	return {
		...(budget as Record<string, unknown> | undefined),
		...(window !== null ? { contextLength: window } : {}),
		...(modelAuto ? { modelAuto: true } : {}),
	} as Prisma.InputJsonValue;
}

/** O run foi criado no modo Automático (modelos por dificuldade)? */
export function readRunModelAuto(run: { budgetJson?: unknown }): boolean {
	return (run.budgetJson as { modelAuto?: unknown } | null | undefined)?.modelAuto === true;
}

/** Lê a janela gravada na criação; fallback 128k (nunca explode). */
export function readRunContextLength(
	run: { budgetJson?: unknown },
	fallback = DEFAULT_CONTEXT_LENGTH,
): number {
	const raw = (
		run.budgetJson as { contextLength?: unknown } | null | undefined
	)?.contextLength;
	return normalizeContextLength(raw) ?? fallback;
}

/** Resolve posse e vínculo antes de ferramentas/cards; não grava dados. */
export async function validateAgentRunOwnership(
	request: Pick<CreateAgentRunRequest, "botId" | "conversationId">,
	userId: string,
): Promise<{ botId: string | null; conversationId: string | null }> {
	if (!userId.trim() || userId === "default") throw new ResourceOwnershipError();
	let conversationId = request.conversationId ?? null;
	if (conversationId && !await getOwnedConversation(conversationId, userId)) throw new ResourceOwnershipError();
	if (request.botId) {
		const bot = await prisma.bot.findFirst({
			where: { id: request.botId, ownerId: userId },
			select: { id: true, conversationId: true },
		});
		if (!bot) throw new ResourceOwnershipError();
		// Grupo: o membro roda na conversa do grupo (que pertence ao bot-grupo, não a ele).
		const group = conversationId && bot.conversationId !== conversationId
			? await prisma.bot.findFirst({ where: { conversationId, ownerId: userId, memberIds: { has: bot.id } }, select: { id: true } })
			: null;
		if (conversationId && bot.conversationId && bot.conversationId !== conversationId && !group) throw new ResourceOwnershipError();
		if (!conversationId && bot.conversationId) {
			if (!await getOwnedConversation(bot.conversationId, userId)) throw new ResourceOwnershipError();
			conversationId = bot.conversationId;
		}
		if (conversationId) {
			const linkedBot = await prisma.bot.findFirst({ where: { conversationId, ownerId: userId, id: { not: bot.id } }, select: { id: true } });
			if (linkedBot && linkedBot.id !== group?.id) throw new ResourceOwnershipError();
		}
	}
	return { botId: request.botId ?? null, conversationId };
}

/** Linha `queued` de um run novo (checkpoint inicial incluso); compartilhada por createAgentRun e createFollowUpRun. */
export function buildQueuedRunData(input: {
	request: CreateAgentRunRequest;
	model: string;
	userId: string;
	conversationId: string | null;
	contextLength?: number | null;
	/** Modo Automático do composer: o worker escolhe o modelo pela dificuldade do pedido. */
	modelAuto?: boolean;
	/** Arquivos anexados (não imagens): o worker põe o conteúdo no contexto do primeiro passo. */
	fileArtifactIds?: string[];
}) {
	const { request, model, userId, conversationId } = input;
	const maxSteps =
		typeof request.maxSteps === "number" && Number.isFinite(request.maxSteps)
			? Math.max(1, Math.min(100, Math.floor(request.maxSteps)))
			: 100;

	const checkpoint: AgentRunCheckpoint = {
		version: AGENT_RUNTIME_CHECKPOINT_VERSION,
		messages: request.messages,
		...(request.transcriptSeed ? { transcriptSeed: request.transcriptSeed } : {}),
		...(request.attachments?.length ? { userImageArtifactIds: request.attachments.map((item) => item.artifactId) } : {}),
		...(input.fileArtifactIds?.length ? { userFileArtifactIds: input.fileArtifactIds } : {}),
		nextStepIndex: 0,
		consumedInputIds: [],
		compact: request.compact === true,
	};
	return {
		userId,
		botId: request.botId ?? null,
		conversationId,
		origin: request.origin ?? "chat",
		objective: request.objective?.trim() || lastUserObjective(request.messages),
		status: "queued" as const,
		model,
		maxSteps,
		sandboxSessionId: request.sandboxSessionId ?? null,
		checkpointJson: checkpoint as unknown as Prisma.InputJsonValue,
		budgetJson: buildStoredBudget(request.budget, input.contextLength, input.modelAuto),
	};
}

export async function createAgentRun(input: {
	request: CreateAgentRunRequest;
	model: string;
	userId?: string;
	/** Janela de contexto do modelo (Fase 0). Vai para budgetJson.contextLength; worker consome, fallback 128k. */
	contextLength?: number | null;
	/** Modo Automático do composer (gravado no budgetJson; o worker lê). */
	modelAuto?: boolean;
	/**
	 * A conversa já tinha run ativo e a mensagem virou entrada `join` nele (em vez de run novo).
	 * O chamador acorda o worker (sinal de run); o db não conhece Redis.
	 */
	onMergedIntoActiveRun?: (runId: string) => void | Promise<void>;
}): Promise<AgentRun> {
	const { request, model } = input;
	const userId = input.userId?.trim();
	// Sem identidade explícita não criamos linhas legadas nem aceitamos IDs externos.
	if (!userId || userId === "default") throw new ResourceOwnershipError();

	const { conversationId } = await validateAgentRunOwnership(request, userId);

	const origin = request.origin ?? "chat";
	const imagesCard = await resolveUserImagesCard(request.attachments ?? [], userId);
	const fileCards = await resolveUserFileCards(request.attachments ?? [], userId);
	// A conversa de um grupo nunca vira a conversa própria de um membro.
	if (request.botId && conversationId && !(await isGroupConversation(conversationId))) {
		await prisma.bot.updateMany({
			where: { id: request.botId, ownerId: userId, conversationId: null },
			data: { conversationId },
		});
	}
	// Corrida com o fim do run que ocupava a conversa: o índice único recusa o create, mas na hora de procurar
	// o run ativo ele já terminou. Nesse caso o slot está livre, então tenta criar de novo (uma vez) em vez de
	// devolver o erro cru do Prisma.
	for (let attempt = 0; ; attempt += 1) {
	try {
		const row = await prisma.agentRun.create({
			data: buildQueuedRunData({
				request: fileCards.length ? { ...request, attachments: await imageAttachmentsOf(request.attachments ?? [], userId) } : request,
				model, userId, conversationId, contextLength: input.contextLength, modelAuto: input.modelAuto,
				fileArtifactIds: fileCards.map((card) => card.artifactId),
			}),
		});
		if (conversationId && origin !== "routine" && request.silent !== true) {
			const objective =
				request.objective?.trim() || lastUserObjective(request.messages);
			if (objective && objective !== "Objetivo não informado") {
				await appendConversationMessage(conversationId, "user", objective, origin);
			}
			if (imagesCard || fileCards.length) {
				if (objective === "Objetivo não informado") await appendConversationMessage(conversationId, "user", "");
				if (imagesCard) await appendConversationCard(conversationId, imagesCard);
				for (const card of fileCards) await appendConversationCard(conversationId, card);
			}
		}
		return mapRun(row);
	} catch (error) {
		if (!conversationId || !isUniqueActiveRunConflict(error)) throw error;
		const existing = await prisma.agentRun.findFirst({
			where: {
				conversationId,
				userId,
				status: { in: ACTIVE_STATUSES },
			},
			orderBy: { createdAt: "desc" },
		});
		if (!existing) {
			if (attempt < 1) continue;
			throw error;
		}
		// Rotina e mensagem entre bots não "steeram" um run de chat — quem chama trata o ocupado à parte.
		if (origin === "routine" || origin === "bot" || origin === "proactive") {
			return mapRun(existing);
		}
		const content = lastUserObjective(request.messages);
		if ((content && content !== "Objetivo não informado") || request.attachments?.length) {
			// Retry seguro de close/bot-created: clientKey deduplica por
			// (runId, clientKey) em createRunInput; sem ele, o retry cai em
			// steer com novo seq (aceitável).
			await createRunInput(existing.id, {
				content: content === "Objetivo não informado" ? "" : content,
				mode: "join",
				...(request.attachments?.length ? { attachments: request.attachments } : {}),
				...(request.clientKey ? { clientKey: request.clientKey } : {}),
				...(request.silent === true ? { silent: true as const } : {}),
			}, userId);
			await input.onMergedIntoActiveRun?.(existing.id);
		}
		return mapRun(existing);
	}
	}
}

/** O índice único (um run ativo por conversa) recusou o create e não há run ativo do dono para receber a mensagem. */
export function isActiveRunConflict(error: unknown): boolean {
	return isUniqueActiveRunConflict(error);
}

export type FollowUpResult =
	| { outcome: "created"; run: AgentRun }
	/** Outra entrega do mesmo job já consumiu os inputs: nada a fazer. */
	| { outcome: "already_consumed" }
	/** A conversa já tinha run ativo: os inputs viraram steer nele. */
	| { outcome: "merged"; runId: string };

class FollowUpAlreadyConsumed extends Error {}

/**
 * Follow-up do fim do run: cria o run `queued` (sem `jobEnqueuedAt`) e consome
 * os inputs do run pai na MESMA transação. O consumo vem primeiro e serve de
 * trava: duas entregas do mesmo job serializam na linha dos inputs e a segunda
 * vê count < esperado, desfaz tudo e devolve `already_consumed`. Um crash
 * deixa tudo-ou-nada; run `queued` sem job é re-enfileirado por
 * `listQueuedRunsMissingJob` (sem outbox próprio).
 *
 * `defer`: inputs que não couberam no teto de anexos viram inputs pendentes do
 * novo run (nada é consumido sem ser entregue).
 */
export async function createFollowUpRun(input: {
	parentRunId: string;
	userId: string;
	model: string;
	contextLength?: number | null;
	request: CreateAgentRunRequest;
	consume: RunInputRecord[];
	defer?: RunInputRecord[];
}): Promise<FollowUpResult> {
	const userId = input.userId.trim();
	if (!userId || userId === "default") throw new ResourceOwnershipError();
	const parent = await prisma.agentRun.findFirst({
		where: { id: input.parentRunId, userId },
		select: { id: true },
	});
	if (!parent) throw new ResourceOwnershipError();
	if (input.consume.length === 0) throw new Error("follow-up sem inputs");
	const defer = input.defer ?? [];
	const { conversationId } = await validateAgentRunOwnership(input.request, userId);

	const claim = async (tx: Prisma.TransactionClient, inputs: RunInputRecord[]) => {
		if (inputs.length === 0) return;
		const claimed = await tx.runInput.updateMany({
			where: {
				runId: input.parentRunId,
				id: { in: inputs.map((item) => item.id) },
				status: "pending",
			},
			data: { status: "consumed", consumedAt: new Date() },
		});
		if (claimed.count !== inputs.length) throw new FollowUpAlreadyConsumed();
	};

	try {
		const row = await prisma.$transaction(async (tx) => {
			await claim(tx, [...input.consume, ...defer]);
			const created = await tx.agentRun.create({
				data: buildQueuedRunData({
					request: input.request,
					model: input.model,
					userId,
					conversationId,
					contextLength: input.contextLength,
				}),
			});
			for (const [index, item] of defer.entries()) {
				await tx.runInput.create({
					data: {
						runId: created.id,
						seq: index + 1,
						author: item.author,
						content: item.content,
						mode: item.mode,
						attachmentsJson: item.attachments?.length ? item.attachments : undefined,
						status: "pending",
						clientKey: `moved-${item.id}`,
					} as never,
				});
			}
			return created;
		});
		return { outcome: "created", run: mapRun(row) };
	} catch (error) {
		if (error instanceof FollowUpAlreadyConsumed) return { outcome: "already_consumed" };
		if (!conversationId || !isUniqueActiveRunConflict(error)) throw error;
		// Conversa com run ativo: não cria um segundo; entrega os inputs a ele como steer.
		return prisma.$transaction(async (tx) => {
			const active = await tx.agentRun.findFirst({
				where: { conversationId, userId, status: { in: ACTIVE_STATUSES } },
				orderBy: { createdAt: "desc" },
				select: { id: true },
			});
			if (!active) throw error;
			await claim(tx, [...input.consume, ...defer]);
			await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`run-input:${active.id}`}))`;
			const last = await tx.runInput.findFirst({
				where: { runId: active.id },
				orderBy: { seq: "desc" },
				select: { seq: true },
			});
			let seq = last?.seq ?? 0;
			for (const item of [...input.consume, ...defer]) {
				seq += 1;
				await tx.runInput.create({
					data: {
						runId: active.id,
						seq,
						author: item.author,
						content: item.content,
						mode: "join",
						attachmentsJson: item.attachments?.length ? item.attachments : undefined,
						status: "pending",
						clientKey: `followup-${item.id}`,
					} as never,
				});
			}
			return { outcome: "merged" as const, runId: active.id };
		}).catch((mergeError) => {
			if (mergeError instanceof FollowUpAlreadyConsumed) return { outcome: "already_consumed" as const };
			throw mergeError;
		});
	}
}

export async function getRunLeaseState(runId: string): Promise<{
	status: AgentRunStatus;
	cancelRequested: boolean;
	leaseOwner: string | null;
	leaseUntil: string | null;
} | null> {
	const row = await prisma.agentRun.findUnique({
		where: { id: runId },
		select: {
			status: true,
			cancelRequested: true,
			leaseOwner: true,
			leaseUntil: true,
		},
	});
	if (!row) return null;
	return {
		status: asStatus(row.status),
		cancelRequested: row.cancelRequested,
		leaseOwner: row.leaseOwner,
		leaseUntil: toIso(row.leaseUntil),
	};
}

export async function getAgentRun(runId: string): Promise<AgentRun | null> {
	const row = await prisma.agentRun.findUnique({ where: { id: runId } });
	return row ? mapRun(row) : null;
}

/** Legado não reivindicado nunca é compartilhado com sessões autenticadas. */
export async function getAgentRunForUser(
	runId: string,
	userId: string,
): Promise<AgentRun | null> {
	if (!userId.trim() || userId === "default") return null;
	const row = await prisma.agentRun.findFirst({ where: { id: runId, userId } });
	return row ? mapRun(row) : null;
}

/**
 * Estado mínimo do run para o stream SSE: existência (escopada pelo dono) + o que a checagem de
 * liveness precisa. Uma consulta com `select` curto no lugar da linha inteira (checkpoint, usage, texto...).
 */
export async function getAgentRunStreamState(
	runId: string,
	userId: string,
): Promise<{
	status: string;
	leaseUntil: string | null;
	createdAt: string;
	updatedAt: string;
	jobEnqueuedAt: string | null;
} | null> {
	if (!userId.trim() || userId === "default") return null;
	const row = await prisma.agentRun.findFirst({
		where: { id: runId, userId },
		select: { status: true, leaseUntil: true, createdAt: true, updatedAt: true, jobEnqueuedAt: true },
	});
	if (!row) return null;
	return {
		status: row.status,
		leaseUntil: toIso(row.leaseUntil),
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
		jobEnqueuedAt: toIso(row.jobEnqueuedAt),
	};
}

export async function getAgentRunLiveness(runId: string): Promise<{
	status: string;
	leaseUntil: string | null;
	createdAt: string;
	updatedAt: string;
	jobEnqueuedAt: string | null;
} | null> {
	const row = await prisma.agentRun.findUnique({
		where: { id: runId },
		select: {
			status: true,
			leaseUntil: true,
			createdAt: true,
			updatedAt: true,
			jobEnqueuedAt: true,
		},
	});
	if (!row) return null;
	return {
		status: row.status,
		leaseUntil: toIso(row.leaseUntil),
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
		jobEnqueuedAt: toIso(row.jobEnqueuedAt),
	};
}

export async function markAgentRunRetrying(
	runId: string,
	error: string,
	lease: RunLease,
): Promise<boolean> {
	return prisma.$transaction(async (tx) => {
		const changed = await tx.agentRun.updateMany({
			where: {
				id: runId,
				status: "running",
				cancelRequested: false,
				leaseOwner: lease.owner,
				leaseToken: lease.token,
				leaseUntil: { gt: new Date() },
			},
			data: { status: "retrying", error },
		});
		if (changed.count !== 1) return false;
		await lockRunEventSeq(tx, runId);
		await insertRunEventRow(tx, runId, "status", {
			type: "status", status: "retrying", detail: error,
		});
		return true;
	});
}

export async function getAgentRunCheckpoint(
	runId: string,
): Promise<AgentRunCheckpoint | null> {
	const row = await prisma.agentRun.findUnique({
		where: { id: runId },
		select: { checkpointJson: true },
	});
	if (!row?.checkpointJson || typeof row.checkpointJson !== "object") {
		return null;
	}
	return row.checkpointJson as AgentRunCheckpoint;
}

/**
 * Runs do dono parados (`paused`) num card de conexão do conector nativo
 * `catalogId` (checkpoint `pendingLogin.connector`). Usado para retomar o run
 * sozinho quando a conexão fica ativa, mesmo que feita pelo Marketplace.
 */
export async function listRunsAwaitingConnector(
	userId: string,
	catalogId: string,
	limit = 20,
	kind: "native" | "api" = "native",
): Promise<string[]> {
	const rows = await prisma.agentRun.findMany({
		where: { userId, status: "paused", cancelRequested: false },
		orderBy: { updatedAt: "desc" },
		take: limit,
		select: { id: true, checkpointJson: true },
	});
	return rows
		.filter((row) => {
			const checkpoint = row.checkpointJson as AgentRunCheckpoint | null;
			const connector = checkpoint?.pendingLogin?.connector;
			return connector?.kind === kind && connector.id === catalogId;
		})
		.map((row) => row.id);
}

/**
 * "Entrar" no card do Cofre: marca no checkpoint que o runtime deve usar o login
 * do cofre ao retomar. Só vale se o login pendente tem oferta do cofre.
 */
export async function markPendingLoginUseVault(runId: string): Promise<boolean> {
	const row = await prisma.agentRun.findUnique({ where: { id: runId }, select: { checkpointJson: true } });
	const checkpoint = row?.checkpointJson as AgentRunCheckpoint | null | undefined;
	if (!checkpoint?.pendingLogin?.vault) return false;
	const next = { ...checkpoint, pendingLogin: { ...checkpoint.pendingLogin, useVault: true } };
	await prisma.agentRun.update({ where: { id: runId }, data: { checkpointJson: next as unknown as Prisma.InputJsonValue } });
	return true;
}

/** Código recebido por e-mail/SMS digitado no card: guardado SELADO no checkpoint até o runtime digitar na página. */
export async function markPendingLoginCode(runId: string, codeEnc: string): Promise<boolean> {
	const row = await prisma.agentRun.findUnique({ where: { id: runId }, select: { checkpointJson: true } });
	const checkpoint = row?.checkpointJson as AgentRunCheckpoint | null | undefined;
	if (!checkpoint?.pendingLogin?.codeField) return false;
	const next = { ...checkpoint, pendingLogin: { ...checkpoint.pendingLogin, codeEnc } };
	await prisma.agentRun.update({ where: { id: runId }, data: { checkpointJson: next as unknown as Prisma.InputJsonValue } });
	return true;
}

export async function listActiveRunsForConversation(
	conversationId: string,
): Promise<AgentRun[]> {
	return listRunsForConversation(conversationId, { activeOnly: true });
}

export async function listRunsForConversation(
	conversationId: string,
	options?: {
		activeOnly?: boolean;
		take?: number;
		/** Ex.: chat UI omite origin=routine. */
		excludeOrigins?: string[];
	},
): Promise<AgentRun[]> {
	const rows = await prisma.agentRun.findMany({
		where: {
			conversationId,
			...(options?.activeOnly ? { status: { in: ACTIVE_STATUSES } } : {}),
			...(options?.excludeOrigins?.length
				? { origin: { notIn: options.excludeOrigins } }
				: {}),
		},
		orderBy: { createdAt: "desc" },
		take: options?.take ?? 20,
	});
	return rows.map(mapRun);
}

/** Último run terminado com texto (para recuperar resposta após F5). */
export async function getLatestCompletedRunForConversation(
	conversationId: string,
): Promise<AgentRun | null> {
	const row = await prisma.agentRun.findFirst({
		where: {
			conversationId,
			status: { in: ["completed", "failed", "budget_exhausted"] },
			resultText: { not: null },
		},
		orderBy: { finishedAt: "desc" },
	});
	return row ? mapRun(row) : null;
}

export async function requestCancelAgentRun(runId: string): Promise<AgentRun | null> {
	const existing = await prisma.agentRun.findUnique({ where: { id: runId } });
	if (!existing) return null;

	if (!ACTIVE_STATUSES.includes(asStatus(existing.status))) {
		return mapRun(existing);
	}

	// `queued` ainda não tem worker. `paused`/`waiting_*` sem lease vigente
	// (ex.: run parado num card de conexão de app) também não: nenhum worker
	// vai ver o `cancelRequested`, então finaliza aqui em vez de deixar o run
	// "ativo" para sempre (botão Parar sem efeito).
	const leaseUntil = existing.leaseUntil instanceof Date ? existing.leaseUntil : null;
	const parked =
		(existing.status === "paused" ||
			existing.status === "waiting_user" ||
			existing.status === "waiting_external") &&
		(!leaseUntil || leaseUntil.getTime() <= Date.now());
	const finalizeNow = existing.status === "queued" || parked;
	const row = await prisma.agentRun.update({
		where: { id: runId },
		data: {
			cancelRequested: true,
			status: finalizeNow ? "cancelled" : existing.status,
			finishedAt: finalizeNow ? new Date() : existing.finishedAt,
			...(parked ? { leaseOwner: null, leaseUntil: null, leaseToken: null } : {}),
		},
	});
	// Cancelar o pai cancela os filhos (subagentes) ainda ativos.
	await prisma.agentRun.updateMany({
		where: { parentRunId: runId, status: { in: ACTIVE_STATUSES } },
		data: { cancelRequested: true },
	});
	return mapRun(row);
}

/** Solicita uma pausa cooperativa. O worker solta o lease no próximo ponto seguro.
 * Só pausa `queued`/`running`. Run em `retrying` (sem lease, com job atrasado
 * no BullMQ) NÃO pausa: a próxima tentativa não adquiriria o lease de um run
 * `paused` e o run ficaria órfão (sem lease e sem job). Nesse caso devolve o
 * run como está (status != paused) e a API responde 409; o usuário aguarda a
 * tentativa ou cancela. Atômico: o filtro de status vai na própria escrita. */
export async function requestPauseAgentRun(runId: string): Promise<AgentRun | null> {
	await prisma.agentRun.updateMany({
		where: { id: runId, status: { in: ["queued", "running"] } },
		data: { status: "paused" },
	});
	const row = await prisma.agentRun.findUnique({ where: { id: runId } });
	return row ? mapRun(row) : null;
}

/** Recoloca o mesmo run na fila após o worker que o pausou soltar o lease.
 * Se o worker morreu segurando o lease (lease vencida), o resume recolhe o
 * lease obsoleto na mesma operação — sem isso, o run ficava `paused` para
 * sempre com 409 "ainda está parando". */
export async function requestResumeAgentRun(runId: string): Promise<AgentRun | null> {
	const now = new Date();
	const result = await prisma.agentRun.updateMany({
		where: {
			id: runId,
			status: "paused",
			cancelRequested: false,
			OR: [
				{ leaseOwner: null },
				{ leaseUntil: null },
				{ leaseUntil: { lt: now } },
			],
		},
		data: {
			status: "queued",
			error: null,
			jobEnqueuedAt: null,
			leaseOwner: null,
			leaseUntil: null,
			leaseToken: null,
		},
	});
	if (result.count !== 1) return null;
	return getAgentRun(runId);
}

/** Deve ser maior que o heartbeat e compatível com o backoff do BullMQ. */
export const LEASE_MS = 45_000;

export type RunLease = {
	token: string;
	generation: number;
	owner: string;
};

/**
 * Posse vigente do lease: dono, token E validade. Toda escrita fenceada usa
 * este filtro; conferir só dono/token deixaria um lease já vencido (que o
 * reconciliador pode estar recuperando) continuar escrevendo.
 */
export function ownedLeaseWhere(
	lease: Pick<RunLease, "owner" | "token">,
	now: Date = new Date(),
) {
	return {
		leaseOwner: lease.owner,
		leaseToken: lease.token,
		leaseUntil: { gt: now },
	};
}

/**
 * `owner` identifica UMA tentativa de execução (worker + job + tentativa), não
 * o processo: uma reentrega duplicada no mesmo processo chega com outro owner
 * e, com o lease vigente, não assume o run (não há re-aquisição pelo mesmo dono).
 */
export async function tryAcquireRunLease(
	runId: string,
	owner: string,
): Promise<RunLease | null> {
	const now = new Date();
	const leaseUntil = new Date(now.getTime() + LEASE_MS);
	const token = randomUUID();

	const existing = await prisma.agentRun.findUnique({
		where: { id: runId },
		select: {
			status: true,
			cancelRequested: true,
			leaseOwner: true,
			leaseUntil: true,
			leaseGeneration: true,
			startedAt: true,
		},
	});
	if (!existing || existing.cancelRequested) return null;
	if (
		existing.status !== "queued" &&
		existing.status !== "running" &&
		existing.status !== "retrying"
	) {
		return null;
	}

	const result = await prisma.agentRun.updateMany({
		where: {
			id: runId,
			cancelRequested: false,
			status: { in: ["queued", "running", "retrying"] },
			OR: [
				{ leaseOwner: null },
				{ leaseUntil: null },
				{ leaseUntil: { lt: now } },
			],
		},
		data: {
			leaseOwner: owner,
			leaseUntil,
			leaseToken: token,
			leaseGeneration: { increment: 1 },
			status: "running",
			...(existing.startedAt ? {} : { startedAt: now }),
		},
	});

	if (result.count !== 1) return null;

	const updated = await prisma.agentRun.findUnique({
		where: { id: runId },
		select: { leaseGeneration: true },
	});
	return {
		token,
		generation: updated?.leaseGeneration ?? existing.leaseGeneration + 1,
		owner,
	};
}

export async function renewRunLease(
	runId: string,
	owner: string,
	token: string,
): Promise<boolean> {
	const now = new Date();
	const leaseUntil = new Date(now.getTime() + LEASE_MS);
	// Só renova lease vigente: um vencido pode já estar sendo recuperado.
	const result = await prisma.agentRun.updateMany({
		where: {
			id: runId,
			...ownedLeaseWhere({ owner, token }, now),
			cancelRequested: false,
		},
		data: { leaseUntil },
	});
	return result.count === 1;
}

export async function releaseRunLease(
	runId: string,
	owner: string,
	token: string,
): Promise<void> {
	await prisma.agentRun.updateMany({
		where: { id: runId, leaseOwner: owner, leaseToken: token },
		data: { leaseOwner: null, leaseUntil: null, leaseToken: null },
	});
}

export async function assertRunLease(
	runId: string,
	owner: string,
	token: string,
): Promise<void> {
	const row = await prisma.agentRun.findUnique({
		where: { id: runId },
		select: {
			leaseOwner: true,
			leaseToken: true,
			leaseUntil: true,
			cancelRequested: true,
		},
	});
	if (
		!row ||
		row.leaseOwner !== owner ||
		row.leaseToken !== token ||
		!row.leaseUntil ||
		row.leaseUntil.getTime() <= Date.now()
	) {
		throw new Error("lease_lost");
	}
	if (row.cancelRequested) {
		throw new Error("cancelled");
	}
}

export async function isRunCancelRequested(runId: string): Promise<boolean> {
	const row = await prisma.agentRun.findUnique({
		where: { id: runId },
		select: { cancelRequested: true, status: true },
	});
	if (!row) return true;
	return row.cancelRequested || row.status === "cancelled";
}

export async function isRunPauseRequested(runId: string): Promise<boolean> {
	const row = await prisma.agentRun.findUnique({
		where: { id: runId },
		select: { status: true },
	});
	return row?.status === "paused";
}

/**
 * Cancelamento e pausa numa leitura só (o loop consulta os dois várias vezes
 * por decisão). Run inexistente conta como cancelado, como em `isRunCancelRequested`.
 */
export async function getRunControlState(
	runId: string,
): Promise<{ cancelRequested: boolean; pauseRequested: boolean }> {
	const row = await prisma.agentRun.findUnique({
		where: { id: runId },
		select: { cancelRequested: true, status: true },
	});
	if (!row) return { cancelRequested: true, pauseRequested: false };
	return {
		cancelRequested: row.cancelRequested || row.status === "cancelled",
		pauseRequested: row.status === "paused",
	};
}

/** Mantém o run pausado e libera o lease sem finalizar sua execução. */
export async function releasePausedRunLease(
	runId: string,
	lease: RunLease,
): Promise<void> {
	const result = await prisma.agentRun.updateMany({
		where: {
			id: runId,
			status: "paused",
			...ownedLeaseWhere(lease),
		},
		data: { leaseOwner: null, leaseUntil: null, leaseToken: null },
	});
	if (result.count !== 1) throw new Error("lease_lost");
}

export async function finishAgentRun(
	runId: string,
	input: {
		status: AgentRunStatus;
		resultText?: string;
		error?: string;
		sandboxSessionId?: string | null;
		lease?: RunLease | null;
		/** Uso (tokens e `computer`) quando o run termina por parada, sem passar por `completeAgentRun`. */
		usage?: RunUsage;
	},
): Promise<AgentRun> {
	const data = {
		status: input.status,
		usageJson:
			input.usage === undefined ? undefined : (input.usage as unknown as Prisma.InputJsonValue),
		resultText: input.resultText ?? undefined,
		error: input.error ?? undefined,
		sandboxSessionId:
			input.sandboxSessionId === undefined
				? undefined
				: input.sandboxSessionId,
		finishedAt: new Date(),
		leaseOwner: null,
		leaseUntil: null,
		leaseToken: null,
	};

	if (input.lease) {
		const result = await prisma.agentRun.updateMany({
			where: {
				id: runId,
				...ownedLeaseWhere(input.lease),
			},
			data,
		});
		if (result.count !== 1) {
			throw new Error("lease_lost");
		}
		const row = await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } });
		await persistFinishTranscript(row.conversationId, row.origin, input, runId);
		await settleRoutineRunForAgentRun(runId, {
			status: input.status,
			resultText: input.resultText,
			error: input.error,
		});
		return mapRun(row);
	}

	const row = await prisma.agentRun.update({
		where: { id: runId },
		data,
	});
	await persistFinishTranscript(row.conversationId, row.origin, input, runId);
	await settleRoutineRunForAgentRun(runId, {
		status: input.status,
		resultText: input.resultText,
		error: input.error,
	});
	return mapRun(row);
}

/**
 * A resposta final do run não entra na conversa do LLM durante o laço. Ao fechar o run ela é anexada ao
 * checkpoint, para o turno seguinte partir da conversa completa (a mensagem gravada tem o `runId` do run e
 * não é lida de novo). Devolve `null` quando não há o que anexar.
 */
export function withFinalReply(checkpoint: unknown, text: string): Record<string, unknown> | null {
	const reply = text.trim();
	if (!reply || !checkpoint || typeof checkpoint !== "object" || Array.isArray(checkpoint)) return null;
	const llmMessages = (checkpoint as { llmMessages?: unknown }).llmMessages;
	if (!Array.isArray(llmMessages) || llmMessages.length === 0) return null;
	const last = llmMessages[llmMessages.length - 1] as { role?: unknown; content?: unknown; tool_calls?: unknown } | undefined;
	if (last?.role === "assistant" && !last.tool_calls && last.content === reply) return null;
	return { ...(checkpoint as Record<string, unknown>), llmMessages: [...llmMessages, { role: "assistant", content: reply }] };
}

async function persistFinishTranscript(
	conversationId: string | null,
	origin: string,
	input: { status: AgentRunStatus; resultText?: string },
	runId: string,
): Promise<void> {
	const text = input.resultText?.trim();
	if (!conversationId || !text) return;
	if (input.status !== "failed" && input.status !== "budget_exhausted") return;
	const tag = await botMessageTag(runId, origin, conversationId);
	await withMessageRunId(runId, () => appendConversationMessage(conversationId, "assistant", text, tag.origin, tag.bot));
	const row = await prisma.agentRun.findUnique({ where: { id: runId }, select: { checkpointJson: true } });
	const next = withFinalReply(row?.checkpointJson, text);
	if (next) await prisma.agentRun.update({ where: { id: runId }, data: { checkpointJson: next as unknown as Prisma.InputJsonValue } });
}

/**
 * Saída de run de bot: só a do run que ATENDE uma mensagem de outro bot entra
 * na thread (origin "bot"); a do run que acorda o remetente é fala normal dele.
 */
async function botMessageTag(
	runId: string,
	origin: string | undefined,
	conversationId?: string | null,
): Promise<{ origin?: string; bot?: { botMessageId?: string; fromBotId?: string; fromBotName?: string } }> {
	if (origin === "bot") {
		const served = await prisma.botMessage.findFirst({ where: { toRunId: runId }, select: { id: true } });
		return served ? { origin: "bot", bot: { botMessageId: served.id } } : {};
	}
	if (isPersistedMessageOrigin(origin)) return { origin };
	// Fala de um membro na conversa de um grupo: grava o autor (avatar e nome no balão).
	if (conversationId) {
		const run = await prisma.agentRun.findUnique({ where: { id: runId }, select: { botId: true } });
		const author = await getGroupAuthor(conversationId, run?.botId);
		if (author) return { bot: { fromBotId: author.id, fromBotName: author.name } };
	}
	return {};
}

/**
 * Finaliza um run cujo job esgotou as tentativas do BullMQ. A condição evita
 * sobrescrever um cancelamento ou uma pausa que tenha ocorrido em paralelo.
 */
export async function failAgentRunAfterRetries(
	runId: string,
	error: string,
	/** `resultText`: mensagem amigável ao usuário (vai ao chat e ao evento de erro); `error` fica técnico. */
	display?: { resultText?: string },
): Promise<boolean> {
	return prisma.$transaction(
		async (tx) => {
			const updated = await tx.agentRun.updateMany({
				where: {
					id: runId,
					cancelRequested: false,
					status: { in: ["queued", "running", "retrying"] },
				},
				data: {
					status: "failed",
					error,
					...(display?.resultText ? { resultText: display.resultText } : {}),
					finishedAt: new Date(),
					leaseOwner: null,
					leaseUntil: null,
					leaseToken: null,
				},
			});
			if (updated.count !== 1) return false;

			await lockRunEventSeq(tx, runId);
			await insertRunEventRow(tx, runId, "error", {
				type: "error",
				error: display?.resultText ?? error,
			});
			return true;
		},
		{ isolationLevel: "ReadCommitted" },
	).then(async (finalized) => {
		if (finalized) {
			await settleRoutineRunForAgentRun(runId, { status: "failed", error });
			if (display?.resultText) {
				const row = await prisma.agentRun.findUnique({ where: { id: runId }, select: { conversationId: true, origin: true } });
				if (row) await persistFinishTranscript(row.conversationId, row.origin, { status: "failed", resultText: display.resultText }, runId);
			}
		}
		return finalized;
	});
}

export async function saveAgentRunCheckpoint(
	runId: string,
	checkpoint: AgentRunCheckpoint,
	sandboxSessionId?: string | null,
	lease?: RunLease | null,
): Promise<void> {
	const data = {
		checkpointJson: checkpoint as unknown as Prisma.InputJsonValue,
		...(sandboxSessionId !== undefined ? { sandboxSessionId } : {}),
	};
	if (lease) {
		// Fence e escrita no mesmo UPDATE (sem janela entre assert e mutação).
		const owned = await prisma.agentRun.updateMany({
			where: { id: runId, ...ownedLeaseWhere(lease) },
			data,
		});
		if (owned.count !== 1) throw new Error("lease_lost");
		return;
	}
	await prisma.agentRun.update({ where: { id: runId }, data });
}

/**
 * Registra a sessão do sandbox no run SEM reescrever o resto do checkpoint
 * (orçamento, tetos, login pendente, llmMessages...): o UPDATE de posse trava a
 * linha, então ler o checkpoint atual e gravá-lo com a sessão nova não corre
 * contra outro escritor. Coluna e campo do checkpoint ficam coerentes.
 */
export async function setRunSandboxSession(
	runId: string,
	sandboxSessionId: string,
	lease: RunLease,
): Promise<void> {
	await prisma.$transaction(async (tx) => {
		const owned = await tx.agentRun.updateMany({
			where: { id: runId, ...ownedLeaseWhere(lease) },
			data: { sandboxSessionId },
		});
		if (owned.count !== 1) throw new Error("lease_lost");
		const row = await tx.agentRun.findUnique({
			where: { id: runId },
			select: { checkpointJson: true },
		});
		const current = row?.checkpointJson;
		if (!current || typeof current !== "object" || Array.isArray(current)) return;
		await tx.agentRun.update({
			where: { id: runId },
			data: {
				checkpointJson: { ...current, sandboxSessionId } as Prisma.InputJsonValue,
			},
		});
	});
}

export async function persistRunProgress(input: {
	runId: string;
	checkpoint: AgentRunCheckpoint;
	sandboxSessionId?: string | null;
	consumedInputIds?: string[];
	lease?: RunLease | null;
}): Promise<void> {
	await prisma.$transaction(async (tx) => {
		if (input.lease) {
			const owned = await tx.agentRun.updateMany({
				where: {
					id: input.runId,
					...ownedLeaseWhere(input.lease),
				},
				data: {
					checkpointJson: input.checkpoint as unknown as Prisma.InputJsonValue,
					...(input.sandboxSessionId !== undefined
						? { sandboxSessionId: input.sandboxSessionId }
						: {}),
				},
			});
			if (owned.count !== 1) {
				throw new Error("lease_lost");
			}
		} else {
			await tx.agentRun.update({
				where: { id: input.runId },
				data: {
					checkpointJson: input.checkpoint as unknown as Prisma.InputJsonValue,
					...(input.sandboxSessionId !== undefined
						? { sandboxSessionId: input.sandboxSessionId }
						: {}),
				},
			});
		}

		if (input.consumedInputIds && input.consumedInputIds.length > 0) {
			await tx.runInput.updateMany({
				where: {
					runId: input.runId,
					id: { in: input.consumedInputIds },
					status: "pending",
				},
				data: { status: "consumed", consumedAt: new Date() },
			});
		}
	});
}

async function lockRunEventSeq(
	tx: Prisma.TransactionClient,
	runId: string,
): Promise<void> {
	// Namespace 87: serializa seq de RunEvent entre API, worker e finalização.
	await tx.$executeRaw`SELECT pg_advisory_xact_lock(87, hashtext(${runId}))`;
}

async function insertRunEventRow(
	tx: Prisma.TransactionClient,
	runId: string,
	type: string,
	payload: ComputerUseEvent | Record<string, unknown>,
) {
	const id = randomUUID();
	const payloadJson = JSON.stringify(payload);
	const rows = await tx.$queryRaw<
		Array<{
			id: string;
			runId: string;
			seq: number;
			type: string;
			payload: unknown;
			createdAt: Date;
		}>
	>`
		INSERT INTO run_events (id, "runId", seq, type, payload, "createdAt")
		VALUES (
			${id},
			${runId},
			COALESCE((SELECT MAX(seq) FROM run_events WHERE "runId" = ${runId}), 0) + 1,
			${type},
			${payloadJson}::jsonb,
			NOW()
		)
		RETURNING id, "runId", seq, type, payload, "createdAt"
	`;
	const row = rows[0];
	if (!row) {
		throw new Error("failed to insert run event");
	}
	return row;
}

/**
 * Gancho "o run ganhou evento": o worker liga isso ao Redis (@workspace/queue) para acordar os
 * streams SSE da API sem consultar o banco a cada 80ms. Melhor esforço; erro do gancho é ignorado.
 */
let runEventAppendedHook: ((runId: string) => void) | null = null;
export function setRunEventAppendedHook(hook: ((runId: string) => void) | null): void {
	runEventAppendedHook = hook;
}
function signalRunEventAppended(runId: string): void {
	try {
		runEventAppendedHook?.(runId);
	} catch {
		// gancho com defeito não afeta a gravação
	}
}

export async function appendRunEvent(
	runId: string,
	type: string,
	payload: ComputerUseEvent | Record<string, unknown>,
): Promise<RunEventRecord> {
	const maxAttempts = 12;
	let lastError: unknown;

	for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
		try {
			const row = await prisma.$transaction(
				async (tx) => {
					await lockRunEventSeq(tx, runId);
					return insertRunEventRow(tx, runId, type, payload);
				},
				{ isolationLevel: "ReadCommitted" },
			);
			signalRunEventAppended(runId);

			return {
				id: row.id,
				runId: row.runId,
				seq: row.seq,
				type: row.type,
				payload: row.payload as ComputerUseEvent | Record<string, unknown>,
				createdAt: row.createdAt.toISOString(),
			};
		} catch (error) {
			lastError = error;
			const code =
				error && typeof error === "object" && "code" in error
					? String((error as { code?: unknown }).code)
					: "";
			if (code === "P2002" || code === "P2034") {
				continue;
			}
			throw error;
		}
	}

	throw lastError instanceof Error
		? lastError
		: new Error("failed to append run event after retries");
}

export async function listRunEventsAfter(
	runId: string,
	afterSeq = 0,
	limit = 200,
): Promise<RunEventRecord[]> {
	const rows = await prisma.runEvent.findMany({
		where: { runId, seq: { gt: afterSeq } },
		orderBy: { seq: "asc" },
		take: limit,
	});

	return rows.map((row) => ({
		id: row.id,
		runId: row.runId,
		seq: row.seq,
		type: row.type,
		payload: row.payload as ComputerUseEvent | Record<string, unknown>,
		createdAt: row.createdAt.toISOString(),
	}));
}

/**
 * Reescrever a mesma chave com outro `type` (tool → tool_result) é a evolução
 * normal do passo, não uma nova tentativa. Só repetir o mesmo tipo (replay
 * após crash/retry do job) conta como tentativa.
 */
export function isRealStepRetry(
	existing: { type: string } | null | undefined,
	next: { type: string },
): boolean {
	return !!existing && existing.type === next.type;
}

type AgentStepInput = {
	runId: string;
	index?: number;
	decisionIndex: number;
	subIndex: number;
	type: AgentStepType;
	status?: AgentStepStatus;
	inputJson?: unknown;
	outputJson?: unknown;
	idempotencyKey?: string;
	durationMs?: number;
	/** Tokens (prompt+completion) da decisão do modelo, quando medidos. */
	tokens?: number;
	/** Custo real do passo (OpenRouter); ausente quando desconhecido. */
	costUsd?: number;
	lease?: RunLease | null;
};

/** Violação de unicidade (Postgres 23505), com ou sem o envelope do Prisma. */
function isUniqueViolation(error: unknown): boolean {
	const code = (error as { code?: string })?.code ?? "";
	const metaCode = (error as { meta?: { code?: string } })?.meta?.code ?? "";
	const message = error instanceof Error ? error.message : "";
	return /P2002|23505|duplicate key|Unique constraint/i.test(`${code} ${metaCode} ${message}`);
}

export async function appendAgentStep(input: AgentStepInput): Promise<void> {
	const { lease } = input;
	if (!lease) {
		try {
			return await upsertAgentStep(prisma, input);
		} catch (error) {
			if (!isUniqueViolation(error)) throw error;
			return writeAgentStepByLookup(prisma, input);
		}
	}
	// Fence e escrita na mesma transação: o UPDATE de posse trava a linha do
	// run até o COMMIT, então o reconciliador não recupera o run (nem outro
	// executor assume) entre conferir o lease e gravar o passo. O passo é
	// idempotente por (runId, decisionIndex+subIndex).
	const fenced = (write: (tx: Prisma.TransactionClient) => Promise<void>) =>
		prisma.$transaction(async (tx) => {
			// Lease e cancelamento conferidos no mesmo UPDATE (1 ida em vez de 2).
			const owned = await tx.agentRun.updateMany({
				where: { id: input.runId, ...ownedLeaseWhere(lease), cancelRequested: false },
				data: { updatedAt: new Date() },
			});
			if (owned.count !== 1) {
				// Só no caminho de falha: lease perdido vence; com lease vigente, é o cancelamento.
				const stillOwned = await tx.agentRun.findFirst({
					where: { id: input.runId, ...ownedLeaseWhere(lease) },
					select: { id: true },
				});
				throw new Error(stillOwned ? "cancelled" : "lease_lost");
			}
			await write(tx);
		});
	try {
		await fenced((tx) => upsertAgentStep(tx, input));
	} catch (error) {
		// Chave de idempotência já usada em OUTRA posição: o upsert por posição não
		// resolve; o caminho por busca atualiza a linha dona da chave.
		if (!isUniqueViolation(error)) throw error;
		await fenced((tx) => writeAgentStepByLookup(tx, input));
	}
}

/**
 * Um INSERT ... ON CONFLICT por passo (sem find + update). `attempts` só sobe
 * quando o `type` repete (retry real; tool → tool_result não conta, ver
 * `isRealStepRetry`). Campo ausente não apaga o que já foi gravado.
 */
async function upsertAgentStep(
	db: Pick<Prisma.TransactionClient, "$executeRaw">,
	input: AgentStepInput,
): Promise<void> {
	const index = input.index ?? input.decisionIndex * 100 + input.subIndex;
	const json = (value: unknown) => (value === undefined ? null : JSON.stringify(value));
	const duration = input.durationMs === undefined ? null : Math.max(0, Math.round(input.durationMs));
	await db.$executeRaw`
		INSERT INTO "agent_steps"
			("id", "runId", "index", "decisionIndex", "subIndex", "type", "status",
			 "inputJson", "outputJson", "idempotencyKey", "durationMs", "tokens", "costUsd")
		VALUES
			(${randomUUID()}, ${input.runId}, ${index}, ${input.decisionIndex}, ${input.subIndex},
			 ${input.type}, ${input.status ?? "completed"},
			 ${json(input.inputJson)}::jsonb, ${json(input.outputJson)}::jsonb,
			 ${input.idempotencyKey ?? null}::text, ${duration}::integer,
			 ${input.tokens ?? null}::integer, ${input.costUsd ?? null}::double precision)
		ON CONFLICT ("runId", "decisionIndex", "subIndex") DO UPDATE SET
			"index" = EXCLUDED."index",
			"type" = EXCLUDED."type",
			"status" = EXCLUDED."status",
			"inputJson" = COALESCE(EXCLUDED."inputJson", "agent_steps"."inputJson"),
			"outputJson" = COALESCE(EXCLUDED."outputJson", "agent_steps"."outputJson"),
			"idempotencyKey" = COALESCE(EXCLUDED."idempotencyKey", "agent_steps"."idempotencyKey"),
			"durationMs" = COALESCE(EXCLUDED."durationMs", "agent_steps"."durationMs"),
			"tokens" = COALESCE(EXCLUDED."tokens", "agent_steps"."tokens"),
			"costUsd" = COALESCE(EXCLUDED."costUsd", "agent_steps"."costUsd"),
			"attempts" = CASE WHEN "agent_steps"."type" = EXCLUDED."type"
				THEN "agent_steps"."attempts" + 1 ELSE "agent_steps"."attempts" END`;
}

async function writeAgentStepByLookup(
	db: Pick<Prisma.TransactionClient, "agentStep">,
	input: AgentStepInput,
): Promise<void> {
	const index = input.index ?? input.decisionIndex * 100 + input.subIndex;
	const payload = {
		index,
		type: input.type,
		status: input.status ?? "completed",
		inputJson:
			input.inputJson === undefined
				? undefined
				: (input.inputJson as Prisma.InputJsonValue),
		outputJson:
			input.outputJson === undefined
				? undefined
				: (input.outputJson as Prisma.InputJsonValue),
		idempotencyKey: input.idempotencyKey,
		durationMs:
			input.durationMs === undefined ? undefined : Math.max(0, Math.round(input.durationMs)),
		tokens: input.tokens,
		costUsd: input.costUsd,
	};

	const existing = input.idempotencyKey
		? await db.agentStep.findFirst({
				where: {
					runId: input.runId,
					idempotencyKey: input.idempotencyKey,
				},
			})
		: await db.agentStep.findUnique({
				where: {
					runId_decisionIndex_subIndex: {
						runId: input.runId,
						decisionIndex: input.decisionIndex,
						subIndex: input.subIndex,
					},
				},
			});
	if (existing) {
		await db.agentStep.update({
			where: { id: existing.id },
			data: {
				...payload,
				...(isRealStepRetry(existing, input) ? { attempts: { increment: 1 } } : {}),
			},
		});
		return;
	}

	await db.agentStep.upsert({
		where: {
			runId_decisionIndex_subIndex: {
				runId: input.runId,
				decisionIndex: input.decisionIndex,
				subIndex: input.subIndex,
			},
		},
		create: {
			runId: input.runId,
			decisionIndex: input.decisionIndex,
			subIndex: input.subIndex,
			...payload,
		},
		// Corrida entre dois escritores: o outro já criou, então este é retry.
		update: {
			...payload,
			attempts: { increment: 1 },
		},
	});
}

export type FileEventRecord = Extract<ComputerUseEvent, { type: "file" }>;

export type CompletedToolStep = {
	summary: string;
	ok: boolean;
	imageArtifactId?: string;
	/** Status estruturado gravado na execução (L20); ausente em passo antigo. */
	status?: ToolResultStatus;
	/** Card de arquivo da execução: no replay é reentregue sem recriar o arquivo. */
	file?: FileEventRecord;
};

function parseStoredFileEvent(raw: unknown): FileEventRecord | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const file = raw as Record<string, unknown>;
	if (
		file.type !== "file" ||
		typeof file.artifactId !== "string" ||
		typeof file.filename !== "string" ||
		typeof file.mime !== "string" ||
		typeof file.size !== "number" ||
		typeof file.version !== "number" ||
		typeof file.format !== "string"
	) {
		return undefined;
	}
	return file as unknown as FileEventRecord;
}

/**
 * Resultado já gravado de uma chamada de tool (replay). Vale para passo
 * concluído e, para escrita, também para o falho de efeito INCERTO: repetir
 * a escrita duplicaria o efeito, então o resultado incerto é reaproveitado.
 */
export async function findCompletedToolStep(
	runId: string,
	idempotencyKey: string,
): Promise<CompletedToolStep | null> {
	const row = await prisma.agentStep.findFirst({
		where: {
			runId,
			idempotencyKey,
			status: { in: ["completed", "skipped", "failed"] },
		},
	});
	if (!row?.outputJson || typeof row.outputJson !== "object") return null;
	const output = row.outputJson as {
		summary?: unknown;
		ok?: unknown;
		imageArtifactId?: unknown;
		status?: unknown;
		file?: unknown;
	};
	if (typeof output.summary !== "string") return null;
	const status = parseToolResultStatus(output.status) ?? undefined;
	// Falha comum (efeito conhecido: nenhum) continua sendo reexecutada.
	if (row.status === "failed" && status?.effect !== "uncertain") return null;
	const file = parseStoredFileEvent(output.file);
	return {
		summary: output.summary,
		ok: output.ok !== false,
		imageArtifactId:
			typeof output.imageArtifactId === "string"
				? output.imageArtifactId
				: undefined,
		...(status ? { status } : {}),
		...(file ? { file } : {}),
	};
}

/**
 * Intenção de escrita sem resultado (W9): a tool começou (`running` com
 * `attemptId` gravado antes da chamada) e o run caiu antes de registrar o
 * resultado. O efeito externo é DESCONHECIDO: quem retoma não repete.
 */
export async function findStartedToolStep(
	runId: string,
	idempotencyKey: string,
): Promise<{ attemptId: string; tool: string } | null> {
	const row = await prisma.agentStep.findFirst({
		where: { runId, idempotencyKey, status: "running" },
	});
	if (!row?.inputJson || typeof row.inputJson !== "object" || Array.isArray(row.inputJson)) return null;
	const input = row.inputJson as { attemptId?: unknown; name?: unknown };
	if (typeof input.attemptId !== "string") return null;
	return { attemptId: input.attemptId, tool: typeof input.name === "string" ? input.name : "tool" };
}

function mapRunInput(row: {
	id: string;
	runId: string;
	seq: number;
	author: string;
	content: string;
	attachmentsJson?: Prisma.JsonValue | null;
	mode: string;
	status: string;
	clientKey?: string | null;
	createdAt: Date;
	consumedAt: Date | null;
}): RunInputRecord {
	return {
		id: row.id,
		runId: row.runId,
		seq: row.seq,
		author: row.author,
		content: row.content,
		...(Array.isArray(row.attachmentsJson) ? { attachments: row.attachmentsJson.filter((item): item is { artifactId: string } => !!item && typeof item === "object" && !Array.isArray(item) && typeof item.artifactId === "string").slice(0, 4) } : {}),
		// Linha antiga pode ter `steer`: o runtime o lê como join sem classificar (nada em voo quebra).
		mode: row.mode as RunInputMode,
		status: row.status as RunInputStatus,
		clientKey: row.clientKey ?? null,
		createdAt: row.createdAt.toISOString(),
		consumedAt: row.consumedAt ? row.consumedAt.toISOString() : null,
	};
}

export async function createRunInput(
	runId: string,
	request: CreateRunInputRequest,
	userId?: string,
): Promise<RunInputRecord> {
	const run = userId !== undefined
		? await prisma.agentRun.findFirst({ where: { id: runId, userId: { in: userId.trim() && userId !== "default" ? [userId] : [] } } })
		: await prisma.agentRun.findUnique({ where: { id: runId } });
	if (!run) throw new ResourceOwnershipError();
	// F4 — steer/queue numa conversa apagada: cria o input, sem a mensagem.
	const conversationOk = run.conversationId
		? userId !== undefined
			? !!await getOwnedConversation(run.conversationId, userId)
			: await conversationAlive(run.conversationId)
		: false;
	// `steer` legado e modo ausente/desconhecido viram `join` (nota, sem revisão de objetivo).
	const mode = normalizeRunInputMode(request.mode);
	const content = request.content.trim();
	if (!content && !request.attachments?.length) throw new Error("content vazio");
	const imagesCard = await resolveUserImagesCard(request.attachments ?? [], run.userId);
	const fileCards = await resolveUserFileCards(request.attachments ?? [], run.userId);
	// Arquivo anexado no meio do run: o modelo recebe só a lista (lê com attachment_read); a conversa mostra o texto original.
	const imageAttachments = fileCards.length ? await imageAttachmentsOf(request.attachments ?? [], run.userId) : request.attachments ?? [];
	const inputContent = fileCards.length ? `${content}${content ? "\n\n" : ""}[The user attached ${fileCards.length === 1 ? "a file" : `${fileCards.length} files`}: ${fileCards.map((card) => `"${card.filename}" (attachment id ${card.artifactId}, ${card.size} bytes)`).join("; ")}. Read with attachment_read.]` : content;
	const clientKey =
		typeof request.clientKey === "string" && request.clientKey.trim().length > 0
			? request.clientKey.trim().slice(0, 128)
			: null;

	// Idempotência: mesmo clientKey retorna o input existente sem duplicar seq.
	// Casts `as never` toleram o client Prisma ainda não regenerado (rode db:generate).
	if (clientKey) {
		const existing = await prisma.runInput.findFirst({
			where: { runId, clientKey } as never,
		});
		if (existing) return mapRunInput(existing);
	}

	const row = await prisma.$transaction(async (tx) => {
		await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`run-input:${runId}`}))`;
		if (clientKey) {
			const raced = await tx.runInput.findFirst({
				where: { runId, clientKey } as never,
			});
			if (raced) return raced;
		}
		const last = await tx.runInput.findFirst({
			where: { runId },
			orderBy: { seq: "desc" },
			select: { seq: true },
		});
		const input = await tx.runInput.create({
			data: {
				runId,
				seq: (last?.seq ?? 0) + 1,
				author: request.author ?? "user",
				content: inputContent,
				mode,
				attachmentsJson: imageAttachments.length ? imageAttachments : undefined,
				status: "pending",
				clientKey,
			} as never,
		});
		if (conversationOk && run.conversationId && mode !== "cancel" && request.silent !== true) {
			await tx.conversationMessage.create({
				data: { conversationId: run.conversationId, role: "user", content },
			});
			if (imagesCard) await tx.conversationMessage.create({ data: { conversationId: run.conversationId, role: "images", content: JSON.stringify(imagesCard) } });
			for (const card of fileCards) await tx.conversationMessage.create({ data: { conversationId: run.conversationId, role: "file", content: JSON.stringify(card) } });
		}
		return input;
	});

	return mapRunInput(row);
}

export async function listRunInputs(
	runId: string,
	options?: { status?: RunInputStatus },
): Promise<RunInputRecord[]> {
	const rows = await prisma.runInput.findMany({
		where: {
			runId,
			...(options?.status ? { status: options.status } : {}),
		},
		orderBy: { seq: "asc" },
	});
	return rows.map(mapRunInput);
}

export async function listPendingSteerInputs(
	runId: string,
): Promise<RunInputRecord[]> {
	const rows = await prisma.runInput.findMany({
		// Inclui `steer` (linhas antigas e default da coluna) junto dos modos que entram no run.
		where: { runId, status: "pending", mode: { in: [...LIVE_RUN_INPUT_MODES] } },
		orderBy: { seq: "asc" },
	});
	return rows.map(mapRunInput);
}

/** Ids dos `interrupt` pendentes. O runtime consulta com frequência para abortar a chamada em voo. */
export async function listPendingInterruptInputIds(runId: string): Promise<string[]> {
	const rows = await prisma.runInput.findMany({
		where: { runId, status: "pending", mode: "interrupt" },
		select: { id: true },
		orderBy: { seq: "asc" },
	});
	return rows.map((row) => row.id);
}

export async function listPendingQueueInputs(
	runId: string,
): Promise<RunInputRecord[]> {
	const rows = await prisma.runInput.findMany({
		where: { runId, status: "pending", mode: "queue" },
		orderBy: { seq: "asc" },
	});
	return rows.map(mapRunInput);
}

/**
 * Runs já terminados (cancelado, falho, concluído) que ainda têm entrada do
 * usuário pendente que o runtime pode promover (join/steer/queue). O `cancel`
 * nunca entra: é a própria parada, não uma pergunta. Rede de segurança do fim
 * do run: o worker promove no término e este varredor pega o que sobrou
 * (worker morto, reconciliador que cancelou sem passar pelo processador).
 * `graceMs` evita disputar com o fim do run em andamento; a promoção é atômica.
 */
export async function listTerminalRunsWithPendingInputs(
	graceMs = 30_000,
	limit = 25,
): Promise<AgentRun[]> {
	const cutoff = new Date(Date.now() - graceMs);
	const pending = await prisma.runInput.findMany({
		where: {
			status: "pending",
			mode: { in: [...LIVE_RUN_INPUT_MODES, "queue"] },
			createdAt: { lt: cutoff },
		},
		orderBy: { createdAt: "asc" },
		take: limit * 4,
	});
	const runIds = [...new Set(pending.map((item) => item.runId))];
	if (runIds.length === 0) return [];
	const runs = await prisma.agentRun.findMany({
		where: {
			id: { in: runIds },
			status: { in: ["cancelled", "failed", "completed", "budget_exhausted"] },
			updatedAt: { lt: cutoff },
		},
		take: limit,
	});
	return runs.map(mapRun);
}

export async function markRunInputsConsumed(
	runId: string,
	ids: string[],
): Promise<void> {
	if (ids.length === 0) return;
	await prisma.runInput.updateMany({
		where: { runId, id: { in: ids }, status: "pending" },
		data: { status: "consumed", consumedAt: new Date() },
	});
}

export async function markRunJobEnqueued(runId: string): Promise<void> {
	await prisma.agentRun.update({
		where: { id: runId },
		data: { jobEnqueuedAt: new Date() },
	});
}

export async function listQueuedRunsMissingJob(limit = 20) {
	return prisma.agentRun.findMany({
		where: {
			status: "queued",
			jobEnqueuedAt: null,
			cancelRequested: false,
		},
		orderBy: { createdAt: "asc" },
		take: limit,
		select: { id: true, createdAt: true },
	});
}

/** Runs `queued` há tempo demais com flag de enqueue: o job pode ter se
 * perdido (ou virado artefato terminal retido). O reconciliador confere o
 * job real no BullMQ antes de agir. */
export async function listQueuedRunsWithStaleJob(
	limit = 20,
	stuckMs = 60_000,
) {
	return prisma.agentRun.findMany({
		where: {
			status: "queued",
			jobEnqueuedAt: { not: null },
			cancelRequested: false,
			updatedAt: { lt: new Date(Date.now() - stuckMs) },
		},
		orderBy: { updatedAt: "asc" },
		take: limit,
		select: { id: true, updatedAt: true },
	});
}

/**
 * Runs `running` com lease expirada: recoloca na fila em vez de falhar.
 * O worker antigo não deve finalizar o run; o reconciliador assume a recuperação.
 */
export async function recoverStaleRunningRuns(
	graceMs = 90_000,
	limit = 25,
): Promise<string[]> {
	const cutoff = new Date(Date.now() - graceMs);
	const stale = await prisma.agentRun.findMany({
		where: {
			status: "running",
			cancelRequested: false,
			// Filho (subagente) roda dentro do worker do pai, sem job próprio:
			// nunca é re-enfileirado (o varredor de fantasmas o falha).
			parentRunId: null,
			OR: [{ leaseUntil: null }, { leaseUntil: { lt: cutoff } }],
			updatedAt: { lt: cutoff },
		},
		orderBy: { updatedAt: "asc" },
		take: limit,
		select: { id: true, leaseToken: true },
	});
	const recovered: string[] = [];
	for (const row of stale) {
		// Reconfere no UPDATE o que a seleção viu: se o dono renovou ou outro
		// executor assumiu (token novo) entre o SELECT e aqui, não recupera.
		const changed = await prisma.agentRun.updateMany({
			where: {
				id: row.id,
				status: "running",
				cancelRequested: false,
				parentRunId: null,
				leaseToken: row.leaseToken,
				OR: [{ leaseUntil: null }, { leaseUntil: { lt: cutoff } }],
				updatedAt: { lt: cutoff },
			},
			data: {
				status: "queued",
				jobEnqueuedAt: null,
				leaseOwner: null,
				leaseUntil: null,
				leaseToken: null,
			},
		});
		if (changed.count !== 1) continue;
		recovered.push(row.id);
	}
	return recovered;
}

/**
 * Varredor de runs fantasmas: só falha depois de graça longa (recuperação
 * já tentou re-enfileirar). Worker morto de verdade, não troca de lease.
 */
export async function failStaleRunningRuns(
	graceMs = 900_000,
	limit = 25,
): Promise<string[]> {
	const cutoff = new Date(Date.now() - graceMs);
	const stale = await prisma.agentRun.findMany({
		where: {
			status: "running",
			cancelRequested: false,
			OR: [{ leaseUntil: null }, { leaseUntil: { lt: cutoff } }],
			updatedAt: { lt: cutoff },
		},
		orderBy: { updatedAt: "asc" },
		take: limit,
		select: { id: true, leaseToken: true },
	});
	const failed: string[] = [];
	for (const row of stale) {
		const changed = await prisma.agentRun.updateMany({
			where: {
				id: row.id,
				status: "running",
				cancelRequested: false,
				leaseToken: row.leaseToken,
				OR: [{ leaseUntil: null }, { leaseUntil: { lt: cutoff } }],
				updatedAt: { lt: cutoff },
			},
			data: {
				status: "failed",
				error:
					"O worker parou de responder no meio da execução (sem heartbeat). Tente de novo.",
				finishedAt: new Date(),
				leaseOwner: null,
				leaseUntil: null,
				leaseToken: null,
			},
		});
		if (changed.count !== 1) continue;
		await appendRunEvent(row.id, "error", {
			type: "error",
			error:
				"O worker parou de responder no meio da execução (sem heartbeat). Tente de novo.",
		}).catch((error) =>
			console.error("stale run event failed", row.id, error),
		);
		await settleRoutineRunForAgentRun(row.id, {
			status: "failed",
			error:
				"O worker parou de responder no meio da execução (sem heartbeat). Tente de novo.",
		});
		failed.push(row.id);
	}
	return failed;
}

/**
 * Finaliza cancelamentos que ficaram órfãos depois de o worker desaparecer.
 * Um run em execução mantém o estado até o worker observar o cancelamento;
 * após o lease vencer, porém, não existe mais ninguém que possa concluí-lo.
 */
export async function cancelStaleCancelledRuns(
	graceMs = 120_000,
	limit = 25,
): Promise<string[]> {
	const cutoff = new Date(Date.now() - graceMs);
	const stale = await prisma.agentRun.findMany({
		where: {
			cancelRequested: true,
			status: { in: ["running", "paused", "retrying", "waiting_user", "waiting_external"] },
			OR: [{ leaseUntil: null }, { leaseUntil: { lt: cutoff } }],
			updatedAt: { lt: cutoff },
		},
		orderBy: { updatedAt: "asc" },
		take: limit,
		select: { id: true, leaseToken: true },
	});
	const cancelled: string[] = [];
	for (const row of stale) {
		const changed = await prisma.agentRun.updateMany({
			where: {
				id: row.id,
				cancelRequested: true,
				status: { in: ["running", "paused", "retrying", "waiting_user", "waiting_external"] },
				leaseToken: row.leaseToken,
				OR: [{ leaseUntil: null }, { leaseUntil: { lt: cutoff } }],
				updatedAt: { lt: cutoff },
			},
			data: {
				status: "cancelled",
				finishedAt: new Date(),
				leaseOwner: null,
				leaseUntil: null,
				leaseToken: null,
			},
		});
		if (changed.count !== 1) continue;
		await appendRunEvent(row.id, "cancelled", {
			type: "cancelled",
			reason: "Cancelamento concluído após o worker parar de responder.",
		}).catch((error) =>
			console.error("stale cancellation event failed", row.id, error),
		);
		await settleRoutineRunForAgentRun(row.id, {
			status: "cancelled",
			error: "Cancelamento concluído após o worker parar de responder.",
		});
		cancelled.push(row.id);
	}
	return cancelled;
}

/** Rotina, lembrete ou evento que gerou o run (marcador das mensagens que ele produz). */
export async function resolveRunMessageSource(runId: string) {
	const run = await prisma.agentRun.findUnique({ where: { id: runId }, select: { origin: true, createdAt: true } });
	if (!run) return null;
	if (run.origin === "proactive") {
		const followup = await prisma.botFollowup.findFirst({ where: { runId }, select: { note: true } });
		return buildMessageSource({ runOrigin: run.origin, runCreatedAt: run.createdAt, followup });
	}
	if (run.origin !== "routine" && run.origin !== "webhook") return null;
	const routineRun = await prisma.routineRun.findFirst({
		where: { agentRunId: runId },
		select: {
			triggeredBy: true,
			scheduledFor: true,
			startedAt: true,
			createdAt: true,
			eventJson: true,
			routine: { select: { name: true, triggerType: true } },
		},
	});
	return buildMessageSource({
		runOrigin: run.origin,
		runCreatedAt: run.createdAt,
		routine: routineRun?.routine ?? null,
		routineRun,
	});
}

export async function completeAgentRunAtomically(input: {
	runId: string;
	conversationId?: string | null;
	assistantText: string;
	sandboxSessionId?: string | null;
	lease?: RunLease | null;
	donePayload: ComputerUseEvent;
	/** Permite finalizar como budget_exhausted mantendo texto e transcript. */
	status?: AgentRunStatus;
	usage?: RunUsage;
}): Promise<void> {
	const terminalStatus = input.status ?? "completed";
	// Saída de rotina/webhook é marcada: o histórico do chat não a toma por fala do usuário.
	const runOrigin = input.conversationId
		? (await prisma.agentRun.findUnique({ where: { id: input.runId }, select: { origin: true } }))?.origin
		: undefined;
	const tag = await botMessageTag(input.runId, runOrigin, input.conversationId);
	const source = input.conversationId ? await resolveRunMessageSource(input.runId).catch(() => null) : null;
	const usageJson =
		input.usage === undefined
			? undefined
			: (input.usage as unknown as Prisma.InputJsonValue);
	// F4 — conversa apagada: finaliza o run sem gravar o transcript (sem FK).
	const conversationOk = input.conversationId
		? await conversationAlive(input.conversationId)
		: false;
	await prisma.$transaction(async (tx) => {
		await lockRunEventSeq(tx, input.runId);
		if (input.lease) {
			const owned = await tx.agentRun.updateMany({
				where: {
					id: input.runId,
					...ownedLeaseWhere(input.lease),
				},
				data: {
					status: terminalStatus,
					resultText: input.assistantText,
					sandboxSessionId: input.sandboxSessionId ?? undefined,
					usageJson,
					finishedAt: new Date(),
					leaseOwner: null,
					leaseUntil: null,
					leaseToken: null,
				},
			});
			if (owned.count !== 1) {
				throw new Error("lease_lost");
			}
		} else {
			await tx.agentRun.update({
				where: { id: input.runId },
				data: {
					status: terminalStatus,
					resultText: input.assistantText,
					sandboxSessionId: input.sandboxSessionId ?? undefined,
					usageJson,
					finishedAt: new Date(),
					leaseOwner: null,
					leaseUntil: null,
					leaseToken: null,
				},
			});
		}

		if (input.conversationId && conversationOk) {
			const segments = input.assistantText
				.split(/\n{2,}/)
				.map((s) => s.trim())
				.filter((s) => s.length > 0);
			for (const segment of segments) {
				await tx.conversationMessage.create({
					data: {
						conversationId: input.conversationId,
						role: "assistant",
						content: segment,
						runId: input.runId,
						...(tag.origin ? { origin: tag.origin } : {}),
						...(tag.bot?.botMessageId ? { botMessageId: tag.bot.botMessageId } : {}),
						...(source ? { sourceKind: source.kind, sourceLabel: source.label, sourceAt: source.at } : {}),
						...(tag.bot?.fromBotId ? { fromBotId: tag.bot.fromBotId, fromBotName: tag.bot.fromBotName } : {}),
					},
				});
			}
		}

		if (input.conversationId && conversationOk) {
			const current = await tx.agentRun.findUnique({ where: { id: input.runId }, select: { checkpointJson: true } });
			const next = withFinalReply(current?.checkpointJson, input.assistantText);
			if (next) await tx.agentRun.update({ where: { id: input.runId }, data: { checkpointJson: next as unknown as Prisma.InputJsonValue } });
		}

		await insertRunEventRow(tx, input.runId, "done", input.donePayload);
	});
	signalRunEventAppended(input.runId);
	await settleRoutineRunForAgentRun(input.runId, {
		status: terminalStatus,
		resultText: input.assistantText,
	});
}


/**
 * Notas de pesquisa (F3) de outros runs da MESMA conversa e do mesmo dono, mais
 * recentes por último. O dono vem da sessão do run (nunca do modelo); conversa
 * sem dono igual não devolve nada. O formato é validado de novo no runtime.
 */
export async function listConversationResearchNotes(
	userId: string,
	conversationId: string,
	options?: { excludeRunId?: string; limitRuns?: number; origin?: string },
): Promise<ResearchNote[]> {
	if (!userId || !conversationId) return [];
	const rows = await prisma.agentRun.findMany({
		where: {
			conversationId,
			userId: { in: ownerIds(userId) },
			...(options?.origin ? { origin: options.origin } : {}),
			...(options?.excludeRunId ? { id: { not: options.excludeRunId } } : {}),
		},
		select: { checkpointJson: true },
		orderBy: { createdAt: "desc" },
		take: options?.limitRuns ?? 5,
	});
	const notes: ResearchNote[] = [];
	for (const row of [...rows].reverse()) {
		const raw = row.checkpointJson;
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
		const list = (raw as { researchNotes?: unknown }).researchNotes;
		if (Array.isArray(list)) notes.push(...(list as ResearchNote[]));
	}
	return notes;
}

export type RunTranscript = {
	runId: string;
	/** Marca d'água da conversa no começo do run (ausente em checkpoint anterior a ela). */
	watermark?: { messageId: string; createdAt: string; count: number };
	/** Janela do run: falas do usuário gravadas durante ela já entraram na conversa do run. */
	createdAt: Date;
	finishedAt: Date | null;
	/** Mensagens do LLM como gravadas no checkpoint (forma serializada; o runtime valida e higieniza). */
	llmMessages: unknown[];
	loadedTools?: string[];
};

function transcriptOf(row: { id: string; createdAt: Date; finishedAt: Date | null; checkpointJson: unknown }): RunTranscript | null {
	const raw = row.checkpointJson;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const { llmMessages, loadedTools, transcriptWatermark } = raw as { llmMessages?: unknown; loadedTools?: unknown; transcriptWatermark?: unknown };
	const mark = transcriptWatermark as { messageId?: unknown; createdAt?: unknown; count?: unknown } | undefined;
	if (!Array.isArray(llmMessages) || llmMessages.length === 0) return null;
	return {
		runId: row.id,
		...(mark && typeof mark.messageId === "string" && typeof mark.createdAt === "string" && typeof mark.count === "number" ? { watermark: { messageId: mark.messageId, createdAt: mark.createdAt, count: mark.count } } : {}),
		createdAt: row.createdAt,
		finishedAt: row.finishedAt,
		llmMessages,
		...(Array.isArray(loadedTools) ? { loadedTools: loadedTools.filter((name): name is string => typeof name === "string").slice(0, 200) } : {}),
	};
}

/**
 * Conversa completa (mensagens do LLM com chamadas e resultados de ferramenta) do run de chat mais recente
 * da MESMA conversa e do mesmo dono. Serve de ponto de partida do run seguinte; o dono vem da sessão do run.
 * Run sem checkpoint (comando tratado no servidor) é pulado.
 */
export async function getConversationTranscript(
	userId: string,
	conversationId: string,
	options?: { excludeRunId?: string },
): Promise<RunTranscript | null> {
	if (!userId || !conversationId) return null;
	const rows = await prisma.agentRun.findMany({
		where: {
			conversationId,
			userId: { in: ownerIds(userId) },
			origin: "chat",
			parentRunId: null,
			...(options?.excludeRunId ? { id: { not: options.excludeRunId } } : {}),
		},
		select: { id: true, createdAt: true, finishedAt: true, checkpointJson: true },
		orderBy: { createdAt: "desc" },
		take: 3,
	});
	for (const row of rows) {
		const transcript = transcriptOf(row);
		if (transcript) return transcript;
	}
	return null;
}

/** Conversa de um run específico (continuação de aprovação); só vale se for da mesma conversa e do mesmo dono. */
export async function getRunTranscript(userId: string, conversationId: string, runId: string): Promise<RunTranscript | null> {
	if (!userId || !conversationId || !runId) return null;
	const row = await prisma.agentRun.findFirst({
		where: { id: runId, conversationId, userId: { in: ownerIds(userId) } },
		select: { id: true, createdAt: true, finishedAt: true, checkpointJson: true },
	});
	return row ? transcriptOf(row) : null;
}

/**
 * Ledger de itens (V3) do run mais recente da MESMA conversa e do mesmo dono
 * que declarou itens. Só volta se ainda houver item aberto: tarefa concluída
 * não é herdada. O dono vem da sessão do run (nunca do modelo). O runtime
 * oferece o ledger ao modelo; ele só vale depois de adotado.
 */
export async function getConversationTaskLedger(
	userId: string,
	conversationId: string,
	options?: { excludeRunId?: string; limitRuns?: number; origin?: string },
): Promise<TaskLedger | null> {
	if (!userId || !conversationId) return null;
	const rows = await prisma.agentRun.findMany({
		where: {
			conversationId,
			userId: { in: ownerIds(userId) },
			...(options?.origin ? { origin: options.origin } : {}),
			...(options?.excludeRunId ? { id: { not: options.excludeRunId } } : {}),
		},
		select: { checkpointJson: true },
		orderBy: { createdAt: "desc" },
		take: options?.limitRuns ?? 5,
	});
	for (const row of rows) {
		const raw = row.checkpointJson;
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
		const ledger = parseTaskLedger((raw as { taskState?: { ledger?: unknown } }).taskState?.ledger);
		if (!ledger || ledger.items.length === 0) continue;
		return openItems(ledger).length > 0 ? ledger : null;
	}
	return null;
}

type TaskContextRunRow = {
	id: string;
	objective: string;
	status: string;
	resultText: string | null;
	effects: unknown;
};

/** Id da chamada dentro do attemptId do ledger (`<run>:<step>:<toolCallId>:<tool>`). */
function effectToolCallId(attemptId: unknown, runId: string): string | null {
	if (typeof attemptId !== "string" || !attemptId.startsWith(`${runId}:`)) return null;
	const parts = attemptId.split(":");
	return parts.length >= 4 ? (parts[2] ?? null) : null;
}

/**
 * Tarefa ativa da conversa (bug #80): as últimas tarefas do USUÁRIO (runs de
 * chat; rotina, webhook e subagente ficam de fora) e as escritas externas que
 * elas concluíram, com o resumo do resultado (ids e links do recurso criado).
 * Vem do banco, não do histórico: sobrevive à compactação e a runs sem texto.
 * Escopo: dono da sessão + conversa; nunca confia em id de body.
 */
export async function getConversationTaskContext(
	userId: string,
	conversationId: string,
	options?: { excludeRunId?: string; limitRuns?: number },
): Promise<ConversationTaskContext | null> {
	if (!userId || !conversationId) return null;
	const limitRuns = options?.limitRuns ?? 6;
	const rows = await prisma.$queryRaw<TaskContextRunRow[]>`
		SELECT "id", "objective", "status", "resultText",
			"checkpointJson"->'executionLedger'->'effects' AS "effects"
		FROM "agent_runs"
		WHERE "conversationId" = ${conversationId}
			AND "userId" IN (${Prisma.join(ownerIds(userId))})
			AND "origin" = 'chat'
			${options?.excludeRunId ? Prisma.sql`AND "id" <> ${options.excludeRunId}` : Prisma.empty}
		ORDER BY "createdAt" DESC
		LIMIT ${limitRuns * 2}
	`;
	const tasks: ConversationTaskContext["tasks"] = [];
	const callIdsByRun = new Map<string, Array<{ tool: string; callId: string }>>();
	for (const row of rows) {
		// "confirmado: ..." é só o aval de um card: não é tarefa, mas a escrita confirmada conta como efeito.
		if (!isCardConfirmToken(row.objective) && tasks.length < limitRuns) {
			tasks.push({
				objective: row.objective,
				status: row.status,
				...(row.resultText?.trim() ? { outcome: row.resultText.trim() } : {}),
			});
		}
		const effects = Array.isArray(row.effects) ? row.effects : [];
		for (const effect of effects) {
			if (!effect || typeof effect !== "object") continue;
			const { tool, state, attemptId } = effect as { tool?: unknown; state?: unknown; attemptId?: unknown };
			const callId = effectToolCallId(attemptId, row.id);
			if (typeof tool !== "string" || state !== "ok" || !callId) continue;
			callIdsByRun.set(row.id, [...(callIdsByRun.get(row.id) ?? []), { tool, callId }]);
		}
	}
	const effects: ConversationTaskContext["effects"] = [];
	for (const row of rows) {
		const calls = callIdsByRun.get(row.id);
		if (!calls?.length) continue;
		const events = await prisma.runEvent.findMany({
			where: { runId: row.id, type: "tool_result" },
			select: { payload: true },
			orderBy: { seq: "desc" },
			take: 200,
		});
		const summaryByCall = new Map<string, string>();
		for (const event of events) {
			const payload = event.payload as { id?: unknown; ok?: unknown; summary?: unknown } | null;
			if (payload && payload.ok === true && typeof payload.id === "string" && typeof payload.summary === "string") {
				summaryByCall.set(payload.id, payload.summary);
			}
		}
		for (const call of [...calls].reverse()) {
			const summary = summaryByCall.get(call.callId);
			if (summary) effects.push({ tool: call.tool, summary: redactSecrets(summary) });
		}
	}
	return tasks.length > 0 ? { tasks, effects } : null;
}

/** Run "ativo" sem sinal de vida há mais que isso não conta como trabalhando (mesma graça do varredor de runs fantasmas). */
export const WORKING_RUN_STALE_MS = 900_000;

/**
 * Onde o usuário tem run em andamento agora (`queued`/`running`; `waiting_user`/`waiting_external`/`paused` não
 * contam, pois esperam uma pessoa). Run sem atividade (`updatedAt`) além do corte é considerado fantasma
 * (worker morto) e não deixa o bot "trabalhando" para sempre. Só do próprio usuário.
 */
export async function listWorkingTargets(
	userId: string,
	now: number = Date.now(),
	staleMs: number = WORKING_RUN_STALE_MS,
): Promise<{ botIds: Set<string>; conversationIds: Set<string> }> {
	const rows = await prisma.agentRun.findMany({
		where: {
			userId,
			status: { in: ["queued", "running"] },
			cancelRequested: false,
			updatedAt: { gte: new Date(now - staleMs) },
		},
		select: { botId: true, conversationId: true },
	});
	const botIds = new Set<string>();
	const conversationIds = new Set<string>();
	for (const row of rows) {
		if (row.botId) botIds.add(row.botId);
		if (row.conversationId) conversationIds.add(row.conversationId);
	}
	return { botIds, conversationIds };
}
