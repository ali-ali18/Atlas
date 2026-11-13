/**
 * Pedidos do motor v4 que esperam o dono (F2.6): aprovação, handoff e a resposta a cartões de pergunta (`ask_owner`),
 * mais o histórico da conversa e a proveniência herdada entre runs. Tabela nova (`agent_v4_requests`, migration
 * aditiva); o checkpoint continua em `checkpointJson.v4`.
 *
 * Toda função recebe o `userId` do RUN ou da SESSÃO (nunca de body, query ou modelo) e filtra por ele (`ownerIds`):
 * recurso de outro dono é "não encontrado". A decisão do dono é uma transição de estado atômica (`pending` → decidido),
 * então dois cliques ou duas abas nunca decidem o mesmo pedido de formas diferentes.
 */
import { prisma } from "./client.js";
import { ResourceOwnershipError } from "./conversations.js";
import { ownerIds } from "./mcp-connections.js";

/** Prazo padrão para o dono responder um pedido (aprovação ou handoff); passado dele o pedido vira `expired`. */
export const AGENT_V4_REQUEST_TTL_MS = 24 * 60 * 60 * 1000;
/** Teto técnico de leitura do histórico por run (não é economia: a compactação do kernel cuida da janela). */
export const AGENT_V4_HISTORY_MAX = 1000;

const LABEL_MAX = 500;

export type AgentV4RequestKind = "approval" | "handoff" | "card";
export type AgentV4RequestState = "pending" | "approved" | "denied" | "done" | "expired" | "answered" | "dismissed";

/** Decisão do dono sobre um pedido de aprovação ou handoff. */
export type AgentV4Decision = "approve" | "deny" | "handoff_done";
const DECISION_STATE = { approve: "approved", deny: "denied", handoff_done: "done" } as const satisfies Record<AgentV4Decision, AgentV4RequestState>;
/** Decisões que cada tipo aceita (aprovação: aprovar ou "Agora não"; handoff: só "feito"). */
const KIND_DECISIONS = { approval: ["approve", "deny"], handoff: ["handoff_done"] } as const satisfies Record<"approval" | "handoff", readonly AgentV4Decision[]>;

const owned = (userId: string): boolean => ownerIds(userId).length > 0;

export type AgentV4RequestInput = { kind: "approval" | "handoff"; key: string; callId: string; toolName?: string; payloadHash?: string };

/**
 * Registra os pedidos que o run acabou de estacionar (idempotente: o mesmo `(run, tipo, chave)` não duplica nem reabre
 * um pedido já decidido). O run precisa ser do dono. O prazo conta da primeira vez em que o pedido foi registrado.
 */
export async function registerAgentV4Requests(userId: string, runId: string, conversationId: string | null, items: readonly AgentV4RequestInput[], now: Date, ttlMs = AGENT_V4_REQUEST_TTL_MS): Promise<void> {
	if (!owned(userId)) throw new ResourceOwnershipError();
	if (items.length === 0) return;
	if (!(await prisma.agentRun.findFirst({ where: { id: runId, userId }, select: { id: true } }))) throw new ResourceOwnershipError();
	const expiresAt = new Date(now.getTime() + ttlMs);
	await prisma.agentV4Request.createMany({
		data: items.map((item) => {
			if (item.key.length === 0 || item.key.length > LABEL_MAX) throw new RangeError("chave do pedido inválida");
			if (item.kind === "approval" && !item.payloadHash) throw new RangeError("pedido de aprovação sem hash dos argumentos");
			return { userId, runId, conversationId, kind: item.kind, key: item.key, callId: item.callId, toolName: item.toolName ?? null, payloadHash: item.payloadHash ?? null, state: "pending", expiresAt };
		}),
		skipDuplicates: true,
	});
}

export type AgentV4RequestView = { runId: string; kind: "approval" | "handoff"; key: string; callId: string | null; toolName: string | null; state: AgentV4RequestState; expiresAt: Date | null };

export type DecideOutcome =
	/** Decisão gravada agora. */
	| { status: "recorded"; request: AgentV4RequestView }
	/** O mesmo pedido já tinha exatamente esta decisão (cliques repetidos): nada muda. */
	| { status: "already"; request: AgentV4RequestView }
	/** O pedido já tem outra decisão. */
	| { status: "conflict"; request: AgentV4RequestView }
	/** Passou do prazo sem resposta (o pedido passa a `expired`). */
	| { status: "expired"; request: AgentV4RequestView }
	/** Não existe para este dono (inclui o de outro dono). */
	| { status: "not_found" }
	/** A decisão não vale para este tipo de pedido (ex.: aprovar um handoff). */
	| { status: "invalid_decision"; kind: "approval" | "handoff" };

type RequestRow = { runId: string; kind: string; key: string; callId: string | null; toolName: string | null; state: string; expiresAt: Date | null };
const toView = (row: RequestRow): AgentV4RequestView => ({ runId: row.runId, kind: row.kind as "approval" | "handoff", key: row.key, callId: row.callId, toolName: row.toolName, state: row.state as AgentV4RequestState, expiresAt: row.expiresAt });

/** Lê um pedido (aprovação ou handoff) do dono sem mudar nada. Outro dono = `null`. */
export async function findAgentV4Request(userId: string, runId: string, key: string): Promise<AgentV4RequestView | null> {
	if (!owned(userId)) return null;
	const row = await prisma.agentV4Request.findFirst({ where: { userId, runId, key, kind: { in: ["approval", "handoff"] } } });
	return row ? toView(row) : null;
}

/** Grava a decisão do dono sobre um pedido (aprovação ou handoff) do run. Filtra por dono; outro dono = `not_found`. */
export async function decideAgentV4Request(userId: string, runId: string, key: string, decision: AgentV4Decision, now: Date): Promise<DecideOutcome> {
	if (!owned(userId)) return { status: "not_found" };
	const where = { userId, runId, key, kind: { in: ["approval", "handoff"] } };
	const row = await prisma.agentV4Request.findFirst({ where });
	if (!row) return { status: "not_found" };
	const kind = row.kind as "approval" | "handoff";
	if (!(KIND_DECISIONS[kind] as readonly AgentV4Decision[]).includes(decision)) return { status: "invalid_decision", kind };
	const target = DECISION_STATE[decision];
	if (row.state === target) return { status: "already", request: toView(row) };
	if (row.state === "expired") return { status: "expired", request: toView(row) };
	if (row.state !== "pending") return { status: "conflict", request: toView(row) };
	if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) {
		await prisma.agentV4Request.updateMany({ where: { ...where, state: "pending" }, data: { state: "expired" } });
		return { status: "expired", request: toView({ ...row, state: "expired" }) };
	}
	const { count } = await prisma.agentV4Request.updateMany({ where: { ...where, state: "pending" }, data: { state: target, decidedAt: now } });
	if (count === 1) return { status: "recorded", request: toView({ ...row, state: target }) };
	// Perdeu a corrida para outra decisão: reclassifica pelo estado que ficou.
	const current = await prisma.agentV4Request.findFirst({ where });
	if (!current) return { status: "not_found" };
	return { status: current.state === target ? "already" : current.state === "expired" ? "expired" : "conflict", request: toView(current) };
}

export type AgentV4Decisions = {
	/** Aprovados: `requestId` e o hash dos argumentos de quando o cartão foi mostrado (o grant o repete). */
	approved: Array<{ requestId: string; payloadHash: string; grantedAt: Date }>;
	denied: string[];
	/** Ids de chamada de handoff que o dono assumiu. */
	handoffDone: string[];
	/** Pedidos (id de pedido ou de chamada de handoff) que venceram sem resposta. */
	expired: string[];
	/** Pedidos ainda esperando o dono, dentro do prazo. */
	pending: number;
};

/**
 * Decisões do dono sobre os pedidos de um run, para montar o `ResumeInput`. Pedido pendente que passou do prazo vira
 * `expired` aqui mesmo (a expiração é feita ao retomar, sem polling).
 */
export async function loadAgentV4Decisions(userId: string, runId: string, now: Date): Promise<AgentV4Decisions> {
	const empty: AgentV4Decisions = { approved: [], denied: [], handoffDone: [], expired: [], pending: 0 };
	if (!owned(userId)) return empty;
	await prisma.agentV4Request.updateMany({ where: { userId, runId, kind: { in: ["approval", "handoff"] }, state: "pending", expiresAt: { lte: now } }, data: { state: "expired" } });
	const rows = await prisma.agentV4Request.findMany({ where: { userId, runId, kind: { in: ["approval", "handoff"] } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: 500 });
	const out: AgentV4Decisions = { approved: [], denied: [], handoffDone: [], expired: [], pending: 0 };
	for (const row of rows) {
		if (row.state === "pending") out.pending++;
		else if (row.state === "expired") out.expired.push(row.key);
		else if (row.state === "denied") out.denied.push(row.key);
		else if (row.state === "done") out.handoffDone.push(row.callId ?? row.key);
		else if (row.state === "approved" && row.payloadHash) out.approved.push({ requestId: row.key, payloadHash: row.payloadHash, grantedAt: row.decidedAt ?? now });
	}
	return out;
}

/**
 * O dono escreveu enquanto o run estava estacionado num pedido: o run vai ser encerrado e a mensagem vira um run novo, então
 * os pedidos pendentes dele passam a `expired` (o cartão mostra isso e responder dá 410, não "repita"). Escopado por dono e
 * run; devolve quantos mudaram.
 */
export async function expirePendingAgentV4RequestsForRun(userId: string, runId: string): Promise<number> {
	if (!owned(userId)) return 0;
	const { count } = await prisma.agentV4Request.updateMany({ where: { userId, runId, kind: { in: ["approval", "handoff"] }, state: "pending" }, data: { state: "expired" } });
	return count;
}

/**
 * Na próxima mensagem do dono na conversa: pedidos pendentes que já passaram do prazo viram `expired`. Uma instrução
 * só, escopada por dono e conversa; escrever outra coisa NÃO expira pedido dentro do prazo. Devolve quantos venceram.
 */
export async function expireDueAgentV4Requests(userId: string, conversationId: string, now: Date): Promise<number> {
	if (!owned(userId)) return 0;
	const { count } = await prisma.agentV4Request.updateMany({ where: { userId, conversationId, kind: { in: ["approval", "handoff"] }, state: "pending", expiresAt: { lte: now } }, data: { state: "expired" } });
	return count;
}

// ------------------------------------------------------------------ cartões

export type AgentV4CardResponse = { cardId: string; response: "answered" | "dismissed" };

export type RecordCardOutcome = { status: "recorded" | "already" | "conflict" } | { status: "not_found" };

/**
 * O dono tocou num cartão de pergunta (`ask_owner`). O cartão precisa ser uma oferta ABERTA do próprio dono; a resposta
 * fica guardada até o run seguinte da conversa levá-la ao kernel (`settleOffers`). Outro dono = `not_found`.
 */
export async function recordAgentV4CardResponse(userId: string, cardId: string, response: AgentV4CardResponse["response"], now: Date): Promise<RecordCardOutcome> {
	if (!owned(userId) || cardId.length === 0 || cardId.length > LABEL_MAX) return { status: "not_found" };
	const runId = cardId.split(":")[0] ?? "";
	const [offer, run] = await Promise.all([
		prisma.agentConversationOffer.findFirst({ where: { userId, cardId }, select: { conversationId: true, state: true } }),
		runId ? prisma.agentRun.findFirst({ where: { id: runId, userId }, select: { id: true } }) : null,
	]);
	if (!offer || !run) return { status: "not_found" };
	const existing = await prisma.agentV4Request.findFirst({ where: { userId, runId, kind: "card", key: cardId }, select: { state: true } });
	if (existing) return { status: existing.state === response ? "already" : "conflict" };
	// Oferta que já saiu de `open` (ignorada ao falar de outra coisa, ou já respondida) não aceita mais resposta.
	if (offer.state !== "open") return { status: "conflict" };
	const { count } = await prisma.agentV4Request.createMany({ data: [{ userId, runId, conversationId: offer.conversationId, kind: "card", key: cardId, state: response, decidedAt: now }], skipDuplicates: true });
	return { status: count === 1 ? "recorded" : "already" };
}

/** Respostas a cartões ainda não levadas ao kernel nesta conversa. */
export async function listAgentV4CardResponses(userId: string, conversationId: string): Promise<AgentV4CardResponse[]> {
	if (!owned(userId)) return [];
	const rows = await prisma.agentV4Request.findMany({ where: { userId, conversationId, kind: "card", consumedAt: null }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: 100 });
	return rows.map((row) => ({ cardId: row.key, response: row.state as AgentV4CardResponse["response"] }));
}

export async function consumeAgentV4CardResponses(userId: string, conversationId: string, cardIds: readonly string[], now: Date): Promise<void> {
	if (!owned(userId) || cardIds.length === 0) return;
	await prisma.agentV4Request.updateMany({ where: { userId, conversationId, kind: "card", key: { in: [...cardIds] }, consumedAt: null }, data: { consumedAt: now } });
}

// ----------------------------------------------------------------- histórico

export type AgentV4HistoryRow = { role: "user" | "assistant"; content: string; origin: string | null; fromBotName: string | null; sourceKind: string | null; runId: string | null; createdAt: Date };

/**
 * Falas da conversa (dono e assistente) em ordem, para o histórico do run v4. Só `user` e `assistant`: cartões e
 * resultados de tool do passado não entram (o assistente já contou o que importa na própria fala). A conversa precisa
 * ser do dono. `excludeRunId` tira o que o próprio run gravou.
 */
export async function listAgentV4History(userId: string, conversationId: string, options: { excludeRunId?: string; limit?: number } = {}): Promise<AgentV4HistoryRow[]> {
	const owners = ownerIds(userId);
	if (owners.length === 0) return [];
	const limit = Math.min(Math.max(1, Math.floor(options.limit ?? AGENT_V4_HISTORY_MAX)), AGENT_V4_HISTORY_MAX);
	const rows = await prisma.conversationMessage.findMany({
		where: {
			conversationId,
			conversation: { userId: { in: owners } },
			role: { in: ["user", "assistant"] },
			...(options.excludeRunId ? { OR: [{ runId: null }, { runId: { not: options.excludeRunId } }] } : {}),
		},
		orderBy: [{ createdAt: "desc" }, { id: "desc" }],
		take: limit,
		select: { role: true, content: true, origin: true, fromBotName: true, sourceKind: true, runId: true, createdAt: true },
	});
	return rows.reverse().map((row) => ({ role: row.role as "user" | "assistant", content: row.content, origin: row.origin, fromBotName: row.fromBotName, sourceKind: row.sourceKind, runId: row.runId, createdAt: row.createdAt }));
}

/**
 * Quantas falas (dono e assistente) da conversa ficaram de fora do histórico carregado (`AGENT_V4_HISTORY_MAX`): total da
 * conversa menos o que cabe na janela. Só se chama quando a janela veio cheia (auditoria F2, C4). Mesmos filtros de
 * `listAgentV4History`; conversa de outro dono = 0.
 */
export async function countAgentV4HistoryOmitted(userId: string, conversationId: string, options: { excludeRunId?: string } = {}): Promise<number> {
	const owners = ownerIds(userId);
	if (owners.length === 0) return 0;
	const total = await prisma.conversationMessage.count({
		where: {
			conversationId,
			conversation: { userId: { in: owners } },
			role: { in: ["user", "assistant"] },
			...(options.excludeRunId ? { OR: [{ runId: null }, { runId: { not: options.excludeRunId } }] } : {}),
		},
	});
	return Math.max(0, total - AGENT_V4_HISTORY_MAX);
}

// --------------------------------------------------------------- proveniência

export type AgentV4ConversationProvenance = { untrustedReadInRun: boolean; privateReadInRun: boolean; sources: string[] };

/**
 * Sinais de proveniência dos OUTROS runs v4 da conversa (S8). Lê só a coluna pequena `v4Provenance`, gravada junto com o
 * checkpoint (nunca o `checkpointJson`, que pode ter centenas de KB em TOAST: C1). Run de outro motor não tem a coluna e
 * não conta. Uma instrução, escopada por dono.
 *
 * Limite conhecido e aceito (auditoria F2, S6): só runs v4 deixam proveniência. Um run v2 anterior na mesma conversa não
 * contamina o v4 seguinte; o dono só liga o v4 quando ele estiver completo (flag por conta), então a conversa não mistura
 * motores em produção. Runs v4 gravados antes da coluna existir também não contam (o v4 ainda não saiu da flag).
 */
export async function getAgentV4ConversationProvenance(userId: string, conversationId: string, excludeRunId: string): Promise<AgentV4ConversationProvenance> {
	const none: AgentV4ConversationProvenance = { untrustedReadInRun: false, privateReadInRun: false, sources: [] };
	if (!owned(userId)) return none;
	const rows = await prisma.$queryRaw<Array<{ untrusted: boolean; priv: boolean; sources: unknown }>>`
		SELECT ("v4Provenance"->>'untrustedReadInRun') = 'true' AS "untrusted",
			("v4Provenance"->>'privateReadInRun') = 'true' AS "priv",
			COALESCE("v4Provenance"->'sources', '[]'::jsonb) AS "sources"
		FROM "agent_runs"
		WHERE "userId" = ${userId} AND "conversationId" = ${conversationId} AND "id" <> ${excludeRunId}
			AND "v4Provenance" IS NOT NULL
			AND (("v4Provenance"->>'untrustedReadInRun') = 'true' OR ("v4Provenance"->>'privateReadInRun') = 'true')
		LIMIT 200`;
	const sources = new Set<string>();
	for (const row of rows) if (Array.isArray(row.sources)) for (const s of row.sources) if (typeof s === "string") sources.add(s);
	return { untrustedReadInRun: rows.some((r) => r.untrusted), privateReadInRun: rows.some((r) => r.priv), sources: [...sources] };
}
