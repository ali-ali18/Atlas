// Handler `card_fill` da porta `Sandbox` (F8.0): leva o pedido de pagamento ao control server da VM e devolve só estado.
// REGRA: `params` leva número, CVV, titular e endereço. Nada daqui vai a log, a mensagem de erro, a evento ou ao resultado:
// o resultado é reconstruído campo a campo (nunca repassado) e todo texto livre passa por `redactSecrets` com os segredos.
import { redactSecrets } from "@workspace/shared";
import { SandboxControlError, type ControlCardFillParams } from "@workspace/sandbox";
import type { SandboxKindHandler } from "./sandbox.js";

const str = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max;

/** Valida o formato e devolve o pedido tipado, ou `null`. Não confia em nada que veio da ação. */
export function parseCardFillParams(raw: unknown): ControlCardFillParams | null {
	const p = (typeof raw === "object" && raw !== null ? raw : null) as Record<string, unknown> | null;
	const card = (typeof p?.card === "object" && p.card !== null ? p.card : null) as Record<string, unknown> | null;
	if (!p || !card) return null;
	const billing = (typeof card.billing === "object" && card.billing !== null ? card.billing : null) as Record<string, unknown> | null;
	if (!str(p.url, 2000) || !str(p.merchant, 255) || !str(p.currency, 3) || !str(p.cvv, 4) || typeof p.amount !== "number" || !Number.isFinite(p.amount) || p.amount <= 0 || p.amount > 10_000_000) return null;
	if (!str(card.number, 30) || !str(card.holder, 100) || !Number.isInteger(card.expMonth) || !Number.isInteger(card.expYear)) return null;
	return {
		url: p.url,
		merchant: p.merchant,
		currency: p.currency,
		cvv: p.cvv,
		amount: p.amount,
		card: {
			number: card.number,
			holder: card.holder,
			expMonth: card.expMonth as number,
			expYear: card.expYear as number,
			...(billing && str(billing.line1, 200) && str(billing.city, 100) && str(billing.state, 100) && str(billing.postalCode, 20) && str(billing.country, 2)
				? { billing: { line1: billing.line1, ...(str(billing.line2, 200) && { line2: billing.line2 }), city: billing.city, state: billing.state, postalCode: billing.postalCode, country: billing.country } }
				: {}),
		},
	};
}

/** Tudo que não pode aparecer em saída nenhuma (inclusive as variantes do número com espaço e hífen). */
export function cardSecrets(p: ControlCardFillParams): string[] {
	const digits = p.card.number.replace(/\D/g, "");
	const grouped = digits.match(/.{1,4}/g)?.join(" ") ?? digits;
	const b = p.card.billing;
	return [p.card.number, digits, grouped, grouped.split(" ").join("-"), p.cvv, p.card.holder, ...(b ? [b.line1, b.postalCode] : [])].filter((s) => s.length >= 3);
}

const STATES = new Set(["paid", "challenge", "declined", "failed"]);
const KINDS = new Set(["3ds", "bank_app", "captcha", "other"]);

export const cardFillHandler: SandboxKindHandler = async (ctx, params) => {
	const request = parseCardFillParams(params);
	if (!request) return { ok: false, error: "The payment request was incomplete, so nothing was paid." };
	const secrets = cardSecrets(request);
	const safe = (text: string) => redactSecrets(text, secrets).slice(0, 300);
	try {
		const out: Record<string, unknown> = await ctx.manager.execCardFill(ctx.sessionId, request);
		const state = typeof out.state === "string" && STATES.has(out.state) ? out.state : "failed";
		return {
			ok: true,
			data: {
				state,
				...(state === "challenge" && { kind: typeof out.kind === "string" && KINDS.has(out.kind) ? out.kind : "other" }),
				...(typeof out.orderRef === "string" && out.orderRef && { orderRef: safe(out.orderRef) }),
				...(typeof out.reason === "string" && out.reason && { reason: safe(out.reason) }),
				...(state === "failed" && typeof out.reason !== "string" && { reason: "The store did not confirm the payment. It may have been charged: check the order page before trying again." }),
			},
		};
	} catch (error) {
		// O servidor recusou o pedido antes de mexer na página (corpo inválido/grande): nada foi pago. Qualquer outra falha de
		// transporte (queda, cancelamento, tempo) pode ter acontecido DEPOIS do clique: o resultado diz isso, para o modelo não
		// afirmar "nada foi cobrado" nem repetir sozinho.
		const rejected = error instanceof SandboxControlError && [400, 404, 413].includes(error.status);
		return {
			ok: true,
			data: {
				state: "failed",
				reason: rejected ? "Nothing was paid: the computer rejected the payment request." : safe("The connection to the computer was interrupted during the payment. It may have been charged: check the order page before trying again."),
			},
		};
	}
};
