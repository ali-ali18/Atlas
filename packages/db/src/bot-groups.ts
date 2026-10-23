import {
	GROUP_JEV_MAX_RETRIES,
	GROUP_JEV_MAX_WORKERS,
	GROUP_JEV_THRESHOLD,
	GROUP_JEV_TURN_MAX_REPLIES,
	GROUP_MAX_MEMBERS,
	GROUP_MIN_MEMBERS,
	buildGroupRolePrompt,
	buildGroupTurnPrompt,
	buildJevRoutingQuestions,
	buildJevVerifyQuestions,
	decideJevRoute,
	jevRoutingState,
	jevVerifyState,
	parseCoordinatorAssignments,
	type JevQuestionDef,
	normalizeGroupMemberIds,
	planGroupFollowUps,
	routeGroupMessage,
	type Bot,
	type GroupMember,
	type GroupReplyReason,
	type GroupStateResponse,
	type PostGroupMessageResponse,
} from "@workspace/shared";
import { prisma } from "./client.js";
import { createBot, updateBot } from "./bots.js";
import { ensureBotConversation, isTerminal, resolveBotModel } from "./bot-messages.js";
import { createAgentRun, listActiveRunsForConversation } from "./runs.js";
import { ownerIds } from "./mcp-connections.js";
export { getGroupAuthor, isGroupConversation } from "./group-lookup.js";

/**
 * Grupos de bots. Um grupo é um `Bot` com `memberIds` (2+ bots do mesmo dono, que
 * não são grupos) e conversa própria. O usuário fala na conversa do grupo; o
 * worker decide quem responde (`GroupTurn`) e enfileira uma resposta por membro
 * (`GroupReply`), sempre uma de cada vez (uma conversa só tem um run ativo).
 * Cada resposta é um run normal do membro (memória, conectores, VM e autonomia
 * dele), com a conversa do grupo como contexto, gravado com o autor do membro.
 */

export class GroupError extends Error {
	constructor(
		message: string,
		readonly code: "invalid" | "not_found" | "busy" = "invalid",
	) {
		super(message);
		this.name = "GroupError";
	}
}

export const GROUP_MESSAGE_MAX_CHARS = 8_000;
/** Turnos do grupo ainda abertos (roteando/ativos) além dos quais o usuário precisa esperar. */
export const GROUP_MAX_OPEN_TURNS = 4;
/** `running` sem run há mais que isso volta para a fila (queda entre reservar e criar o run). */
export const GROUP_REPLY_STALE_MS = 2 * 60_000;
const SWEEP_BATCH = 20;

type Listener = () => void;
const turnListeners = new Set<Listener>();

/** O worker assina para rotear na hora (só vale no mesmo processo). */
export function onGroupTurnCreated(listener: Listener): () => void {
	turnListeners.add(listener);
	return () => turnListeners.delete(listener);
}

type GroupRow = {
	id: string;
	name: string;
	conversationId: string | null;
	memberIds: string[];
};

export type GroupWithMembers = {
	group: GroupRow;
	members: GroupMember[];
};

function toMember(row: { id: string; name: string; description: string | null; snippet: string; isPrimary: boolean }): GroupMember {
	return { id: row.id, name: row.name, description: row.description, snippet: row.snippet, isPrimary: row.isPrimary };
}

/** Grupo do dono + membros que ainda existem (na ordem de `memberIds`). `null` = não é grupo dele. */
export async function getGroupWithMembers(userId: string, groupId: string): Promise<GroupWithMembers | null> {
	const owners = ownerIds(userId);
	if (owners.length === 0 || !groupId) return null;
	const group = await prisma.bot.findFirst({
		where: { id: groupId, ownerId: { in: owners }, memberIds: { isEmpty: false } },
		select: { id: true, name: true, conversationId: true, memberIds: true },
	});
	if (!group) return null;
	const rows = await prisma.bot.findMany({
		where: { id: { in: group.memberIds }, ownerId: { in: owners }, memberIds: { isEmpty: true } },
		select: { id: true, name: true, description: true, snippet: true, isPrimary: true },
	});
	const byId = new Map(rows.map((row) => [row.id, row]));
	const members = group.memberIds.flatMap((id) => {
		const row = byId.get(id);
		return row ? [toMember(row)] : [];
	});
	return { group, members };
}

/**
 * O run de `botId` na conversa `conversationId` é uma resposta de grupo? Devolve o
 * grupo e os membros (para o prompt, a transcrição e a VM do próprio bot).
 */
export async function getGroupRunContext(input: {
	userId: string;
	botId: string | null | undefined;
	conversationId: string | null | undefined;
}): Promise<{ groupId: string; groupName: string; members: GroupMember[]; selfConversationId: string | null } | null> {
	if (!input.botId || !input.conversationId) return null;
	const owners = ownerIds(input.userId);
	if (owners.length === 0) return null;
	const group = await prisma.bot.findFirst({
		where: { conversationId: input.conversationId, ownerId: { in: owners }, memberIds: { has: input.botId } },
		select: { id: true },
	});
	if (!group) return null;
	const found = await getGroupWithMembers(input.userId, group.id);
	if (!found || !found.members.some((member) => member.id === input.botId)) return null;
	const self = await prisma.bot.findFirst({ where: { id: input.botId, ownerId: { in: owners } }, select: { conversationId: true } });
	return { groupId: group.id, groupName: found.group.name, members: found.members, selfConversationId: self?.conversationId ?? null };
}

/** `botId` é membro do grupo `groupId` (mesmo dono)? */
export async function isGroupMember(userId: string, groupId: string | null | undefined, botId: string): Promise<boolean> {
	if (!groupId) return false;
	const owners = ownerIds(userId);
	if (owners.length === 0) return false;
	const group = await prisma.bot.findFirst({ where: { id: groupId, ownerId: { in: owners }, memberIds: { has: botId } }, select: { id: true } });
	return Boolean(group);
}

/** Confere que todos os ids são bots do dono e não são grupos. Devolve os ids na ordem pedida. */
export async function validateGroupMemberIds(userId: string, raw: readonly unknown[], selfId?: string): Promise<string[]> {
	const ids = normalizeGroupMemberIds(raw);
	if (!ids) throw new GroupError(`Um grupo precisa de ${GROUP_MIN_MEMBERS} a ${GROUP_MAX_MEMBERS} bots diferentes.`);
	if (selfId && ids.includes(selfId)) throw new GroupError("Um grupo não pode conter a si mesmo.");
	const owners = ownerIds(userId);
	if (owners.length === 0) throw new GroupError("Bots não encontrados.", "not_found");
	const rows = await prisma.bot.findMany({
		where: { id: { in: ids }, ownerId: { in: owners }, memberIds: { isEmpty: true } },
		select: { id: true },
	});
	if (rows.length !== ids.length) throw new GroupError("Escolha apenas bots seus (grupos não podem ser membros).", "not_found");
	return ids;
}

export async function createGroup(
	userId: string,
	input: { name: string; memberIds: readonly unknown[]; color?: string; shape?: string },
): Promise<Bot> {
	const name = input.name.trim();
	if (!name) throw new GroupError("Dê um nome ao grupo.");
	const memberIds = await validateGroupMemberIds(userId, input.memberIds);
	return createBot(
		{
			name: name.slice(0, 80),
			snippet: `${memberIds.length} bots no grupo`,
			...(input.color ? { color: input.color } : {}),
			...(input.shape ? { shape: input.shape } : {}),
			memberIds,
		},
		userId,
	);
}

/** Troca a lista de membros de um grupo existente (mínimo 2). */
export async function setGroupMembers(userId: string, groupId: string, rawIds: readonly unknown[]): Promise<Bot> {
	const found = await getGroupWithMembers(userId, groupId);
	if (!found) throw new GroupError("Grupo não encontrado.", "not_found");
	const memberIds = await validateGroupMemberIds(userId, rawIds, groupId);
	return updateBot(groupId, { memberIds, snippet: `${memberIds.length} bots no grupo` }, userId);
}

export async function addGroupMember(userId: string, groupId: string, botId: string): Promise<Bot> {
	const found = await getGroupWithMembers(userId, groupId);
	if (!found) throw new GroupError("Grupo não encontrado.", "not_found");
	if (found.group.memberIds.includes(botId)) throw new GroupError("Esse bot já está no grupo.");
	return setGroupMembers(userId, groupId, [...found.group.memberIds, botId]);
}

export async function removeGroupMember(userId: string, groupId: string, botId: string): Promise<Bot> {
	const found = await getGroupWithMembers(userId, groupId);
	if (!found) throw new GroupError("Grupo não encontrado.", "not_found");
	if (!found.group.memberIds.includes(botId)) throw new GroupError("Esse bot não está no grupo.", "not_found");
	const rest = found.group.memberIds.filter((id) => id !== botId);
	if (rest.length < GROUP_MIN_MEMBERS) {
		throw new GroupError("Um grupo precisa de pelo menos 2 bots. Exclua o grupo se não quiser mais conversar nele.");
	}
	// Respostas ainda na fila do membro removido não fazem mais sentido.
	await prisma.groupReply.updateMany({ where: { groupId, botId, status: "pending" }, data: { status: "skipped", finishedAt: new Date() } });
	return setGroupMembers(userId, groupId, rest);
}

/** Bot excluído sai dos grupos dele (os grupos ficam com os demais). */
export async function removeBotFromGroups(userId: string, botId: string): Promise<void> {
	const owners = ownerIds(userId);
	if (owners.length === 0) return;
	const groups = await prisma.bot.findMany({
		where: { ownerId: { in: owners }, memberIds: { has: botId } },
		select: { id: true, memberIds: true },
	});
	for (const group of groups) {
		await prisma.bot.update({ where: { id: group.id }, data: { memberIds: group.memberIds.filter((id) => id !== botId) } });
		await prisma.groupReply.updateMany({ where: { groupId: group.id, botId, status: "pending" }, data: { status: "skipped", finishedAt: new Date() } });
	}
}

/** Grupo excluído: limpa a fila e os turnos. */
export async function clearGroupDispatch(groupId: string): Promise<void> {
	await prisma.groupReply.deleteMany({ where: { groupId } });
	await prisma.groupTurn.deleteMany({ where: { groupId } });
}

/**
 * Fala do usuário no grupo: grava a mensagem, descarta respostas ainda na fila de
 * turnos anteriores e abre um turno a rotear. `GroupError` com texto limpo.
 */
export async function postGroupUserMessage(input: { userId: string; groupId: string; content: string }): Promise<PostGroupMessageResponse> {
	const found = await getGroupWithMembers(input.userId, input.groupId);
	if (!found) throw new GroupError("Grupo não encontrado.", "not_found");
	const content = input.content.trim();
	if (!content) throw new GroupError("A mensagem não pode ser vazia.");
	if (content.length > GROUP_MESSAGE_MAX_CHARS) throw new GroupError(`Mensagem longa demais (máx. ${GROUP_MESSAGE_MAX_CHARS} caracteres).`);
	if (found.members.length === 0) throw new GroupError("O grupo não tem membros.");
	const userId = ownerIds(input.userId)[0]!;
	const conversationId = await ensureGroupConversation(found.group, userId);
	const open = await prisma.groupTurn.count({ where: { groupId: input.groupId, status: { in: ["routing", "active"] } } });
	if (open >= GROUP_MAX_OPEN_TURNS) throw new GroupError("O grupo ainda está respondendo. Aguarde um instante.", "busy");

	const message = await prisma.conversationMessage.create({ data: { conversationId, role: "user", content } });
	await prisma.groupReply.updateMany({
		where: { groupId: input.groupId, status: "pending" },
		data: { status: "skipped", finishedAt: new Date() },
	});
	const turn = await prisma.groupTurn.create({
		data: { userId, groupId: input.groupId, conversationId, messageId: message.id },
	});
	for (const listener of turnListeners) {
		try {
			listener();
		} catch {
			// ouvinte nunca derruba o envio
		}
	}
	return { messageId: message.id, turnId: turn.id };
}

async function ensureGroupConversation(group: GroupRow, userId: string): Promise<string> {
	if (group.conversationId) return group.conversationId;
	const conversation = await prisma.conversation.create({ data: { userId } });
	await prisma.bot.updateMany({ where: { id: group.id, conversationId: null }, data: { conversationId: conversation.id } });
	const bot = await prisma.bot.findFirst({ where: { id: group.id }, select: { conversationId: true } });
	return bot?.conversationId ?? conversation.id;
}

/** Coordenador do turno ativo do grupo (coordenação com Jev), se houver. */
async function activeCoordinator(groupId: string): Promise<string | null> {
	const turns = await prisma.groupTurn.findMany({ where: { groupId, status: "active" }, orderBy: { createdAt: "desc" }, take: 4, select: { id: true } });
	if (turns.length === 0) return null;
	const row = await prisma.groupReply.findFirst({ where: { turnId: { in: turns.map((turn) => turn.id) }, role: "coordinator" }, orderBy: { createdAt: "desc" }, select: { botId: true } });
	return row?.botId ?? null;
}

export async function getGroupState(userId: string, groupId: string): Promise<GroupStateResponse | null> {
	const found = await getGroupWithMembers(userId, groupId);
	if (!found) return null;
	const [routing, replies, coordinator] = await Promise.all([
		prisma.groupTurn.count({ where: { groupId, status: "routing" } }),
		prisma.groupReply.findMany({
			where: { groupId, status: { in: ["pending", "running"] } },
			orderBy: { createdAt: "asc" },
			take: 20,
			select: { id: true, botId: true, status: true, runId: true, depth: true, role: true },
		}),
		activeCoordinator(groupId),
	]);
	return { routing: routing > 0, replies, ...(coordinator ? { coordinatorBotId: coordinator } : {}) };
}

// ---------------------------------------------------------------------------
// Despacho (worker)
// ---------------------------------------------------------------------------

export type GroupDispatchDeps = {
	/** Enfileira o job do run (worker). */
	enqueueRun: (runId: string) => Promise<boolean>;
	envDefaultModel: string;
	now?: () => Date;
	/** Roteador LLM barato (só quando as regras não decidem). Devolve ids; erro/vazio = reserva. */
	route?: (input: { userId: string; groupName: string; text: string; members: GroupMember[] }) => Promise<string[]>;
	/**
	 * Coordenação inteligente (opt-in por conta): o Jev decide quem responde, a tarefa
	 * delegada vira coordenador + membros + verificação + resumo. `ask` devolve a
	 * probabilidade de "sim" por pergunta e lança em erro/timeout (cai no fluxo base).
	 */
	jev?: {
		enabled: (userId: string) => Promise<boolean>;
		ask: (input: { userId: string; state: unknown; questions: Record<string, JevQuestionDef> }) => Promise<Record<string, number>>;
	};
	/** Injetáveis em teste; padrão: db. */
	createRun?: typeof createAgentRun;
	activeRuns?: typeof listActiveRunsForConversation;
	resolveModel?: (botId: string, userId: string, envDefault: string) => Promise<string>;
	ensureConversation?: typeof ensureBotConversation;
};

export type GroupDispatchResult = {
	routed: number;
	started: number;
	settled: number;
	followUps: number;
	busy: number;
	/** Ainda há turno roteando ou ativo: o worker volta a varrer logo. */
	inFlight: boolean;
};

/** Uma chamada ao Jev para decidir quem responde. `null` = indisponível (cai no fluxo base). Log sem conteúdo. */
async function decideWithJev(
	jev: NonNullable<GroupDispatchDeps["jev"]>,
	turn: { id: string; userId: string },
	text: string,
	members: GroupMember[],
): Promise<ReturnType<typeof decideJevRoute> | null> {
	try {
		if (!(await jev.enabled(turn.userId))) return null;
		const answers = await jev.ask({ userId: turn.userId, state: jevRoutingState(text, members), questions: buildJevRoutingQuestions(members) });
		const decision = decideJevRoute({ members, answers });
		const scores = JSON.stringify(Object.fromEntries(Object.entries(decision.scores).map(([id, score]) => [id, Number(score.toFixed(2))])));
		console.log(`[group-jev] route turn=${turn.id} mode=${decision.mode} picked=${decision.ids.length} scores=${scores} wide=${(answers.group_wide ?? 0).toFixed(2)} multi=${(answers.multi_task ?? 0).toFixed(2)}`);
		return decision;
	} catch (error) {
		console.log(`[group-jev] route turn=${turn.id} fallback=base reason=${error instanceof Error ? error.name : "error"}`);
		return null;
	}
}

async function routeTurns(deps: GroupDispatchDeps): Promise<number> {
	const turns = await prisma.groupTurn.findMany({ where: { status: "routing" }, orderBy: { createdAt: "asc" }, take: SWEEP_BATCH });
	let routed = 0;
	for (const turn of turns) {
		try {
			const found = await getGroupWithMembers(turn.userId, turn.groupId);
			const message = found ? await prisma.conversationMessage.findFirst({ where: { id: turn.messageId }, select: { content: true } }) : null;
			if (!found || !message || found.members.length === 0) {
				await prisma.groupTurn.updateMany({ where: { id: turn.id, status: "routing" }, data: { status: "done" } });
				continue;
			}
			const route = routeGroupMessage({ text: message.content, members: found.members });
			let ids = route.ids;
			let reason: GroupReplyReason = route.reason;
			let role: "coordinator" | null = null;
			// @menção (ou nome citado) sempre vence; senão o Jev decide, se a conta ligou a coordenação.
			const explicit = route.reason === "user_mention" || route.reason === "named";
			let decidedByJev = false;
			if (!explicit && deps.jev && found.members.length >= 2) {
				const decision = await decideWithJev(deps.jev, turn, message.content, found.members);
				if (decision && decision.ids.length > 0) {
					ids = decision.ids;
					decidedByJev = true;
					if (decision.mode === "coordinate") {
						role = "coordinator";
						reason = "coordinator";
					} else {
						reason = "jev";
					}
				}
			}
			if (!decidedByJev && route.needsLlm && deps.route) {
				const picked = await deps.route({ userId: turn.userId, groupName: found.group.name, text: message.content, members: found.members }).catch(() => []);
				const valid = picked.filter((id) => found.members.some((member) => member.id === id));
				if (valid.length > 0) ids = valid;
			}
			const base = (deps.now ?? (() => new Date()))().getTime();
			const claimed = await prisma.$transaction(async (tx) => {
				const claim = await tx.groupTurn.updateMany({ where: { id: turn.id, status: "routing" }, data: { status: ids.length > 0 ? "active" : "done" } });
				if (claim.count !== 1) return false;
				for (const [index, botId] of ids.entries()) {
					await tx.groupReply.create({
						data: {
							turnId: turn.id,
							userId: turn.userId,
							groupId: turn.groupId,
							conversationId: turn.conversationId,
							botId,
							depth: 1,
							reason,
							...(role ? { role } : {}),
							createdAt: new Date(base + index),
						},
					});
				}
				return true;
			});
			if (claimed) routed += 1;
		} catch (error) {
			console.error(`[bot-groups] route failed turn=${turn.id}`, error);
		}
	}
	return routed;
}

function replyTextOf(run: { status: string; resultText: string | null }): string | null {
	if (run.status !== "completed" && run.status !== "budget_exhausted") return null;
	const text = run.resultText?.trim();
	return text || null;
}

/** Respostas cujo run terminou: fecham e, se o texto menciona outro membro, disparam a resposta dele. */
async function settleReplies(deps: GroupDispatchDeps): Promise<{ settled: number; followUps: number }> {
	const rows = await prisma.groupReply.findMany({ where: { status: "running", runId: { not: null } }, orderBy: { createdAt: "asc" }, take: SWEEP_BATCH });
	let settled = 0;
	let followUps = 0;
	for (const reply of rows) {
		const run = await prisma.agentRun.findUnique({ where: { id: reply.runId! }, select: { status: true, resultText: true, error: true } });
		if (run && !isTerminal(run.status)) continue;
		const text = run ? replyTextOf(run) : null;
		const finalStatus = run && (run.status === "completed" || run.status === "budget_exhausted") ? "done" : "failed";
		const claimed = await prisma.groupReply.updateMany({
			where: { id: reply.id, status: "running" },
			data: { status: finalStatus, finishedAt: new Date(), error: finalStatus === "failed" ? (run?.error ?? run?.status ?? "run_missing") : null },
		});
		if (claimed.count !== 1) continue;
		settled += 1;
		// Usuário parou o run (ou ele sumiu): o resto da fila do turno não segue sozinho.
		if (!run || run.status === "cancelled") {
			await prisma.groupReply.updateMany({ where: { turnId: reply.turnId, status: "pending" }, data: { status: "skipped", finishedAt: new Date() } });
			// Coordenação cancelada: o turno acaba aqui, sem resumo.
			if (reply.role) await prisma.groupTurn.updateMany({ where: { id: reply.turnId, status: "active" }, data: { status: "done" } });
			continue;
		}
		if (reply.role) {
			await advanceCoordination(reply, finalStatus === "done" ? text : null, deps).catch((error) => console.error(`[group-jev] advance failed reply=${reply.id}`, error));
			continue;
		}
		if (!text) continue;
		const found = await getGroupWithMembers(reply.userId, reply.groupId);
		if (!found) continue;
		const [turnReplies, queued] = await Promise.all([
			prisma.groupReply.count({ where: { turnId: reply.turnId, status: { not: "skipped" } } }),
			prisma.groupReply.findMany({ where: { turnId: reply.turnId, status: { in: ["pending", "running"] } }, select: { botId: true } }),
		]);
		const plan = planGroupFollowUps({
			text,
			members: found.members,
			authorId: reply.botId,
			depth: reply.depth,
			turnReplyCount: turnReplies,
			queuedBotIds: queued.map((row) => row.botId),
		});
		const base = Date.now();
		for (const [index, follow] of plan.entries()) {
			await prisma.groupReply.create({
				data: {
					turnId: reply.turnId,
					userId: reply.userId,
					groupId: reply.groupId,
					conversationId: reply.conversationId,
					botId: follow.botId,
					depth: follow.depth,
					reason: "bot_mention",
					triggerBotId: reply.botId,
					createdAt: new Date(base + index),
				},
			});
			followUps += 1;
		}
	}
	return { settled, followUps };
}

type SettledReply = {
	id: string;
	turnId: string;
	userId: string;
	groupId: string;
	conversationId: string;
	botId: string;
	triggerBotId: string | null;
	role: string | null;
	subtask: string | null;
	attempt: number;
	depth: number;
};

/**
 * Coordenação com Jev, um passo depois de uma resposta com papel terminar:
 *  - coordenador: as linhas com @Membro viram subtarefas (uma resposta `worker` cada);
 *  - membro: o Jev confere se cumpriu a subtarefa; reprovou, uma retentativa com "faltou: …";
 *  - quando não resta membro em aberto, o coordenador é chamado uma vez para o resumo.
 * Resposta de papel nunca dispara menções do fluxo base (sem laço).
 */
async function advanceCoordination(reply: SettledReply, text: string | null, deps: GroupDispatchDeps): Promise<void> {
	const found = await getGroupWithMembers(reply.userId, reply.groupId);
	if (!found) return;
	const total = await prisma.groupReply.count({ where: { turnId: reply.turnId, status: { not: "skipped" } } });
	const base = Date.now();
	if (reply.role === "coordinator") {
		if (!text) return;
		// Reserva uma vaga para o resumo final.
		const room = Math.max(0, GROUP_JEV_TURN_MAX_REPLIES - total - 1);
		const assignments = parseCoordinatorAssignments({
			text,
			members: found.members,
			coordinatorId: reply.botId,
			max: Math.min(GROUP_JEV_MAX_WORKERS, room),
		});
		for (const [index, item] of assignments.entries()) {
			await prisma.groupReply.create({
				data: {
					turnId: reply.turnId,
					userId: reply.userId,
					groupId: reply.groupId,
					conversationId: reply.conversationId,
					botId: item.botId,
					depth: reply.depth + 1,
					reason: "assigned" satisfies GroupReplyReason,
					role: "worker",
					subtask: item.subtask,
					triggerBotId: reply.botId,
					createdAt: new Date(base + index),
				},
			});
		}
		console.log(`[group-jev] assign turn=${reply.turnId} workers=${assignments.length}`);
		return;
	}
	if (reply.role !== "worker") return;
	if (text && deps.jev && reply.subtask) {
		const name = found.members.find((member) => member.id === reply.botId)?.name ?? "Membro";
		let score: number | null = null;
		try {
			if (await deps.jev.enabled(reply.userId)) {
				const answers = await deps.jev.ask({
					userId: reply.userId,
					state: jevVerifyState({ subtask: reply.subtask, reply: text }),
					questions: buildJevVerifyQuestions({ name, subtask: reply.subtask }),
				});
				score = answers.fulfilled ?? null;
			}
		} catch (error) {
			console.log(`[group-jev] verify turn=${reply.turnId} reply=${reply.id} unavailable=${error instanceof Error ? error.name : "error"}`);
		}
		if (score !== null) {
			await prisma.groupReply.update({ where: { id: reply.id }, data: { jevScore: score } });
			const retry = score < GROUP_JEV_THRESHOLD && reply.attempt <= GROUP_JEV_MAX_RETRIES && total < GROUP_JEV_TURN_MAX_REPLIES - 1;
			console.log(`[group-jev] verify turn=${reply.turnId} reply=${reply.id} attempt=${reply.attempt} score=${score.toFixed(2)} retry=${retry}`);
			if (retry) {
				// Entra no fim da fila do turno (depois dos membros que ainda esperam).
				const last = await prisma.groupReply.findFirst({ where: { turnId: reply.turnId }, orderBy: { createdAt: "desc" }, select: { createdAt: true } });
				await prisma.groupReply.create({
					data: {
						turnId: reply.turnId,
						userId: reply.userId,
						groupId: reply.groupId,
						conversationId: reply.conversationId,
						botId: reply.botId,
						depth: reply.depth,
						reason: "assigned" satisfies GroupReplyReason,
						role: "worker",
						subtask: reply.subtask,
						attempt: reply.attempt + 1,
						triggerBotId: reply.triggerBotId ?? null,
						createdAt: new Date(Math.max(base, (last?.createdAt.getTime() ?? 0) + 1)),
					},
				});
			}
		}
	}
	await maybeQueueSummary(reply.turnId);
}

/** Quando nenhum membro está em aberto no turno, chama o coordenador uma única vez para o resumo. */
async function maybeQueueSummary(turnId: string): Promise<boolean> {
	return prisma.$transaction(async (tx) => {
		await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`group-summary:${turnId}`}))`;
		const replies = await tx.groupReply.findMany({ where: { turnId, role: { in: ["coordinator", "worker", "summary"] } }, orderBy: { createdAt: "asc" } });
		if (replies.some((row) => row.role === "summary")) return false;
		if (replies.some((row) => row.status === "pending" || row.status === "running")) return false;
		const coordinator = replies.find((row) => row.role === "coordinator");
		const workers = replies.filter((row) => row.role === "worker" && (row.status === "done" || row.status === "failed"));
		if (!coordinator || workers.length === 0) return false;
		await tx.groupReply.create({
			data: {
				turnId,
				userId: coordinator.userId,
				groupId: coordinator.groupId,
				conversationId: coordinator.conversationId,
				botId: coordinator.botId,
				depth: coordinator.depth + 2,
				reason: "summary" satisfies GroupReplyReason,
				role: "summary",
				createdAt: new Date(),
			},
		});
		console.log(`[group-jev] summary turn=${turnId} workers=${workers.length}`);
		return true;
	});
}

async function closeFinishedTurns(): Promise<void> {
	const turns = await prisma.groupTurn.findMany({ where: { status: "active" }, take: SWEEP_BATCH, select: { id: true } });
	for (const turn of turns) {
		const open = await prisma.groupReply.count({ where: { turnId: turn.id, status: { in: ["pending", "running"] } } });
		if (open > 0) continue;
		// Membro pulado (saiu do grupo) não deixa o turno sem resumo.
		if (await maybeQueueSummary(turn.id).catch(() => false)) continue;
		await prisma.groupTurn.updateMany({ where: { id: turn.id, status: "active" }, data: { status: "done" } });
	}
}

async function recoverStaleReplies(now: Date): Promise<void> {
	const before = new Date(now.getTime() - GROUP_REPLY_STALE_MS);
	await prisma.groupReply.updateMany({ where: { status: "running", runId: null, updatedAt: { lt: before } }, data: { status: "pending" } });
}

/** Reserva a próxima resposta do grupo (uma `running` por grupo, mesmo com vários workers). */
async function claimNextReply(groupId: string): Promise<{ id: string } | null> {
	return prisma.$transaction(async (tx) => {
		await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`group-reply:${groupId}`}))`;
		const running = await tx.groupReply.count({ where: { groupId, status: "running" } });
		if (running > 0) return null;
		const next = await tx.groupReply.findFirst({ where: { groupId, status: "pending" }, orderBy: { createdAt: "asc" }, select: { id: true } });
		if (!next) return null;
		const claim = await tx.groupReply.updateMany({ where: { id: next.id, status: "pending" }, data: { status: "running", startedAt: new Date() } });
		return claim.count === 1 ? next : null;
	});
}

async function startReply(replyId: string, deps: GroupDispatchDeps): Promise<"started" | "busy" | "skipped"> {
	const reply = await prisma.groupReply.findUniqueOrThrow({ where: { id: replyId } });
	const skip = (error: string) =>
		prisma.groupReply.updateMany({ where: { id: replyId, status: "running" }, data: { status: "skipped", error, finishedAt: new Date() } });
	const revert = () => prisma.groupReply.updateMany({ where: { id: replyId, status: "running" }, data: { status: "pending" } });
	try {
		const found = await getGroupWithMembers(reply.userId, reply.groupId);
		const member = found?.members.find((item) => item.id === reply.botId);
		if (!found || !member || !found.group.conversationId) {
			await skip("member_missing");
			return "skipped";
		}
		const groupConversationId = found.group.conversationId;
		if (((await (deps.activeRuns ?? listActiveRunsForConversation)(groupConversationId))).length > 0) {
			await revert();
			return "busy";
		}
		// O membro precisa da conversa própria (VM e histórico dele); senão o run a adotaria como sendo a do grupo.
		const own = await prisma.bot.findFirst({ where: { id: member.id, ownerId: reply.userId }, select: { conversationId: true } });
		await (deps.ensureConversation ?? ensureBotConversation)(member.id, reply.userId, own?.conversationId ?? null);
		const triggerName = reply.triggerBotId ? found.members.find((item) => item.id === reply.triggerBotId)?.name : null;
		let prompt = buildGroupTurnPrompt({ groupName: found.group.name, reason: reply.reason as GroupReplyReason, fromName: triggerName });
		if (reply.role === "coordinator" || reply.role === "worker" || reply.role === "summary") {
			const workerNames =
				reply.role === "summary"
					? (await prisma.groupReply.findMany({ where: { turnId: reply.turnId, role: "worker" }, orderBy: { createdAt: "asc" } }))
							.map((row) => found.members.find((item) => item.id === row.botId)?.name)
							.filter((name, index, list): name is string => Boolean(name) && list.indexOf(name) === index)
					: [];
			prompt = buildGroupRolePrompt({
				role: reply.role,
				groupName: found.group.name,
				members: found.members,
				selfId: member.id,
				coordinatorName: triggerName,
				subtask: reply.subtask,
				attempt: reply.attempt,
				workerNames,
			});
		}
		const model = await (deps.resolveModel ?? resolveBotModel)(member.id, reply.userId, deps.envDefaultModel);
		const startedAt = Date.now();
		const run = await (deps.createRun ?? createAgentRun)({
			userId: reply.userId,
			model,
			request: {
				botId: member.id,
				conversationId: groupConversationId,
				origin: "chat",
				objective: prompt,
				messages: [{ role: "user", content: prompt }],
				// A fala do usuário já está na conversa do grupo; o prompt do turno não vira mensagem.
				silent: true,
			},
		});
		// Corrida: um run ativo entrou na conversa entre a checagem e o create (o create devolve o existente).
		if (run.botId !== member.id || new Date(run.createdAt).getTime() < startedAt - 1_000) {
			await revert();
			return "busy";
		}
		await prisma.groupReply.update({ where: { id: replyId }, data: { runId: run.id } });
		await deps.enqueueRun(run.id).catch((error) => {
			console.error(`[bot-groups] enqueue failed run=${run.id}`, error);
			return false;
		});
		return "started";
	} catch (error) {
		console.error(`[bot-groups] start failed reply=${replyId}`, error);
		await revert().catch(() => undefined);
		return "busy";
	}
}

async function dispatchReplies(deps: GroupDispatchDeps): Promise<{ started: number; busy: number }> {
	const groups = await prisma.groupReply.findMany({ where: { status: "pending" }, distinct: ["groupId"], select: { groupId: true }, take: SWEEP_BATCH });
	let started = 0;
	let busy = 0;
	for (const { groupId } of groups) {
		// Respostas puladas (membro removido) não travam o grupo: tenta a próxima.
		for (let attempt = 0; attempt < 6; attempt += 1) {
			const claimed = await claimNextReply(groupId);
			if (!claimed) break;
			const outcome = await startReply(claimed.id, deps);
			if (outcome === "started") started += 1;
			if (outcome === "busy") busy += 1;
			if (outcome !== "skipped") break;
		}
	}
	return { started, busy };
}

/** Um passo do despacho de grupos (idempotente; vários workers podem rodar juntos). */
export async function processGroupTurns(deps: GroupDispatchDeps): Promise<GroupDispatchResult> {
	const now = (deps.now ?? (() => new Date()))();
	await recoverStaleReplies(now).catch((error) => console.error("[bot-groups] recover failed", error));
	const settle = await settleReplies(deps).catch((error) => (console.error("[bot-groups] settle failed", error), { settled: 0, followUps: 0 }));
	const routed = await routeTurns(deps).catch((error) => (console.error("[bot-groups] routing failed", error), 0));
	const dispatch = await dispatchReplies(deps).catch((error) => (console.error("[bot-groups] dispatch failed", error), { started: 0, busy: 0 }));
	await closeFinishedTurns().catch((error) => console.error("[bot-groups] close failed", error));
	// Erro na leitura conta como "em andamento": melhor varrer de novo logo do que dormir com trabalho aberto.
	const open = await prisma.groupTurn
		.findFirst({ where: { status: { in: ["routing", "active"] } }, select: { id: true } })
		.catch(() => ({ id: "unknown" }));
	return { routed, started: dispatch.started, settled: settle.settled, followUps: settle.followUps, busy: dispatch.busy, inFlight: open !== null };
}
