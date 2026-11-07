// Compra registrada (F6.5): validação pura do que o bot grava, chave de dedupe e o cartão `purchase`.
// O registro é do dono (fato da vida dele); nada aqui move dinheiro.

export const PURCHASE_ITEMS_MAX = 30;
export const PURCHASE_TEXT_MAX = 200;
/** O vigia de entrega acaba sozinho depois disto (ou ao entregar). */
export const PURCHASE_DELIVERY_WATCH_DAYS = 30;
/** 12 h: dentro do piso da agenda (2 h); o espaçamento cresce sozinho enquanto nada muda. */
export const PURCHASE_DELIVERY_WATCH_MINUTES = 720;

export type PurchaseItem = { name: string; quantity: number; unitPrice?: number };

export type PurchaseInput = {
	merchant: string;
	items: PurchaseItem[];
	total: number;
	currency: string;
	/** ISO 8601. */
	purchasedAt: string;
	orderNumber?: string;
	trackingCode?: string;
	trackingUrl?: string;
};

export type PurchaseView = PurchaseInput & { id: string; botId: string | null; createdAt: string };

export type PersistedPurchaseCard = {
	v: 1;
	kind: "purchase";
	/** Id do registro: igual ao vivo e gravado. */
	purchaseId: string;
	runId?: string;
	merchant: string;
	items: PurchaseItem[];
	total: number;
	currency: string;
	purchasedAt: string;
	orderNumber?: string;
	trackingCode?: string;
	trackingUrl?: string;
};

const round2 = (n: number) => Math.round(n * 100) / 100;
const clean = (v: unknown, max = PURCHASE_TEXT_MAX): string | undefined => (typeof v === "string" && v.trim() ? v.replace(/\s+/g, " ").trim().slice(0, max) : undefined);

function httpUrl(v: unknown): string | undefined {
	const s = clean(v, 2000);
	if (!s) return undefined;
	try {
		const u = new URL(s);
		return (u.protocol === "http:" || u.protocol === "https:") && !u.username && !u.password ? u.toString() : undefined;
	} catch {
		return undefined;
	}
}

export type PurchaseParse = { ok: true; value: PurchaseInput } | { ok: false; error: string };

/** Valida e normaliza. Recusa com o campo errado; nunca corrige valor em silêncio. `now` injetado. */
export function normalizePurchaseInput(raw: Record<string, unknown>, now: Date): PurchaseParse {
	const merchant = clean(raw.merchant);
	if (!merchant) return { ok: false, error: "merchant is required (the store name)." };
	if (!Array.isArray(raw.items) || raw.items.length === 0) return { ok: false, error: "items needs at least one item." };
	if (raw.items.length > PURCHASE_ITEMS_MAX) return { ok: false, error: `items has ${raw.items.length}; the limit is ${PURCHASE_ITEMS_MAX}.` };
	const items: PurchaseItem[] = [];
	for (const [i, it] of raw.items.entries()) {
		const r = (typeof it === "object" && it !== null ? it : {}) as Record<string, unknown>;
		const name = clean(r.name);
		const quantity = r.quantity === undefined ? 1 : r.quantity;
		if (!name) return { ok: false, error: `items[${i}].name is required.` };
		if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity < 1 || quantity > 999) return { ok: false, error: `items[${i}].quantity must be a whole number from 1 to 999.` };
		if (r.unitPrice !== undefined && (typeof r.unitPrice !== "number" || !Number.isFinite(r.unitPrice) || r.unitPrice < 0)) return { ok: false, error: `items[${i}].unitPrice must be a number of zero or more.` };
		items.push({ name, quantity, ...(typeof r.unitPrice === "number" && { unitPrice: round2(r.unitPrice) }) });
	}
	if (typeof raw.total !== "number" || !Number.isFinite(raw.total) || raw.total < 0) return { ok: false, error: "total must be a number of zero or more (what was paid, shipping included)." };
	const currency = typeof raw.currency === "string" ? raw.currency.trim().toUpperCase() : "";
	if (!/^[A-Z]{3}$/.test(currency)) return { ok: false, error: "currency must be a 3-letter code like BRL or USD." };
	let purchasedAt = now;
	if (raw.purchasedAt !== undefined) {
		const d = typeof raw.purchasedAt === "string" ? new Date(raw.purchasedAt) : new Date(Number.NaN);
		if (Number.isNaN(d.getTime())) return { ok: false, error: "purchasedAt must be an ISO 8601 date like 2026-11-07 or 2026-11-07T14:30:00Z." };
		// Um dia de folga para fuso; compra no futuro não existe.
		if (d.getTime() > now.getTime() + 24 * 3600_000) return { ok: false, error: "purchasedAt is in the future." };
		purchasedAt = d;
	}
	if (raw.trackingUrl !== undefined && !httpUrl(raw.trackingUrl)) return { ok: false, error: "trackingUrl must be a public http(s) link." };
	const orderNumber = clean(raw.orderNumber, 80);
	const trackingCode = clean(raw.trackingCode, 80);
	const trackingUrl = httpUrl(raw.trackingUrl);
	return { ok: true, value: { merchant, items, total: round2(raw.total), currency, purchasedAt: purchasedAt.toISOString(), ...(orderNumber && { orderNumber }), ...(trackingCode && { trackingCode }), ...(trackingUrl && { trackingUrl }) } };
}

/**
 * Registrar o mesmo pedido duas vezes não duplica: com número do pedido, loja + pedido; sem ele, loja + total + dia.
 */
export function purchaseDedupeKey(p: Pick<PurchaseInput, "merchant" | "orderNumber" | "total" | "currency" | "purchasedAt">): string {
	const merchant = p.merchant.toLowerCase();
	if (p.orderNumber) return `${merchant}|order|${p.orderNumber.toLowerCase()}`;
	return `${merchant}|${p.total.toFixed(2)}|${p.currency}|${p.purchasedAt.slice(0, 10)}`;
}

/** Nota do vigia de entrega (vai ao MODELO, inglês). Só dados que o dono ou a loja deram. */
export function deliveryWatchNote(p: Pick<PurchaseInput, "merchant" | "orderNumber" | "trackingCode" | "trackingUrl" | "items">): string {
	const what = p.items.map((i) => i.name).slice(0, 3).join(", ");
	const ref = [p.orderNumber && `order ${p.orderNumber}`, p.trackingCode && `tracking code ${p.trackingCode}`, p.trackingUrl && `tracking page ${p.trackingUrl}`].filter(Boolean).join("; ");
	return `Follow the delivery of the order at ${p.merchant}${ref ? ` (${ref})` : ""}: ${what}. Check the tracking page, or search the web for the carrier tracking if there is no link. News = the status changed (shipped, out for delivery, delayed, problem, delivered): report with agenda_result update, in the owner's language. Nothing new = no_change. When it is delivered, finish with done.`.slice(0, 1000);
}

export function parsePurchaseCard(row: Record<string, unknown>): PersistedPurchaseCard | null {
	const purchaseId = clean(row.purchaseId, 160);
	if (!purchaseId) return null;
	const parsed = normalizePurchaseInput({ ...row, purchasedAt: row.purchasedAt }, new Date(8.64e15 - 1));
	if (!parsed.ok) return null;
	const runId = clean(row.runId, 160);
	return { v: 1, kind: "purchase", purchaseId, ...(runId && { runId }), ...parsed.value };
}
