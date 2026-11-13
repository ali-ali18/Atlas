/**
 * Estado de um card do motor v4 gravado na conversa (aprovação, "isso é com você", pergunta do bot).
 *
 * O card é gravado UMA vez (o evento, validado e redigido); o estado NÃO é gravado nele: é derivado na leitura do
 * pedido (`agent_v4_requests`), da oferta (`ask_owner`) e do run. Assim, responder, dispensar, vencer (24 h) ou o run
 * terminar mudam o card restaurado sem escrever em duas tabelas, e nenhum aparelho vê um botão que não funciona mais.
 * Funções puras: o banco só entrega os dados.
 */
import { type AgentV4Event, parseAgentV4Event } from "./agent-v4-events.js";
import { redactSecrets } from "./redact-secrets.js";
import { isTerminalRunStatus } from "./run-follow.js";

export const AGENT_CARD_STATES = ["pending", "approved", "denied", "done", "answered", "dismissed", "expired"] as const;
export type AgentCardState = (typeof AGENT_CARD_STATES)[number];

const STATE_SET: ReadonlySet<string> = new Set(AGENT_CARD_STATES);

export function isAgentCardState(value: unknown): value is AgentCardState {
	return typeof value === "string" && STATE_SET.has(value);
}

/** Tipos de card que têm estado (o recibo é só um registro do que foi feito). */
export function agentCardHasState(type: AgentV4Event["type"]): boolean {
	return type !== "receipt";
}

export type AgentCardStateInput =
	| {
			type: "approval_request" | "handoff_request";
			/** Linha do pedido (`agent_v4_requests`); `null` = o run ainda não o registrou (estaciona depois de emitir o card). */
			request: { state: string; expiresAt: Date | null } | null;
			runStatus: string | null | undefined;
			now: Date;
	  }
	| {
			type: "ask_owner";
			/** Resposta do dono já registrada (`agent_v4_requests`, tipo `card`). */
			response: "answered" | "dismissed" | null;
			/** Estado da oferta da conversa (`open | answered | dismissed | ignored`); `null` = não há oferta. */
			offer: string | null;
			runStatus: string | null | undefined;
			now: Date;
	  };

/**
 * Estado que o card mostra. Pendente só enquanto ainda dá para responder: pedido vencido, run encerrado sem o pedido ser
 * decidido, oferta ignorada (o dono falou de outra coisa) viram `expired`, nunca um botão que a API recusaria.
 */
export function resolveAgentCardState(input: AgentCardStateInput): AgentCardState {
	const runEnded = isTerminalRunStatus(input.runStatus);
	if (input.type === "ask_owner") {
		if (input.response) return input.response;
		if (input.offer === "answered") return "answered";
		if (input.offer === "dismissed") return "dismissed";
		if (input.offer === "ignored") return "expired";
		return input.offer === null && runEnded ? "expired" : "pending";
	}
	const row = input.request;
	if (row && row.state !== "pending") return isAgentCardState(row.state) ? row.state : "expired";
	if (row?.expiresAt && row.expiresAt.getTime() <= input.now.getTime()) return "expired";
	return runEnded ? "expired" : "pending";
}

/** Nomes de campo que nunca vão para o card gravado, qualquer que seja o valor (o CVV vive só no campo do card, na hora). */
const SECRET_KEY = /^(cvv2?|cvc2?|cid|security_?code|card_?number|card_?num|pan|password|passwd|secret|token|api_?key)$/i;

function scrub(value: unknown, depth = 0): unknown {
	if (typeof value === "string") return redactSecrets(value);
	if (depth > 8) return undefined;
	if (Array.isArray(value)) return value.map((item) => scrub(item, depth + 1));
	if (typeof value === "object" && value !== null) {
		const out: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(value)) {
			if (SECRET_KEY.test(key)) continue;
			out[key] = scrub(entry, depth + 1);
		}
		return out;
	}
	return value;
}

/**
 * O evento do card pronto para ser gravado na conversa: textos por `redactSecrets`, campos de segredo fora, e a forma
 * validada de novo pelo parser (o que sobra é um evento v4 válido ou `null`). O CVV nunca esteve no evento (só o aviso
 * `ownerInput`); isto garante que também não entra por argumento, fato de risco ou texto livre.
 */
export function sanitizeAgentV4EventForStorage(event: unknown): AgentV4Event | null {
	return parseAgentV4Event(scrubKeepingIdentity(event));
}

/**
 * Campos de identidade do evento (nível raiz). São chaves que o app devolve às rotas (`/requests/:key/respond`,
 * `/cards/:cardId/respond`) e que o dedupe compara: `redactSecrets` mutilava hex longo (o `requestId` é um sha256) e o cartão
 * gravado dava 404 ao responder. Vêm do próprio motor, nunca de texto livre, então não passam pelo redator.
 */
const IDENTITY_KEYS: ReadonlySet<string> = new Set(["type", "requestId", "callId", "cardId", "runId", "id"]);

function scrubKeepingIdentity(event: unknown): unknown {
	if (typeof event !== "object" || event === null || Array.isArray(event)) return scrub(event);
	const out: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(event)) {
		if (SECRET_KEY.test(key)) continue;
		out[key] = IDENTITY_KEYS.has(key) && typeof entry === "string" ? entry : scrub(entry, 1);
	}
	return out;
}
