import { BRIEF_AUTO_WINDOW_DAYS, BRIEF_NOTICE_SHOWN_KEY, BRIEF_OPT_OUT_KEY, DAILY_BRIEF_TEMPLATE } from "@workspace/shared";
import { prisma } from "./client.js";

/**
 * Estado do "Seu dia" ligado por padrão, guardado no `policyJson` do bot principal (sem migration):
 * `briefOptOut` (o usuário pausou/apagou/recusou: nunca mais é recriado sozinho) e `briefNoticeShown`
 * (a linha de aviso do 1º brief automático já saiu). A escrita é um merge atômico de uma chave só no jsonb,
 * para não pisar em outras chaves do policyJson que outra tela esteja gravando ao mesmo tempo.
 * Tudo filtra pelo dono (rule 40).
 */

async function setPolicyFlag(userId: string, botId: string, key: string): Promise<number> {
	if (!userId.trim() || userId === "default" || !botId.trim()) return 0;
	return prisma.$executeRaw`
		UPDATE "bots"
		SET "policyJson" = (CASE WHEN jsonb_typeof("policyJson") = 'object' THEN "policyJson" ELSE '{}'::jsonb END) || jsonb_build_object(${key}::text, true)
		WHERE "id" = ${botId} AND "ownerId" = ${userId}
	`;
}

/**
 * O usuário pausou, apagou ou recusou o brief: não recriar sozinho. Idempotente. LANÇA se não gravar: quem chama
 * grava o opt-out ANTES de pausar/apagar, então a falha aborta a ação (nada muda, o usuário tenta de novo) em vez
 * de deixar o brief voltar sozinho no dia seguinte.
 */
export async function markBriefOptOut(userId: string, botId: string): Promise<void> {
	await setPolicyFlag(userId, botId, BRIEF_OPT_OUT_KEY);
}

/**
 * Reivindica o aviso do 1º brief automático: `true` uma única vez por bot, e só para a rotina criada pelo bot
 * (`createdBy: "bot"`) deste dono. O brief que o usuário pediu não leva aviso.
 */
export async function claimBriefNotice(userId: string, routineRunId: string): Promise<boolean> {
	if (!userId.trim() || userId === "default") return false;
	const run = await prisma.routineRun.findFirst({
		where: { id: routineRunId, routine: { userId, template: DAILY_BRIEF_TEMPLATE, createdBy: "bot" } },
		select: { routine: { select: { botId: true } } },
	});
	const botId = run?.routine.botId;
	if (!botId) return false;
	const claimed = await prisma.$executeRaw`
		UPDATE "bots"
		SET "policyJson" = (CASE WHEN jsonb_typeof("policyJson") = 'object' THEN "policyJson" ELSE '{}'::jsonb END) || jsonb_build_object(${BRIEF_NOTICE_SHOWN_KEY}::text, true)
		WHERE "id" = ${botId} AND "ownerId" = ${userId} AND COALESCE("policyJson" ->> ${BRIEF_NOTICE_SHOWN_KEY}, '') <> 'true'
	`;
	return claimed === 1;
}

/** Devolve o aviso quando o brief não pôde ser guardado (o próximo brief automático o leva). */
export async function releaseBriefNotice(userId: string, routineRunId: string): Promise<void> {
	const run = await prisma.routineRun.findFirst({
		where: { id: routineRunId, routine: { userId, template: DAILY_BRIEF_TEMPLATE, createdBy: "bot" } },
		select: { routine: { select: { botId: true } } },
	});
	const botId = run?.routine.botId;
	if (!botId) return;
	await prisma.$executeRaw`
		UPDATE "bots" SET "policyJson" = "policyJson" - ${BRIEF_NOTICE_SHOWN_KEY}::text
		WHERE "id" = ${botId} AND "ownerId" = ${userId} AND jsonb_typeof("policyJson") = 'object'
	`;
}

export type AutoBriefCandidate = { id: string; ownerId: string; conversationId: string | null; policyJson: unknown };

/** Bots principais (de um dono real) que ainda NÃO têm rotina "Seu dia". O filtro de opt-out/proativo é do chamador (função pura). */
export async function listAutoBriefCandidates(): Promise<AutoBriefCandidate[]> {
	const rows = await prisma.bot.findMany({
		where: { isPrimary: true, ownerId: { not: null }, routines: { none: { template: DAILY_BRIEF_TEMPLATE } } },
		select: { id: true, ownerId: true, conversationId: true, policyJson: true },
	});
	return rows.flatMap((row) => (row.ownerId && row.ownerId !== "default" ? [{ ...row, ownerId: row.ownerId }] : []));
}

export type AutoBriefSignals = {
	/** Instantes das mensagens do usuário na conversa do bot, últimos 14 dias. */
	userMessageAts: Date[];
	/** Há algo do usuário para o bot mencionar (follow-up pendente ou rotina sua ativa)? */
	hasPendingWork: boolean;
};

/** Sinais baratos (3 consultas indexadas, sem modelo) para decidir se e quando ligar o brief deste bot. */
export async function loadAutoBriefSignals(input: { userId: string; botId: string; conversationId: string | null; now: Date }): Promise<AutoBriefSignals> {
	const { userId, botId, conversationId, now } = input;
	const since = new Date(now.getTime() - BRIEF_AUTO_WINDOW_DAYS * 24 * 60 * 60 * 1000);
	const [messages, followups, routines] = await Promise.all([
		conversationId
			? prisma.conversationMessage.findMany({
					where: { conversationId, conversation: { userId }, role: "user", origin: null, createdAt: { gte: since, lte: now } },
					select: { createdAt: true },
					orderBy: { createdAt: "asc" },
					take: 5000,
				})
			: Promise.resolve([]),
		prisma.botFollowup.count({ where: { userId, botId, status: "pending" } }),
		prisma.routine.count({ where: { userId, botId, enabled: true, OR: [{ template: null }, { template: { not: DAILY_BRIEF_TEMPLATE } }] } }),
	]);
	return { userMessageAts: messages.map((row) => row.createdAt), hasPendingWork: followups > 0 || routines > 0 };
}

/**
 * Exclusão mútua por bot entre instâncias do worker (advisory lock de transação): duas varreduras simultâneas
 * não criam dois "Seu dia". O lock vale enquanto `fn` roda; `fn` usa as conexões normais.
 */
export async function withBriefAutoLock<T>(botId: string, fn: () => Promise<T>): Promise<T> {
	return prisma.$transaction(
		async (tx) => {
			await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`brief-auto:${botId}`}))`;
			return fn();
		},
		{ maxWait: 10_000, timeout: 60_000 },
	);
}
