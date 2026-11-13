/**
 * Mandato (contrato 06, cláusula 4): autorização delimitada por valor, loja, prazo e número de usos.
 * Só vale para `money` (ver `decide.ts`); nunca existe "sempre permitir" para destructive/credential.
 * Tudo puro: o relógio entra por parâmetro.
 */

export type Mandate = {
	/** Teto por execução, na unidade da moeda (inclusive: valor igual ao teto passa). */
	maxAmount: number;
	/** Código ISO da moeda (ex.: "BRL"). Moeda diferente nunca casa. */
	currency: string;
	/** Lojas permitidas (identificadores, não texto livre). Lista vazia = nenhuma. */
	merchants: readonly string[];
	/** Fim da validade (ISO 8601). Vale só antes dele: `now < until`. */
	until: string;
	/** Usos que ainda restam; o caller decrementa a cada execução. */
	usesLeft: number;
};

export type MandateCheckInput = {
	amount: number;
	currency: string;
	merchant: string;
	now: Date;
};

export type MandateRejection =
	| "invalid_amount"
	| "expired"
	| "no_uses_left"
	| "currency_mismatch"
	| "merchant_not_allowed"
	| "amount_exceeded";

export type MandateCheck = { ok: true } | { ok: false; reason: MandateRejection };

const norm = (value: string): string => value.trim().toLowerCase();

/** Confere um mandato contra a compra concreta. Qualquer dúvida (data inválida, valor não finito) rejeita. */
export function checkMandate(mandate: Mandate, input: MandateCheckInput): MandateCheck {
	if (!Number.isFinite(input.amount) || input.amount < 0) return { ok: false, reason: "invalid_amount" };
	const until = Date.parse(mandate.until);
	// `until` ilegível conta como vencido: fail-closed.
	if (!Number.isFinite(until) || input.now.getTime() >= until) return { ok: false, reason: "expired" };
	if (!Number.isFinite(mandate.usesLeft) || mandate.usesLeft <= 0) return { ok: false, reason: "no_uses_left" };
	if (norm(mandate.currency) !== norm(input.currency)) return { ok: false, reason: "currency_mismatch" };
	const merchant = norm(input.merchant);
	if (!merchant || !mandate.merchants.some((m) => norm(m) === merchant)) return { ok: false, reason: "merchant_not_allowed" };
	if (!Number.isFinite(mandate.maxAmount) || input.amount > mandate.maxAmount) return { ok: false, reason: "amount_exceeded" };
	return { ok: true };
}
