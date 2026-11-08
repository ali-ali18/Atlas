/**
 * Agenda do agente (Motor v4, F4) sobre `BotFollowup`: lembrete, vigia, intenção por evento.
 * Toda função recebe o `userId` da SESSÃO/RUN e filtra por ele na consulta (40-seguranca): outro dono não lê, não muda
 * e não encerra o item (404 na API; `null`/`false` aqui). As linhas do v2 têm `agendaKind` nulo e ficam fora daqui.
 */
import { Prisma } from "@prisma/client";
import {
	AGENDA_KINDS,
	EFFECT_CLASSES,
	AGENDA_MAX_ACTIVE_PER_OWNER,
	findDuplicateAgendaItem,
	matchEventFilter,
	nextAgendaEventWindow,
	parseAgendaEventFilter,
	planAgendaEventWake,
	planAgendaWake,
	readProactiveSettings,
	settleAgendaRun,
	settleAgendaRunWithoutResult,
	wasNoticeIgnored,
	type AgendaEvent,
	type AgendaEventFilter,
	type AgendaKind,
	type AgendaOutcome,
	type AgendaPlan,
	type AgendaStatus,
	type AgendaStopReason,
	type EffectClass,
	type ProactiveSettings,
} from "@workspace/shared";
import { prisma } from "./client.js";
import { getAccountConfig } from "./settings.js";

/** Quanto uma varredura reserva o item enquanto cria o run. */
const AGENDA_CLAIM_MS = 2 * 60_000;
/** Enquanto o run de agenda não devolve o resultado, o item volta à fila neste prazo (rede de segurança se o run morrer). */
export const AGENDA_RUN_RETRY_MS = 30 * 60_000;
const SWEEP_BATCH = 20;

export class AgendaError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AgendaError";
	}
}

/** O que o run de agenda guardou do último resultado. */
export type AgendaLastResult = {
	runId: string;
	outcome: AgendaOutcome | "missing";
	at: string;
	message?: string;
	memo?: string;
	/** O run que escreveu o memo tinha lido conteúdo não confiável: no próximo wake o memo entra como dado. */
	memoUntrusted?: boolean;
	pending?: string[];
};

/** Permissão decidida na criação: o run de agenda usa só isto (sem dono para perguntar a cada execução). */
export type AgendaGrant = { autonomy: "always_ask" | "balanced" | "autonomous"; rules: Array<{ match: string; effect?: EffectClass; verdict: "run" | "approve" | "deny" }> };

export type AgendaItemRecord = {
	id: string;
	userId: string;
	botId: string;
	conversationId: string | null;
	kind: AgendaKind;
	status: AgendaStatus;
	note: string;
	dueAt: Date;
	requestedFor: Date;
	intervalMinutes: number | null;
	untilAt: Date | null;
	maxRuns: number | null;
	runCount: number;
	eventFilter: AgendaEventFilter | null;
	noChangeStreak: number;
	ignoredStreak: number;
	/** Falhas seguidas sem `agenda_result` (coluna `attempts`). */
	missingResults: number;
	lastResult: AgendaLastResult | null;
	lastNoticeAt: Date | null;
	grant: AgendaGrant | null;
	runId: string | null;
	endReason: string | null;
	/** A nota foi escrita por um run que leu conteúdo não confiável (S1): no wake ela é dado, não instrução. */
	noteUntrusted?: boolean;
	/** Janela de 24h do `intent` (teto de acordares por dia). Ausente = janela fechada. */
	eventWindowAt?: Date | null;
	eventWindowCount?: number;
	sourceRunId: string | null;
	/** Reserva ativa (varredura criando o run, ou run de intenção em andamento). */
	reservedUntil: Date | null;
	createdAt: Date;
};

type Row = Prisma.BotFollowupGetPayload<Record<string, never>>;

/**
 * Valor das colunas JSON da agenda, tipado: só aceita os formatos que a agenda grava (filtro, permissão, último resultado),
 * então campo que não serializa (Date, undefined, função) vira erro de tipo em vez de `as unknown as` calando o compilador.
 */
const toJson = (value: AgendaEventFilter | AgendaGrant | AgendaLastResult): Prisma.InputJsonObject => value;

const isKind = (value: unknown): value is AgendaKind => (AGENDA_KINDS as readonly unknown[]).includes(value);

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function readLastResult(raw: unknown): AgendaLastResult | null {
	const r = asRecord(raw);
	if (!r || typeof r.runId !== "string" || typeof r.at !== "string") return null;
	const outcome = r.outcome === "missing" || r.outcome === "no_change" || r.outcome === "update" || r.outcome === "done" ? r.outcome : null;
	if (!outcome) return null;
	return {
		runId: r.runId,
		outcome,
		at: r.at,
		...(typeof r.message === "string" && { message: r.message }),
		...(typeof r.memo === "string" && { memo: r.memo }),
		...(r.memoUntrusted === true && { memoUntrusted: true }),
		...(Array.isArray(r.pending) && { pending: r.pending.filter((p): p is string => typeof p === "string") }),
	};
}

function readGrant(raw: unknown): AgendaGrant | null {
	const r = asRecord(raw);
	if (!r) return null;
	const autonomy = r.autonomy === "always_ask" || r.autonomy === "autonomous" ? r.autonomy : "balanced";
	const rules = Array.isArray(r.rules)
		? r.rules.flatMap((rule): AgendaGrant["rules"] => {
				const x = asRecord(rule);
				if (!x || typeof x.match !== "string") return [];
				const verdict = x.verdict;
				if (verdict !== "run" && verdict !== "approve" && verdict !== "deny") return [];
				return [{ match: x.match, verdict, ...((EFFECT_CLASSES as readonly unknown[]).includes(x.effect) && { effect: x.effect as EffectClass }) }];
			})
		: [];
	return { autonomy, rules };
}

function toRecord(row: Row): AgendaItemRecord | null {
	if (!isKind(row.agendaKind)) return null;
	const filter = row.eventFilterJson ? parseAgendaEventFilter(row.eventFilterJson) : null;
	return {
		id: row.id,
		userId: row.userId,
		botId: row.botId,
		conversationId: row.conversationId,
		kind: row.agendaKind,
		status: row.status === "done" || row.status === "cancelled" || row.status === "paused" ? row.status : "pending",
		note: row.note,
		dueAt: row.dueAt,
		requestedFor: row.requestedFor,
		intervalMinutes: row.intervalMinutes,
		untilAt: row.untilAt,
		maxRuns: row.maxRuns,
		runCount: row.runCount,
		eventFilter: filter?.ok ? filter.filter : null,
		noChangeStreak: row.noChangeStreak,
		ignoredStreak: row.ignoredStreak,
		missingResults: row.attempts,
		lastResult: readLastResult(row.lastResultJson),
		lastNoticeAt: row.lastNoticeAt,
		grant: readGrant(row.grantJson),
		runId: row.runId,
		endReason: row.endReason,
		noteUntrusted: row.noteUntrusted,
		eventWindowAt: row.eventWindowAt,
		eventWindowCount: row.eventWindowCount,
		sourceRunId: row.sourceRunId,
		reservedUntil: row.claimedUntil,
		createdAt: row.createdAt,
	};
}

const records = (rows: Row[]): AgendaItemRecord[] => rows.flatMap((row) => toRecord(row) ?? []);

/** Fuso do dono (a agenda ignora o horário de silêncio): política do bot + fuso da conta (mesma fonte do modo proativo do v2). */
export async function loadAgendaSettings(userId: string, botId: string): Promise<ProactiveSettings> {
	const bot = botId && userId.trim() && userId !== "default" ? await prisma.bot.findFirst({ where: { id: botId, ownerId: userId }, select: { policyJson: true } }) : null;
	const account = (await getAccountConfig(userId).catch(() => null))?.general?.timezone;
	return readProactiveSettings(bot?.policyJson ?? null, account);
}

const validOwner = (userId: string): boolean => userId.trim().length > 0 && userId !== "default";

export type CreateAgendaResult = { ok: true; item: AgendaItemRecord; duplicate: boolean } | { ok: false; error: string };

/**
 * Cria um item já planejado (`planAgendaItem`). Devolve o existente quando é o mesmo pedido. O limite de itens ativos por
 * dono vale aqui (servidor), seja o que o modelo pedir.
 */
export async function createAgendaItem(input: {
	userId: string;
	botId: string;
	plan: AgendaPlan;
	grant: AgendaGrant;
	sourceRunId?: string | null;
	/** O run criador já tinha lido conteúdo não confiável (`untrustedReadInRun`): a nota é guardada como contaminada. */
	untrustedRead?: boolean;
	/** O item tem identidade própria (ex.: vigia de uma compra): não passa pelo dedupe por similaridade de texto. */
	exactIdentity?: boolean;
}): Promise<CreateAgendaResult> {
	if (!validOwner(input.userId)) return { ok: false, error: "Bot não encontrado" };
	const bot = await prisma.bot.findFirst({ where: { id: input.botId, ownerId: input.userId }, select: { id: true, conversationId: true } });
	if (!bot) return { ok: false, error: "Bot não encontrado" };
	const { plan } = input;
	// Contar, deduplicar e criar na MESMA transação sob trava por dono: sem ela, criações paralelas (vários runs ou abas)
	// leem a mesma contagem e passam do teto de itens ou duplicam o mesmo pedido.
	return prisma.$transaction(async (tx) => {
		await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`agenda-create:${input.userId}`}))`;
		const active = records(await tx.botFollowup.findMany({ where: { userId: input.userId, agendaKind: { not: null }, status: { in: ["pending", "paused"] } } }));
		const same = input.exactIdentity ? undefined : findDuplicateAgendaItem(active, plan);
		if (same) return { ok: true as const, item: same, duplicate: true };
		if (active.length >= AGENDA_MAX_ACTIVE_PER_OWNER) {
			return { ok: false as const, error: `There are already ${AGENDA_MAX_ACTIVE_PER_OWNER} active agenda items. Cancel or finish one before adding another.` };
		}
		const row = await tx.botFollowup.create({
			data: {
				userId: input.userId,
				botId: bot.id,
				conversationId: bot.conversationId,
				dueAt: plan.dueAt,
				requestedFor: plan.requestedFor,
				note: plan.note,
				kind: plan.kind === "watch" || plan.kind === "intent" ? "check" : "reminder",
				source: "chat",
				sourceRunId: input.sourceRunId ?? null,
				noteUntrusted: input.untrustedRead === true,
				agendaKind: plan.kind,
				intervalMinutes: plan.intervalMinutes,
				untilAt: plan.untilAt,
				maxRuns: plan.maxRuns,
				eventFilterJson: plan.eventFilter ? toJson(plan.eventFilter) : Prisma.JsonNull,
				grantJson: toJson(input.grant),
			},
		});
		return { ok: true as const, item: toRecord(row)!, duplicate: false };
	});
}

export async function listAgendaItems(userId: string, options: { botId?: string; includeEnded?: boolean; limit?: number } = {}): Promise<AgendaItemRecord[]> {
	if (!validOwner(userId)) return [];
	const rows = await prisma.botFollowup.findMany({
		where: { userId, agendaKind: { not: null }, ...(options.botId ? { botId: options.botId } : {}), status: { in: options.includeEnded ? ["pending", "paused", "done", "cancelled"] : ["pending", "paused"] } },
		orderBy: [{ status: "asc" }, { dueAt: "asc" }],
		take: Math.min(100, options.limit ?? 50),
	});
	return records(rows);
}

/**
 * Os encerrados mais recentes (feito ou cancelado), do mais novo para o mais antigo, escopados pelo dono. Consulta própria
 * (e não `listAgendaItems` com `includeEnded`, que ordena por `dueAt` crescente e corta nos mais velhos): com mais de
 * 100 encerrados os novos não somem. Ordena por `doneAt` (instante do encerramento), com `updatedAt` de desempate.
 */
export async function listEndedAgendaItems(userId: string, options: { botId?: string; limit?: number } = {}): Promise<AgendaItemRecord[]> {
	if (!validOwner(userId)) return [];
	const rows = await prisma.botFollowup.findMany({
		where: { userId, agendaKind: { not: null }, ...(options.botId ? { botId: options.botId } : {}), status: { in: ["done", "cancelled"] } },
		orderBy: [{ doneAt: { sort: "desc", nulls: "last" } }, { updatedAt: "desc" }],
		take: Math.max(1, Math.min(100, options.limit ?? 10)),
	});
	return records(rows);
}

export async function getAgendaItem(userId: string, id: string): Promise<AgendaItemRecord | null> {
	if (!validOwner(userId)) return null;
	const row = await prisma.botFollowup.findFirst({ where: { id, userId, agendaKind: { not: null } } });
	return row ? toRecord(row) : null;
}

/** O item que este run está executando (liga o run à agenda). `null` = não é run de agenda, ou o item não é do dono. */
export async function getAgendaItemByRunId(userId: string, runId: string): Promise<AgendaItemRecord | null> {
	if (!validOwner(userId) || !runId) return null;
	const row = await prisma.botFollowup.findFirst({ where: { userId, runId, agendaKind: { not: null } } });
	return row ? toRecord(row) : null;
}

/** Um paused parado há mais que isto (cartão de aprovação sem resposta, que expira em 24h) já não segura o item. */
const PAUSED_RUN_HOLD_MS = 25 * 60 * 60_000;

/**
 * O run anterior do item ainda está vivo (na fila, rodando ou esperando o dono)? Então o item não acorda de novo: um
 * run de agenda parado num cartão não pode empilhar outro por cima.
 */
export async function isAgendaRunInFlight(userId: string, runId: string | null, now: Date): Promise<boolean> {
	if (!runId || !validOwner(userId)) return false;
	const run = await prisma.agentRun.findFirst({
		where: { id: runId, userId, OR: [{ status: { in: ["queued", "running", "retrying"] } }, { status: "paused", updatedAt: { gt: new Date(now.getTime() - PAUSED_RUN_HOLD_MS) } }] },
		select: { id: true },
	});
	return run !== null;
}

export type AgendaAction = "pause" | "resume" | "cancel";

/** Pausa, retoma ou cancela um item DO DONO. `null` = não existe, não é dele ou a ação não cabe no estado dele. */
export async function changeAgendaItem(userId: string, id: string, action: AgendaAction, now = new Date()): Promise<AgendaItemRecord | null> {
	if (!validOwner(userId)) return null;
	const from = action === "resume" ? ["paused"] : action === "pause" ? ["pending"] : ["pending", "paused"];
	const data: Prisma.BotFollowupUpdateManyMutationInput =
		action === "pause"
			? { status: "paused", claimedUntil: null }
			// Retomar é o dono voltando: zera os avisos ignorados e o espaçamento.
			: action === "resume"
				? { status: "pending", claimedUntil: null, ignoredStreak: 0, noChangeStreak: 0, attempts: 0, endReason: null }
				: { status: "cancelled", doneAt: now, claimedUntil: null, endReason: "owner" };
	const result = await prisma.botFollowup.updateMany({ where: { id, userId, agendaKind: { not: null }, status: { in: from } }, data });
	if (result.count !== 1) return null;
	return getAgendaItem(userId, id);
}

/** Reserva itens vencidos (um worker por linha, mesmo com vários processos). Só a agenda (`agendaKind` não nulo). */
export async function claimDueAgendaItems(now: Date, limit = SWEEP_BATCH): Promise<AgendaItemRecord[]> {
	const claimUntil = new Date(now.getTime() + AGENDA_CLAIM_MS);
	const rows = await prisma.$queryRaw<Row[]>`
		UPDATE "bot_followups" SET "claimedUntil" = ${claimUntil}, "updatedAt" = ${now}
		WHERE "id" IN (
			SELECT "id" FROM "bot_followups"
			WHERE "status" = 'pending' AND "agendaKind" IS NOT NULL AND "dueAt" <= ${now}
			  AND ("claimedUntil" IS NULL OR "claimedUntil" <= ${now})
			ORDER BY "dueAt" ASC
			LIMIT ${limit}
			FOR UPDATE SKIP LOCKED
		)
		RETURNING *`;
	return records(rows);
}

/**
 * Reserva UM item para acordá-lo agora (evento): compare-and-set no banco, então dois workers que recebem o mesmo evento
 * não criam dois runs. `false` = já reservado, pausado, encerrado ou de outro dono.
 */
export async function reserveAgendaItem(userId: string, id: string, now: Date): Promise<boolean> {
	if (!validOwner(userId)) return false;
	const result = await prisma.botFollowup.updateMany({
		where: { id, userId, agendaKind: { not: null }, status: "pending", OR: [{ claimedUntil: null }, { claimedUntil: { lte: now } }] },
		data: { claimedUntil: new Date(now.getTime() + AGENDA_CLAIM_MS), updatedAt: now },
	});
	return result.count === 1;
}

/** Devolve o item à fila com novo horário (conversa ocupada, falha ao criar o run). */
export async function rescheduleAgendaItem(userId: string, id: string, input: { dueAt: Date; error?: string; countAttempt?: boolean }): Promise<void> {
	await prisma.botFollowup.updateMany({
		where: { id, userId, agendaKind: { not: null }, status: "pending" },
		data: { dueAt: input.dueAt, claimedUntil: null, ...(input.countAttempt ? { attempts: { increment: 1 } } : {}), ...(input.error ? { lastError: input.error.slice(0, 300) } : {}) },
	});
}

const STOP_STATUS: Record<AgendaStopReason, "done" | "cancelled"> = { expired: "done", max_runs: "done", ignored_notices: "cancelled" };

/** Encerra por conta própria (freio estrutural). A razão fica em `endReason` para a Agenda mostrar. */
export async function stopAgendaItem(userId: string, id: string, reason: AgendaStopReason | "no_result" | "unavailable", extra: { ignoredStreak?: number; now?: Date } = {}): Promise<void> {
	const now = extra.now ?? new Date();
	await prisma.botFollowup.updateMany({
		where: { id, userId, agendaKind: { not: null }, status: { in: ["pending", "paused"] } },
		data: { status: reason === "no_result" || reason === "unavailable" ? "done" : STOP_STATUS[reason], doneAt: now, claimedUntil: null, endReason: reason, ...(extra.ignoredStreak !== undefined ? { ignoredStreak: extra.ignoredStreak } : {}) },
	});
}

/** Sinais de "o dono viu o aviso?": leitura da conversa e última fala do dono nela (ambos do próprio dono). */
export async function loadNoticeSignals(userId: string, conversationId: string): Promise<{ lastReadAt: Date | null; lastOwnerMessageAt: Date | null }> {
	if (!validOwner(userId)) return { lastReadAt: null, lastOwnerMessageAt: null };
	const [read, lastOwner] = await Promise.all([
		prisma.conversationRead.findUnique({ where: { userId_conversationId: { userId, conversationId } }, select: { lastReadAt: true } }),
		prisma.conversationMessage.findFirst({ where: { conversationId, role: "user", origin: null, conversation: { userId } }, orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
	]);
	return { lastReadAt: read?.lastReadAt ?? null, lastOwnerMessageAt: lastOwner?.createdAt ?? null };
}

export type AgendaWakeDecision =
	| { action: "run"; item: AgendaItemRecord }
	| { action: "stop"; reason: AgendaStopReason };

/**
 * Passo de decisão antes de gastar um run: avalia o aviso anterior (lido ou ignorado), aplica os freios
 * (`planAgendaWake`) e já persiste o que mudou (parada ou a contagem de ignorados). Não há adiamento por horário.
 */
export async function decideAgendaWake(item: AgendaItemRecord, now: Date, settings: ProactiveSettings): Promise<AgendaWakeDecision> {
	let noticeIgnored: boolean | null = null;
	if (item.lastNoticeAt && item.conversationId) {
		const signals = await loadNoticeSignals(item.userId, item.conversationId);
		noticeIgnored = wasNoticeIgnored({ noticeAt: item.lastNoticeAt, ...signals });
	}
	const plan = planAgendaWake({ item, now, settings, noticeIgnored });
	if (plan.action === "stop") {
		await stopAgendaItem(item.userId, item.id, plan.reason, { ignoredStreak: plan.ignoredStreak, now });
		return { action: "stop", reason: plan.reason };
	}
	return { action: "run", item: { ...item, ignoredStreak: plan.ignoredStreak, lastNoticeAt: null } };
}

/**
 * O run de agenda foi criado: conta a execução, guarda o run e deixa o item na fila para daqui a pouco (se o run morrer sem
 * resultado ele volta; `recordAgendaResult`/`finalizeAgendaRun` fixam o horário certo).
 */
export async function beginAgendaRun(item: AgendaItemRecord, runId: string, now: Date): Promise<void> {
	// Intenção por evento gasta um acordar da janela de 24h (teto diário por item).
	const window = item.kind === "intent" ? nextAgendaEventWindow({ windowStartAt: item.eventWindowAt ?? null, windowCount: item.eventWindowCount ?? 0 }, now) : null;
	await prisma.botFollowup.updateMany({
		where: { id: item.id, userId: item.userId, agendaKind: { not: null }, status: "pending" },
		data: {
			runId,
			runCount: { increment: 1 },
			ignoredStreak: item.ignoredStreak,
			lastNoticeAt: null,
			...(window && { eventWindowAt: window.windowStartAt, eventWindowCount: window.windowCount }),
			// Relógio: volta à fila neste prazo se o run morrer. Intenção por evento não tem relógio: só reserva o item.
			...(item.kind === "intent" ? { claimedUntil: new Date(now.getTime() + AGENDA_RUN_RETRY_MS) } : { dueAt: new Date(now.getTime() + AGENDA_RUN_RETRY_MS), claimedUntil: null }),
			lastError: null,
		},
	});
}

/**
 * O run de agenda NÃO chegou a executar (motor não é o v4, contexto do item não carregou): devolve o item à fila sem
 * consumir a execução. `runCount` volta, o vínculo com o run e a reserva são soltos, e o horário passa a `dueAt`
 * (intenção por evento não tem relógio: o `dueAt` dela é o fim da vigência e não muda). Só mexe no item pendente deste run
 * e deste dono. Devolve quantos itens voltaram (0 = nada a fazer, ex.: já fechado ou de outro dono).
 */
export async function releaseAgendaRun(input: { userId: string; runId: string; dueAt: Date; error: string }): Promise<number> {
	if (!validOwner(input.userId) || !input.runId) return 0;
	const base = { userId: input.userId, runId: input.runId, status: "pending", runCount: { gt: 0 } } as const;
	const data = { runCount: { decrement: 1 }, runId: null, claimedUntil: null, lastError: input.error.slice(0, 300) };
	// Intenção: o run devolvido sem executar também devolve a vaga do teto diário (`beginAgendaRun` a gastou).
	const intentWithSlot = await prisma.botFollowup.updateMany({ where: { ...base, agendaKind: "intent", eventWindowCount: { gt: 0 } }, data: { ...data, eventWindowCount: { decrement: 1 } } });
	const intentNoSlot = await prisma.botFollowup.updateMany({ where: { ...base, agendaKind: "intent", eventWindowCount: 0 }, data });
	const intent = { count: intentWithSlot.count + intentNoSlot.count };
	const clock = await prisma.botFollowup.updateMany({ where: { ...base, AND: [{ agendaKind: { not: null } }, { agendaKind: { not: "intent" } }] }, data: { ...data, dueAt: input.dueAt } });
	return intent.count + clock.count;
}

export type RecordAgendaResultInput = {
	userId: string;
	runId: string;
	outcome: AgendaOutcome;
	message?: string;
	memo?: string;
	pending?: string[];
	/** O run do resultado tinha lido conteúdo não confiável: o memo é guardado como contaminado. */
	untrustedRead?: boolean;
	now?: Date;
};

export type RecordAgendaResultOutput = { ok: true; item: AgendaItemRecord; duplicate: boolean } | { ok: false; error: string };

/**
 * `agenda_result` do run: guarda o resultado e aplica o efeito no item (espaçamento, encerramento). Só vale para o item
 * cujo run atual é este E que é do dono: outro dono, outro run ou item já encerrado = erro.
 */
export async function recordAgendaResult(input: RecordAgendaResultInput): Promise<RecordAgendaResultOutput> {
	if (!validOwner(input.userId)) return { ok: false, error: "No agenda item is attached to this run." };
	const row = await prisma.botFollowup.findFirst({ where: { userId: input.userId, runId: input.runId, agendaKind: { not: null } } });
	const item = row ? toRecord(row) : null;
	if (!item) return { ok: false, error: "No agenda item is attached to this run." };
	if (item.lastResult?.runId === input.runId) return { ok: true, item, duplicate: true };
	if (item.status !== "pending") return { ok: false, error: "This agenda item is no longer active." };
	const now = input.now ?? new Date();
	const settings = await loadAgendaSettings(item.userId, item.botId);
	const settled = settleAgendaRun({ item, outcome: input.outcome, hasMessage: Boolean(input.message?.trim()), now, settings });
	const lastResult: AgendaLastResult = {
		runId: input.runId,
		outcome: input.outcome,
		at: now.toISOString(),
		...(input.message?.trim() && input.outcome !== "no_change" && { message: input.message.trim() }),
		...(input.memo?.trim() && { memo: input.memo.trim(), ...(input.untrustedRead === true && { memoUntrusted: true }) }),
		...(input.pending && input.pending.length > 0 && { pending: input.pending }),
	};
	// Compare-and-set pelo run: duas entregas do mesmo resultado não aplicam o espaçamento duas vezes.
	const updated = await prisma.botFollowup.updateMany({
		where: { id: item.id, userId: item.userId, runId: input.runId, status: "pending" },
		data: {
			status: settled.status,
			noChangeStreak: settled.noChangeStreak,
			attempts: 0,
			lastError: null,
			lastResultJson: toJson(lastResult),
			claimedUntil: null,
			...(settled.dueAt ? { dueAt: settled.dueAt } : { doneAt: now, endReason: settled.endReason }),
		},
	});
	if (updated.count !== 1) return { ok: false, error: "This agenda item is no longer active." };
	return { ok: true, item: (await getAgendaItem(input.userId, item.id)) ?? item, duplicate: false };
}

export type FinalizeAgendaRunResult =
	| { agenda: false }
	| {
			agenda: true;
			itemId: string;
			/** O que vai para a conversa. Vazio = nada (run silencioso). */
			text: string;
			/** Encerrou sem nenhum `agenda_result` três vezes seguidas: o dono merece UM aviso (o texto monta o worker). */
			stoppedWithoutResult: boolean;
			/**
			 * Lembrete que não devolveu resultado nem texto depois de várias tentativas: o dono recebe a PRÓPRIA nota
			 * (o worker monta o texto com `copyFor(language, "agenda_reminder_note", { note })`). Nunca some calado.
			 */
			deliverNote?: boolean;
			note: string;
	  };

/**
 * Fecha o run de agenda ANTES da conclusão do processador: decide o que entra na conversa. Com `agenda_result` vale o que
 * ele disse (no_change = nada; update/done = a mensagem declarada). Sem ele, ver `settleAgendaRunWithoutResult`. Marca
 * `lastNoticeAt` quando algo foi dito (base de "aviso ignorado"). Idempotente por run (reentrega não duplica o efeito).
 */
export async function finalizeAgendaRun(input: { userId: string; runId: string; text: string; now?: Date }): Promise<FinalizeAgendaRunResult> {
	if (!validOwner(input.userId)) return { agenda: false };
	const row = await prisma.botFollowup.findFirst({ where: { userId: input.userId, runId: input.runId, agendaKind: { not: null } } });
	const item = row ? toRecord(row) : null;
	if (!item) return { agenda: false };
	const now = input.now ?? new Date();
	const result = item.lastResult?.runId === input.runId ? item.lastResult : null;
	if (result && result.outcome !== "missing") {
		const text = result.outcome === "no_change" ? "" : (result.message ?? "");
		if (text) await markNotice(item, now);
		return { agenda: true, itemId: item.id, text, stoppedWithoutResult: false, deliverNote: false, note: item.note };
	}
	if (result?.outcome === "missing") return { agenda: true, itemId: item.id, text: item.status === "pending" ? "" : input.text.trim(), stoppedWithoutResult: item.endReason === "no_result", deliverNote: item.endReason === "reminder_note", note: item.note };
	if (item.status !== "pending") return { agenda: true, itemId: item.id, text: "", stoppedWithoutResult: false, deliverNote: false, note: item.note };
	const settings = await loadAgendaSettings(item.userId, item.botId);
	const settled = settleAgendaRunWithoutResult({ item, hasText: input.text.trim().length > 0, now, settings });
	const lastResult: AgendaLastResult = { runId: input.runId, outcome: "missing", at: now.toISOString() };
	const updated = await prisma.botFollowup.updateMany({
		where: { id: item.id, userId: item.userId, runId: input.runId, status: "pending" },
		data: {
			status: settled.status,
			noChangeStreak: settled.noChangeStreak,
			attempts: settled.missingResults,
			lastError: item.kind === "remind" && input.text.trim() ? null : "run ended without agenda_result",
			lastResultJson: toJson(lastResult),
			claimedUntil: null,
			...(settled.dueAt ? { dueAt: settled.dueAt } : { doneAt: now, endReason: settled.endReason }),
		},
	});
	if (updated.count !== 1) return { agenda: true, itemId: item.id, text: "", stoppedWithoutResult: false, deliverNote: false, note: item.note };
	const stoppedWithoutResult = settled.endReason === "no_result";
	const deliverNote = settled.deliverNote === true;
	const text = settled.post && item.kind === "remind" ? input.text.trim() : "";
	if (text || stoppedWithoutResult || deliverNote) await markNotice(item, now);
	return { agenda: true, itemId: item.id, text, stoppedWithoutResult, deliverNote, note: item.note };
}

async function markNotice(item: AgendaItemRecord, now: Date): Promise<void> {
	await prisma.botFollowup.updateMany({ where: { id: item.id, userId: item.userId, agendaKind: { not: null } }, data: { lastNoticeAt: now } });
}

/** Itens `intent` do dono que o evento acorda (filtro estrutural) e já passaram do intervalo mínimo entre acordares. */
export async function findAgendaItemsForEvent(userId: string, event: AgendaEvent, now: Date, minGapMinutes: number, options: { botId?: string } = {}): Promise<{ matched: AgendaItemRecord[]; coalesced: AgendaItemRecord[] }> {
	if (!validOwner(userId)) return { matched: [], coalesced: [] };
	// `botId` (e-mail da caixa de UM bot): a intenção de outro bot do mesmo dono lê a caixa dele, não esta.
	const rows = await prisma.botFollowup.findMany({ where: { userId, agendaKind: "intent", status: "pending", ...(options.botId && { botId: options.botId }), OR: [{ untilAt: null }, { untilAt: { gt: now } }] } });
	const hits = records(rows).filter((item) => item.eventFilter !== null && matchEventFilter(item.eventFilter, event));
	const matched: AgendaItemRecord[] = [];
	const coalesced: AgendaItemRecord[] = [];
	for (const item of hits) {
		// Run em andamento (reserva ativa), acordou há pouco ou gastou o teto do dia: o evento é juntado, e o próximo run lê o que chegou.
		const busy = item.reservedUntil !== null && item.reservedUntil.getTime() > now.getTime();
		const verdict = planAgendaEventWake({ now, lastWakeAt: item.lastResult ? new Date(item.lastResult.at) : null, minGapMinutes, window: { windowStartAt: item.eventWindowAt ?? null, windowCount: item.eventWindowCount ?? 0 } });
		(busy || verdict !== "wake" ? coalesced : matched).push(item);
	}
	return { matched, coalesced };
}

/** Marca de "tem evento esperando" num item de intenção (`endReason`). A varredura do worker acorda o item quando livre. */
export const AGENDA_EVENT_PENDING = "event_pending";

/** Marca o item de intenção do dono como "tem evento esperando". `false` = não era item `intent` pendente dele. */
export async function markAgendaEventPending(userId: string, id: string): Promise<boolean> {
	if (!validOwner(userId)) return false;
	const result = await prisma.botFollowup.updateMany({ where: { id, userId, agendaKind: "intent", status: "pending" }, data: { endReason: AGENDA_EVENT_PENDING } });
	return result.count === 1;
}

/**
 * Um e-mail chegou na caixa do bot (F7.1): marca as intenções PENDENTES do dono, daquele bot, cujo filtro estrutural casa. Não
 * cria run: a varredura do worker (`claimPendingEventItems`) acorda cada item quando o anterior terminou, respeitando o
 * espaçamento mínimo e o teto diário (`planAgendaEventWake`), então vale em várias instâncias e sem perder o evento. O run lê a
 * caixa; a marca não guarda o conteúdo do e-mail.
 */
export async function queueAgendaEventWakes(input: { userId: string; botId: string; event: AgendaEvent; now: Date; minGapMinutes: number }): Promise<{ marked: number }> {
	const { matched, coalesced } = await findAgendaItemsForEvent(input.userId, input.event, input.now, input.minGapMinutes, { botId: input.botId });
	let marked = 0;
	for (const item of [...matched, ...coalesced]) if (await markAgendaEventPending(item.userId, item.id)) marked += 1;
	return { marked };
}
