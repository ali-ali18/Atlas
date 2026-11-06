/**
 * Contexto de um run do motor v4 montado do banco (F2.6): histórico da conversa (B5), respostas a cartões, taint herdado
 * entre runs (S8) e a retomada com a decisão do dono (B6). O processador só chama `prepareV4Run` e passa o resultado ao
 * `runEngineV4`; a lógica fica aqui para ser testada com um banco falso.
 *
 * Run novo: histórico + `cardResponses` + `priorProvenance`. Run retomado (já há checkpoint v4): o snapshot do kernel já
 * tem as mensagens e a proveniência, então só se monta o `ResumeInput` com o que o dono decidiu.
 */
import type { ChannelInput, RunEvent, RunInput, TrustSource } from "@workspace/agent";
import { TRUST_SOURCES } from "@workspace/agent";
import {
	consumeAgentV4CardResponses,
	expireDueAgentV4Requests,
	getAgentV4ConversationProvenance,
	hasAgentV4Checkpoint,
	listAgentV4CardResponses,
	listAgentV4History,
	loadAgentV4Checkpoint,
	loadAgentV4Decisions,
	registerAgentV4Requests,
	type AgentV4Decisions,
	type AgentV4HistoryRow,
	type AgentV4RequestInput,
} from "@workspace/db";

/** As funções de banco do contexto do run v4; injetáveis para o teste. */
export type V4RunContextDb = {
	loadCheckpoint: typeof loadAgentV4Checkpoint;
	/** Existência barata do checkpoint (decide run novo x retomada sem trazer o payload). */
	hasCheckpoint: typeof hasAgentV4Checkpoint;
	listHistory: typeof listAgentV4History;
	conversationProvenance: typeof getAgentV4ConversationProvenance;
	listCardResponses: typeof listAgentV4CardResponses;
	consumeCardResponses: typeof consumeAgentV4CardResponses;
	expireDue: typeof expireDueAgentV4Requests;
	loadDecisions: typeof loadAgentV4Decisions;
	registerRequests: typeof registerAgentV4Requests;
};

export const realV4RunContextDb: V4RunContextDb = {
	loadCheckpoint: loadAgentV4Checkpoint,
	hasCheckpoint: hasAgentV4Checkpoint,
	listHistory: listAgentV4History,
	conversationProvenance: getAgentV4ConversationProvenance,
	listCardResponses: listAgentV4CardResponses,
	consumeCardResponses: consumeAgentV4CardResponses,
	expireDue: expireDueAgentV4Requests,
	loadDecisions: loadAgentV4Decisions,
	registerRequests: registerAgentV4Requests,
};

/**
 * Mensagens da conversa no formato do kernel. Fala do dono e do assistente entram como são; mensagem que o dono NÃO
 * escreveu (outro bot, rotina, webhook) entra no canal de dado não confiável. Resultados de tool do passado não existem
 * aqui: o banco guarda só as falas, e o que a tool trouxe já está resumido na fala do assistente.
 *
 * O último turno do dono é o `objective` do run (é ele que traz anexos e citação): se a última entrada é do dono, ela é
 * trocada pelo objetivo; senão o objetivo entra no fim. Função pura.
 */
export function buildV4History(rows: readonly Pick<AgentV4HistoryRow, "role" | "content" | "origin" | "fromBotName" | "sourceKind">[], objective: string): ChannelInput[] {
	const history: ChannelInput[] = [];
	for (const row of rows) {
		const text = row.content;
		if (text.trim().length === 0) continue;
		if (row.role === "assistant") history.push({ kind: "assistant", text });
		else if (row.origin === null) history.push({ kind: "owner", text });
		else if (row.origin === "bot") history.push({ kind: "data", source: `bot:${row.fromBotName ?? "bot"}`, text });
		else history.push({ kind: "data", source: `tool:${row.sourceKind ?? row.origin}`, text });
	}
	const current = objective.trim().length > 0 ? objective : undefined;
	if (current === undefined) return history;
	const last = history.at(-1);
	if (last?.kind === "owner") history[history.length - 1] = { kind: "owner", text: current };
	else history.push({ kind: "owner", text: current });
	return history;
}

/** O que o dono decidiu virou o `ResumeInput` do kernel. Função pura. */
export function resumeInputFromDecisions(decisions: AgentV4Decisions): NonNullable<RunInput["resume"]> {
	return {
		grants: decisions.approved.map((a) => ({ requestId: a.requestId, payloadHash: a.payloadHash, grantedAt: a.grantedAt })),
		denied: decisions.denied,
		expired: decisions.expired,
		handoffDone: decisions.handoffDone,
	};
}

/**
 * Pedidos de aprovação e handoff que o checkpoint do kernel diz estarem estacionados. É a fonte de verdade para
 * registrar os pedidos: o cartão visto em `observe` só existe na execução que o emitiu, e uma queda entre o checkpoint
 * PARKED e o registro perderia o pedido para sempre (a retomada não reemite cartão). Aprovação sem `payloadHash` (checkpoint
 * antigo) não dá para reconstruir e fica de fora. Função pura.
 */
export function requestsFromParked(payload: unknown): AgentV4RequestInput[] {
	const parked = (payload as { parked?: unknown } | null | undefined)?.parked;
	if (typeof parked !== "object" || parked === null) return [];
	const out: AgentV4RequestInput[] = [];
	for (const [callId, entry] of Object.entries(parked as Record<string, unknown>)) {
		const call = entry as { kind?: unknown; requestId?: unknown; payloadHash?: unknown; toolName?: unknown } | null;
		if (call?.kind === "handoff") out.push({ kind: "handoff", key: callId, callId });
		else if (call?.kind === "approval" && typeof call.requestId === "string" && typeof call.payloadHash === "string") out.push({ kind: "approval", key: call.requestId, callId, payloadHash: call.payloadHash, ...(typeof call.toolName === "string" && { toolName: call.toolName }) });
	}
	return out;
}

const isTrustSource = (value: string): value is TrustSource => (TRUST_SOURCES as readonly string[]).includes(value);

export type PreparedV4Run = {
	/** Só em run novo de chat. Sem isto o motor usa só o objetivo. */
	history?: ChannelInput[];
	cardResponses?: NonNullable<RunInput["cardResponses"]>;
	priorProvenance?: NonNullable<RunInput["priorProvenance"]>;
	/** Só em retomada. */
	resume?: NonNullable<RunInput["resume"]>;
	/** Observa os eventos do kernel (cartões de aprovação e handoff) sem mudar o que o mapa devolve. */
	observe<T>(map: (event: RunEvent) => T): (event: RunEvent) => T;
	/** Depois do run: registra o que ficou esperando o dono e marca as respostas de cartão como entregues ao kernel. */
	finish(outcome: { parked: boolean }): Promise<void>;
};

export type PrepareV4RunInput = {
	userId: string;
	runId: string;
	conversationId: string | null;
	objective: string;
	/** Run de chat da conversa (só ele recebe o histórico; rotina e proativo seguem só com o objetivo). */
	chat: boolean;
	now?: () => Date;
	db?: V4RunContextDb;
};

export async function prepareV4Run(input: PrepareV4RunInput): Promise<PreparedV4Run> {
	const db = input.db ?? realV4RunContextDb;
	const now = input.now ?? (() => new Date());
	const requests: AgentV4RequestInput[] = [];
	let deliveredCards: string[] = [];

	const base = {
		observe<T>(map: (event: RunEvent) => T): (event: RunEvent) => T {
			return (event) => {
				const data = (event.data ?? {}) as Record<string, unknown>;
				if (event.type === "card" && typeof data.callId === "string") {
					if (data.kind === "approval") {
						const request = data.request as { id?: unknown; toolName?: unknown; payloadHash?: unknown } | undefined;
						if (typeof request?.id === "string" && typeof request.payloadHash === "string") requests.push({ kind: "approval", key: request.id, callId: data.callId, payloadHash: request.payloadHash, ...(typeof request.toolName === "string" && { toolName: request.toolName }) });
					} else if (data.kind === "handoff") requests.push({ kind: "handoff", key: data.callId, callId: data.callId });
				}
				return map(event);
			};
		},
		async finish(outcome: { parked: boolean }): Promise<void> {
			if (outcome.parked) {
				// O checkpoint PARKED já foi gravado; o que ele diz estar estacionado vira pedido do dono, mesmo que o cartão tenha sido
				// emitido por uma execução que caiu antes de registrar (auditoria F2, B1). O registro é idempotente por (run, tipo, chave).
				const checkpoint = await db.loadCheckpoint(input.userId, input.runId);
				const merged = new Map<string, AgentV4RequestInput>();
				for (const item of [...requests, ...requestsFromParked(checkpoint?.payload)]) merged.set(`${item.kind}:${item.key}`, item);
				if (merged.size > 0) await db.registerRequests(input.userId, input.runId, input.conversationId, [...merged.values()], now());
			}
			if (input.conversationId && deliveredCards.length > 0) await db.consumeCardResponses(input.userId, input.conversationId, deliveredCards, now());
		},
	};

	// Retomada: o kernel restaura mensagens e proveniência do checkpoint; falta só o que o dono decidiu (e o que venceu).
	if (await db.hasCheckpoint(input.userId, input.runId)) {
		return { ...base, resume: resumeInputFromDecisions(await db.loadDecisions(input.userId, input.runId, now())) };
	}

	if (!input.chat || !input.conversationId) return base;
	// Escrever na conversa NÃO expira pedido dentro do prazo; só os que já passaram dele viram `expired`.
	await db.expireDue(input.userId, input.conversationId, now());
	const [rows, cardResponses, provenance] = await Promise.all([
		db.listHistory(input.userId, input.conversationId, { excludeRunId: input.runId }),
		db.listCardResponses(input.userId, input.conversationId),
		db.conversationProvenance(input.userId, input.conversationId, input.runId),
	]);
	deliveredCards = cardResponses.map((c) => c.cardId);
	const tainted = provenance.untrustedReadInRun || provenance.privateReadInRun;
	return {
		...base,
		history: buildV4History(rows, input.objective),
		...(cardResponses.length > 0 && { cardResponses }),
		...(tainted && { priorProvenance: { untrustedReadInRun: provenance.untrustedReadInRun, privateReadInRun: provenance.privateReadInRun, sources: provenance.sources.filter(isTrustSource) } }),
	};
}
