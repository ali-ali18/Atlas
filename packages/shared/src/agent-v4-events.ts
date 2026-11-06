import type { EffectClass } from "./agent-policy/types.js";
import { EFFECT_CLASSES } from "./agent-policy/types.js";

/**
 * Eventos do motor v4 que NÃO têm equivalente no contrato SSE de antes (F1.12). Entram na união
 * `ComputerUseEvent` como tipos novos. Cliente que não os conhece ignora (o `dispatchComputerUseEvent`
 * do web e o reducer de transcript não têm ramo para tipo desconhecido), então web e celular seguem
 * funcionando; quem quiser renderizar o cartão usa `parseAgentV4Event` para validar antes.
 *
 * Todo texto aqui já foi redigido (sem segredo) por quem emite. Os argumentos do cartão de aprovação
 * são a visão do cartão (`ApprovalRequest.args`), nunca os argumentos reais da execução.
 */

/** Tools de efeito pedem aprovação do dono: o cartão mostra os argumentos reais (sem segredo) e os fatos de risco tipados. */
export type ApprovalRequestEvent = {
	type: "approval_request";
	/** Id do pedido (`ApprovalRequest.id`): o que a decisão do dono referencia. */
	requestId: string;
	/** Chamada do modelo que ficou estacionada. */
	callId: string;
	toolName: string;
	effect: EffectClass;
	args: unknown;
	riskFacts: Record<string, unknown>;
	runId?: string;
};

/** O passo é sempre do dono (trocar senha, aceitar termos…): o texto já vem no idioma do bot. */
export type HandoffRequestEvent = {
	type: "handoff_request";
	callId: string;
	message: string;
	runId?: string;
};

/** Cartão de pergunta ao dono (termina o turno). `offer` é a oferta que fica registrada na conversa. */
export type AskOwnerEvent = {
	type: "ask_owner";
	cardId: string;
	question: string;
	offer?: string;
	runId?: string;
};

/** Recibo tipado de uma tool de efeito (o que fez, onde, id externo, link). */
export type ReceiptEvent = {
	type: "receipt";
	/** Id da chamada (o mesmo do `tool_call`/`tool_result`). */
	id: string;
	name: string;
	what: string;
	where?: string;
	externalId?: string;
	url?: string;
	runId?: string;
};

export type AgentV4Event = ApprovalRequestEvent | HandoffRequestEvent | AskOwnerEvent | ReceiptEvent;

export const AGENT_V4_EVENT_TYPES = ["approval_request", "handoff_request", "ask_owner", "receipt"] as const satisfies readonly AgentV4Event["type"][];

const TYPE_SET: ReadonlySet<string> = new Set(AGENT_V4_EVENT_TYPES);
const EFFECT_SET: ReadonlySet<string> = new Set(EFFECT_CLASSES);

/** Teto de tamanho de cada texto de cartão (defesa contra payload gigante num evento persistido). */
export const AGENT_V4_TEXT_MAX = 8_000;

export function isAgentV4EventType(type: unknown): type is AgentV4Event["type"] {
	return typeof type === "string" && TYPE_SET.has(type);
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= AGENT_V4_TEXT_MAX;
const optText = (v: unknown): v is string | undefined => v === undefined || text(v);

/** Valida um valor desconhecido (ex.: payload de `run_events`). `null` = não é um evento v4 válido; campo extra é descartado. */
export function parseAgentV4Event(value: unknown): AgentV4Event | null {
	if (!isObject(value) || !isAgentV4EventType(value.type)) return null;
	const runId = value.runId;
	if (!optText(runId)) return null;
	const base = runId !== undefined ? { runId } : {};
	switch (value.type) {
		case "approval_request": {
			const { requestId, callId, toolName, effect, args, riskFacts } = value;
			if (!text(requestId) || !text(callId) || !text(toolName) || typeof effect !== "string" || !EFFECT_SET.has(effect) || !isObject(riskFacts)) return null;
			return { type: "approval_request", requestId, callId, toolName, effect: effect as EffectClass, args, riskFacts, ...base };
		}
		case "handoff_request": {
			if (!text(value.callId) || !text(value.message)) return null;
			return { type: "handoff_request", callId: value.callId, message: value.message, ...base };
		}
		case "ask_owner": {
			if (!text(value.cardId) || typeof value.question !== "string" || value.question.length > AGENT_V4_TEXT_MAX || !optText(value.offer)) return null;
			return { type: "ask_owner", cardId: value.cardId, question: value.question, ...(value.offer !== undefined && { offer: value.offer }), ...base };
		}
		case "receipt": {
			const { id, name, what, where, externalId, url } = value;
			if (!text(id) || !text(name) || !text(what) || !optText(where) || !optText(externalId) || !optText(url)) return null;
			return { type: "receipt", id, name, what, ...(where !== undefined && { where }), ...(externalId !== undefined && { externalId }), ...(url !== undefined && { url }), ...base };
		}
	}
}
