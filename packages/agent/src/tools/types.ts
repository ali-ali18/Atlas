import type { Ports } from "../ports/index.js";

/** Contexto que o laço entrega a toda tool e a todo gancho. Não leva texto do assistente. */
export type ToolContext = {
	runId: string;
	ownerId: string;
	ports: Ports;
	signal?: AbortSignal;
};

/**
 * Fatos de risco que o cartão de aprovação mostra (cláusula 3). Só metadados tipados tirados dos
 * argumentos pela própria tool, nunca texto do modelo nem corpo de e-mail/página (cláusula 7).
 */
export type RiskFacts = {
	amount?: number;
	currency?: string;
	merchant?: string;
	/** Todos os destinatários (pessoas, bots, endereços). */
	recipients?: readonly string[];
	/** Subconjunto de `recipients` fora do Atlas e fora do círculo do dono. */
	externalRecipients?: readonly string[];
	/** Não dá para desfazer. */
	irreversible?: boolean;
	/** Onde o efeito acontece: conta, arquivo, URL, calendário… */
	target?: string;
};

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
