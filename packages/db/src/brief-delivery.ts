import { BRIEF_FAILURE_LINE, DAILY_BRIEF_TEMPLATE, parseRoutineNotifyMode, type RoutineNotifyMode } from "@workspace/shared";
import { prisma } from "./client.js";
import { appendConversationMessage } from "./conversations.js";
import { ownerIds } from "./mcp-connections.js";

/**
 * Entrega do brief "Seu dia" como mensagem. O estado vive em colunas próprias de `RoutineRun`
 * (`briefStatus` pending | posted | expired e `briefText` enquanto pendente). Todos os filtros são de coluna
 * simples (`= 'pending'`, `IS NULL`), sem JSON: nenhuma semântica de NULL escondida.
 *
 * A mensagem entra com id determinístico (`briefMessageId`), então gravar duas vezes é inofensivo: o fluxo é
 * "insere a mensagem, depois marca postado". Queda entre os dois passos = a próxima varredura vê a mensagem
 * existente e só marca. Não há reivindicação antes da gravação.
 *
 * Funções por brief recebem o dono (rule 40) e filtram por `routine.userId`. As duas de varredura
 * (`listPendingBriefs`, `expireStaleBriefs`) são do sistema: devolvem o dono de cada linha para o worker agir
 * escopado por ele.
 */

/** Brief pendente há mais que isto já não é "o seu dia" de hoje: expira (não fica pendente para sempre). */
export const PENDING_MAX_AGE_MS = 12 * 60 * 60_000;
/** Run que acabou de terminar na conversa: espera um instante para um follow-up encadeado começar. */
export const BRIEF_CALM_MARGIN_MS = 5_000;

const BUSY_STATUSES = ["queued", "running", "retrying"];

/** Run concluído com `briefStatus` NULL só é recuperado depois disto (o caminho normal do worker ainda pode estar gravando). */
export const BRIEF_RECOVERY_GRACE_MS = 30_000;
/** Tamanho da página da varredura de pendentes (a varredura percorre todas, com cursor). */
export const PENDING_PAGE_SIZE = 50;
const RECOVERY_BATCH = 200;

export type PendingBrief = {
	routineRunId: string;
	userId: string;
	botId: string;
	text: string;
	/** O push do brief já foi reivindicado/enviado. */
	pushed: boolean;
	notify: RoutineNotifyMode;
};

/**
 * "replace": sai de "sem estado" ou "pendente" (o brief de verdade troca a linha de falha ainda pendente).
 * "ifUnset": só de "sem estado" (a linha de falha nunca sobrescreve um brief pendente nem trava o de verdade).
 */
export type MarkPendingMode = "replace" | "ifUnset";

/** Id da mensagem do brief: um por execução da rotina. */
export const briefMessageId = (routineRunId: string): string => `brief-${routineRunId}`;

const ownedRun = (userId: string, routineRunId: string) => ({ id: routineRunId, routine: { userId: { in: ownerIds(userId) } } });

/** Guarda o texto como pendente. Postado/expirado não volta (ver `MarkPendingMode`). `false` = não marcou. */
export async function markBriefPending(userId: string, routineRunId: string, text: string, mode: MarkPendingMode = "replace"): Promise<boolean> {
	const result = await prisma.routineRun.updateMany({
		where: { ...ownedRun(userId, routineRunId), ...(mode === "ifUnset" ? { briefStatus: null } : { OR: [{ briefStatus: null }, { briefStatus: "pending" }] }) },
		data: { briefStatus: "pending", briefText: text },
	});
	return result.count === 1;
}

/** Pendente -> postado (limpa o texto). `false` = já não estava pendente (outro caminho marcou). */
export async function markBriefPosted(userId: string, routineRunId: string): Promise<boolean> {
	const result = await prisma.routineRun.updateMany({
		where: { ...ownedRun(userId, routineRunId), briefStatus: "pending" },
		data: { briefStatus: "posted", briefText: null },
	});
	return result.count === 1;
}

/** Pendente -> expirado (limpa o texto): brief que nunca vai entrar (ex.: o bot não tem conversa). */
export async function markBriefExpired(userId: string, routineRunId: string): Promise<boolean> {
	const result = await prisma.routineRun.updateMany({
		where: { ...ownedRun(userId, routineRunId), briefStatus: "pending" },
		data: { briefStatus: "expired", briefText: null },
	});
	return result.count === 1;
}

/** Reivindica o push do brief (uma vez só: quem vence envia). `false` = já reivindicado. */
export async function claimBriefPush(userId: string, routineRunId: string, now: Date = new Date()): Promise<boolean> {
	const result = await prisma.routineRun.updateMany({
		where: { ...ownedRun(userId, routineRunId), briefPushedAt: null },
		data: { briefPushedAt: now },
	});
	return result.count === 1;
}

/** Devolve a reivindicação quando o envio do push falhou, para a varredura tentar de novo. */
export async function releaseBriefPush(userId: string, routineRunId: string): Promise<void> {
	await prisma.routineRun.updateMany({ where: ownedRun(userId, routineRunId), data: { briefPushedAt: null } });
}

/**
 * Grava a mensagem do brief na conversa do bot, uma vez só. A conversa e a execução têm de ser do dono.
 * "exists" = a mensagem já estava lá (queda anterior ou outro caminho), nada foi duplicado.
 */
export async function appendBriefMessage(
	userId: string,
	conversationId: string,
	routineRunId: string | null,
	text: string,
): Promise<"created" | "exists"> {
	const owners = ownerIds(userId);
	const conversation = await prisma.conversation.findFirst({ where: { id: conversationId, userId: { in: owners } }, select: { id: true } });
	if (!conversation) throw new Error("Conversation not found");
	if (!routineRunId) {
		await appendConversationMessage(conversationId, "assistant", text, "routine");
		return "created";
	}
	const run = await prisma.routineRun.findFirst({ where: ownedRun(userId, routineRunId), select: { id: true } });
	if (!run) throw new Error("Routine run not found");
	try {
		await appendConversationMessage(conversationId, "assistant", text, "routine", undefined, { id: briefMessageId(routineRunId) });
		return "created";
	} catch (error) {
		if ((error as { code?: unknown } | null)?.code === "P2002") return "exists";
		throw error;
	}
}

/**
 * A conversa está ocupada para o brief? Só run que de fato escreve nela conta (na fila, rodando, tentando de
 * novo); `waiting_user` e `paused` não seguram o brief. Run que acabou há poucos segundos também conta: dá
 * tempo de um follow-up encadeado começar antes do brief entrar (a próxima varredura posta).
 */
export async function isConversationBusyForBrief(conversationId: string, now: Date = new Date()): Promise<boolean> {
	const row = await prisma.agentRun.findFirst({
		where: {
			conversationId,
			OR: [{ status: { in: BUSY_STATUSES } }, { finishedAt: { gte: new Date(now.getTime() - BRIEF_CALM_MARGIN_MS) } }],
		},
		select: { id: true },
	});
	return row !== null;
}

/**
 * Briefs pendentes recentes, mais antigos primeiro (consulta indexada por `briefStatus`). Paginado por cursor
 * (`afterId` = último `routineRunId` da página anterior): linhas travadas não escondem as seguintes.
 */
export async function listPendingBriefs(now: Date = new Date(), limit = PENDING_PAGE_SIZE, afterId?: string): Promise<PendingBrief[]> {
	const rows = await prisma.routineRun.findMany({
		where: {
			briefStatus: "pending",
			createdAt: { gte: new Date(now.getTime() - PENDING_MAX_AGE_MS) },
			routine: { template: DAILY_BRIEF_TEMPLATE },
		},
		orderBy: [{ createdAt: "asc" }, { id: "asc" }],
		take: limit,
		...(afterId ? { cursor: { id: afterId }, skip: 1 } : {}),
		select: { id: true, briefText: true, briefPushedAt: true, routine: { select: { userId: true, botId: true, notify: true } } },
	});
	const pending: PendingBrief[] = [];
	for (const row of rows) {
		if (!row.briefText?.trim()) continue;
		pending.push({
			routineRunId: row.id,
			userId: row.routine.userId,
			botId: row.routine.botId,
			text: row.briefText,
			pushed: row.briefPushedAt !== null,
			notify: parseRoutineNotifyMode(row.routine.notify),
		});
	}
	return pending;
}

/**
 * Run do brief (últimas 12 h) que o worker não chegou a guardar: `briefStatus` NULL.
 * - Terminou bem: guarda o `resultText` do run como pendente (a linha de falha se vier vazio).
 * - Terminou como falha (erro, orçamento, limite de recuperação de lease, run fantasma, queda do worker): guarda
 *   a linha fixa `BRIEF_FAILURE_LINE`. O aviso de falha (`routine-failed`) já saiu, então o push da varredura
 *   não repete: ela só publica a linha no chat.
 * Sempre só de NULL (nunca sobrescreve). O dono vem da rotina. Devolve quantos recuperou.
 */
export async function recoverUnstartedBriefs(now: Date = new Date()): Promise<number> {
	const common = {
		briefStatus: null,
		createdAt: { gte: new Date(now.getTime() - PENDING_MAX_AGE_MS) },
		finishedAt: { lte: new Date(now.getTime() - BRIEF_RECOVERY_GRACE_MS) },
		routine: { template: DAILY_BRIEF_TEMPLATE },
	};
	const rows = await prisma.routineRun.findMany({
		where: { OR: [{ ...common, status: "succeeded", agentRun: { status: "completed" } }, { ...common, status: "failed" }] },
		orderBy: [{ createdAt: "asc" }, { id: "asc" }],
		take: RECOVERY_BATCH,
		select: { id: true, status: true, routine: { select: { userId: true } }, agentRun: { select: { userId: true, resultText: true } } },
	});
	let recovered = 0;
	for (const row of rows) {
		if (row.agentRun && !ownerIds(row.routine.userId).includes(row.agentRun.userId)) continue;
		if (row.status === "succeeded" && !row.agentRun) continue;
		const text = row.status === "failed" ? BRIEF_FAILURE_LINE : row.agentRun?.resultText?.trim() || BRIEF_FAILURE_LINE;
		if (await markBriefPending(row.routine.userId, row.id, text, "ifUnset")) recovered += 1;
	}
	return recovered;
}

/** Brief pendente além do limite vira `expired` e perde o texto. Devolve quantos expiraram (o worker registra). */
export async function expireStaleBriefs(now: Date = new Date()): Promise<number> {
	const result = await prisma.routineRun.updateMany({
		where: { briefStatus: "pending", createdAt: { lt: new Date(now.getTime() - PENDING_MAX_AGE_MS) } },
		data: { briefStatus: "expired", briefText: null },
	});
	return result.count;
}
