// Porta `Bots` (F9): falar com outros bots do MESMO dono, escolher o bot principal, responder pendências que outro bot
// deixou e propor um bot novo. O bot do run vem preso no adaptador (um por run); toda chamada leva o `userId` do RUN e o
// adaptador só enxerga bots desse dono. Bot de outro dono é indistinguível de bot inexistente. Falha = `throw` com a
// mensagem real (a tool a devolve como `ok:false`).
import type { BotProposalEvent, BotRosterEntry } from "@workspace/shared";

/** Resultado de uma mensagem enfileirada: a entrega e a resposta acontecem depois, em outro turno. */
export type SentBotMessage = { id: string; targetId: string; targetName: string };

export type PendingDecisionInput = {
	/** Id do item no bloco `[pending_items]` da resposta do outro bot. */
	handle: string;
	decision: "approve" | "reject" | "answer" | "escalate";
	reason?: string;
	/** 0 a 1: o quanto o modelo está seguro (approve/reject). */
	confidence?: number;
	/** Questionário: nome da pergunta -> valor(es). */
	answers?: Record<string, unknown>;
};

/**
 * O que aconteceu com o item. `escalated`: o cartão foi ao dono (com o motivo em palavras do dono). `answered`: o
 * questionário foi respondido com as respostas dadas. `already_decided`: alguém decidiu antes.
 */
export type PendingDecisionOutcome =
	| { status: "answered"; botName: string }
	| { status: "escalated"; botName: string; why: string }
	| { status: "already_decided"; botName: string };

export interface BotProposals {
	/** Mostra (e grava na conversa) o cartão de proposta. Nada é criado antes de o dono aprovar. */
	show(userId: string, runId: string, proposal: BotProposalEvent): Promise<void>;
	/** Nomes (slugs) das habilidades da conta que podem ser copiadas ao bot novo. */
	skillNames(userId: string): Promise<string[]>;
}

export interface Bots {
	/** O bot deste run (preso no adaptador). */
	readonly selfId: string;
	/** Os bots do dono (sem grupos), com o principal marcado. */
	roster(userId: string): Promise<BotRosterEntry[]>;
	/**
	 * Enfileira a mensagem ao outro bot (nome ou id). O adaptador aplica os tetos estruturais da cadeia (saltos, mensagens
	 * por cadeia, envios por run). Lança com texto limpo se o destino não existe, é o próprio bot ou o teto foi atingido.
	 */
	send(userId: string, runId: string, input: { bot: string; message: string; title: string }): Promise<SentBotMessage>;
	/** Marca o bot como principal do dono. `false` = o bot não é do dono (ou já não existe). */
	setPrimary(userId: string, botId: string): Promise<boolean>;
	/**
	 * Responde ou escala uma pendência que outro bot deixou. Ausente = o dono não ligou "Decidir pelos outros bots" (a tool
	 * `decide_bot_pending` não é registrada).
	 */
	decidePending?(userId: string, runId: string, input: PendingDecisionInput): Promise<PendingDecisionOutcome>;
	/** Proposta de bot novo. Ausente = sem onde mostrar o cartão (a tool `propose_bot` não é registrada). */
	readonly proposals?: BotProposals;
}
