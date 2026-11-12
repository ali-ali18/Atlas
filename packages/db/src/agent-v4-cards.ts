/**
 * Cards do motor v4 como mensagens da conversa (issue #163, item 3): aprovação (`approval_request`, inclusive o de
 * compra), entrega ao dono (`handoff_request`), pergunta do bot (`ask_owner`) e recibo (`receipt`).
 *
 * - Gravação: uma linha por card, `role` = tipo do evento, `content` = o evento em JSON, já validado e SEM segredo
 *   (`sanitizeAgentV4EventForStorage`). A identidade é a mesma do ao vivo (`agentCardKey`): reemitir não duplica.
 * - Estado: não é gravado no card. `attachAgentV4CardStates` o deriva na leitura (pedido, oferta e run), então
 *   responder, dispensar, vencer ou o run terminar mudam o card restaurado sem escrita dupla.
 * - Escopo: conversa, run e linhas de pedido são conferidos pelo dono; card de outra conversa ou dono nunca entra.
 */
import { agentCardHasState, agentCardIdentity, agentCardKey, isAgentV4EventType, parseAgentV4Event, resolveAgentCardState, sanitizeAgentV4EventForStorage, type AgentCardState } from "@workspace/shared";
import { prisma } from "./client.js";
import { ownerIds } from "./mcp-connections.js";

export type PersistAgentV4CardOutcome = "created" | "exists" | "skipped";

/**
 * Grava o card na conversa do dono. `skipped` = evento inválido, sem `runId`, ou conversa/run que não são do dono (nada é
 * gravado e nada é revelado). Idempotente por `agentCardKey`.
 */
export async function persistAgentV4Card(userId: string, conversationId: string | null | undefined, event: unknown): Promise<PersistAgentV4CardOutcome> {
	if (!conversationId || ownerIds(userId).length === 0) return "skipped";
	const card = sanitizeAgentV4EventForStorage(event);
	if (!card?.runId) return "skipped";
	const [conversation, run] = await Promise.all([
		prisma.conversation.findFirst({ where: { id: conversationId, userId }, select: { id: true } }),
		prisma.agentRun.findFirst({ where: { id: card.runId, userId, conversationId }, select: { id: true } }),
	]);
	if (!conversation || !run) return "skipped";
	const key = agentCardKey(card);
	const existing = await prisma.conversationMessage.findMany({ where: { conversationId, role: card.type, runId: card.runId }, select: { content: true }, take: 200 });
	const duplicate = existing.some((row) => {
		const prior = parseStored(row.content);
		return prior !== null && agentCardKey(prior) === key;
	});
	if (duplicate) return "exists";
	await prisma.conversationMessage.create({ data: { conversationId, role: card.type, content: JSON.stringify(card), runId: card.runId } });
	return "created";
}

function parseStored(content: string) {
	try {
		return parseAgentV4Event(JSON.parse(content));
	} catch {
		return null;
	}
}

const KIND_OF = { approval_request: "approval", handoff_request: "handoff", ask_owner: "card" } as const;

/**
 * Estado atual dos cards v4 de uma página de mensagens (id da mensagem → estado). Só as linhas cujo `role` é um tipo com
 * estado entram; o recibo e as demais mensagens não têm. Uma consulta por tabela, só quando a página tem esses cards.
 * Run, pedido e oferta são buscados DENTRO da conversa: um `runId` de outra conversa no conteúdo não dá acesso a nada.
 */
export async function attachAgentV4CardStates(conversationId: string, rows: ReadonlyArray<{ id: string; role: string; content: string }>, now: Date = new Date()): Promise<Map<string, AgentCardState>> {
	const out = new Map<string, AgentCardState>();
	const cards = rows.flatMap((row) => {
		if (!isAgentV4EventType(row.role)) return [];
		const event = parseStored(row.content);
		return event && event.type === row.role && agentCardHasState(event.type) && event.runId ? [{ id: row.id, event }] : [];
	});
	if (cards.length === 0) return out;
	const runIds = [...new Set(cards.map((c) => c.event.runId as string))];
	const cardIds = cards.flatMap((c) => (c.event.type === "ask_owner" ? [c.event.cardId] : []));
	const [runs, requests, offers] = await Promise.all([
		prisma.agentRun.findMany({ where: { id: { in: runIds }, conversationId }, select: { id: true, status: true, userId: true } }),
		prisma.agentV4Request.findMany({ where: { runId: { in: runIds } }, select: { runId: true, kind: true, key: true, state: true, expiresAt: true, userId: true } }),
		cardIds.length > 0 ? prisma.agentConversationOffer.findMany({ where: { conversationId, cardId: { in: cardIds } }, select: { cardId: true, state: true } }) : [],
	]);
	const runById = new Map(runs.map((run) => [run.id, run]));
	const requestBy = new Map(requests.filter((r) => runById.get(r.runId)?.userId === r.userId).map((r) => [`${r.runId}|${r.kind}|${r.key}`, r]));
	const offerBy = new Map(offers.map((o) => [o.cardId, o.state]));
	for (const { id, event } of cards) {
		const run = runById.get(event.runId as string);
		// Run que não é desta conversa: o card não tem como ser respondido aqui.
		if (!run) {
			out.set(id, "expired");
			continue;
		}
		if (event.type === "ask_owner") {
			const response = requestBy.get(`${event.runId}|card|${event.cardId}`)?.state;
			out.set(id, resolveAgentCardState({ type: "ask_owner", response: response === "answered" || response === "dismissed" ? response : null, offer: offerBy.get(event.cardId) ?? null, runStatus: run.status, now }));
			continue;
		}
		if (event.type === "approval_request" || event.type === "handoff_request") {
			const request = requestBy.get(`${event.runId}|${KIND_OF[event.type]}|${agentCardIdentity(event)}`);
			out.set(id, resolveAgentCardState({ type: event.type, request: request ? { state: request.state, expiresAt: request.expiresAt } : null, runStatus: run.status, now }));
		}
	}
	return out;
}
