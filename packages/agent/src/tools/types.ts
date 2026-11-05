import type { Ports } from "../ports/index.js";

/** Contexto que o laço entrega a toda tool e a todo gancho. Não leva texto do assistente. */
export type ToolContext = {
	runId: string;
	ownerId: string;
	ports: Ports;
	signal?: AbortSignal;
};

/**
 * Fatos de risco que o cartão de aprovação mostra (destino, valor, destinatários…).
 * Forma provisória: a F1.4 fecha o tipo; só metadados tipados, nunca corpo de e-mail/página.
 */
export type RiskFacts = Readonly<Record<string, string | number | boolean | readonly string[]>>;

/** Recibo mínimo de uma tool de efeito. A F1.6 o torna o `Receipt` do journal. */
export type ToolReceipt = {
	what: string;
	where?: string;
	externalId?: string;
	url?: string;
};

/** Sucesso sempre com `summary`; falha sempre com `error` real. Nunca `ok:true` com texto de erro. */
export type ToolResult =
	| { ok: true; summary: string; receipt?: ToolReceipt; error?: never }
	| { ok: false; error: string; hint?: string; summary?: never };
