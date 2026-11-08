// Produto de loja (F6.1): extração ESTRUTURADA da página (JSON-LD `Product`/`Offer`/`AggregateRating`, OpenGraph e, como
// reserva, `<title>` e a meta description) e comparação de lojas pelo TOTAL = preço + frete. Tudo puro (sem rede, sem
// relógio). O que a página não traz simplesmente não existe no resultado: nada é inventado, e frete desconhecido nunca é
// somado como zero. Regex só para ler FORMATO de marcação (tags e atributos); nenhuma decisão de comportamento lê texto.
import { decodeEntities } from "./web/html-text.js";

export const PRODUCT_AVAILABILITIES = ["in_stock", "out_of_stock", "preorder", "limited", "unknown"] as const;
export type ProductAvailability = (typeof PRODUCT_AVAILABILITIES)[number];

/** Frete explícito: `unknown` = a página não informa ("frete não informado"); nunca vira zero. */
export type ProductShipping = { kind: "free" } | { kind: "paid"; amount: number } | { kind: "unknown" };

export type ProductRating = { value: number; best: number; count?: number };

export const PRODUCT_MAX_IMAGES = 6;
export const PRODUCT_DESCRIPTION_MAX_CHARS = 400;
export const PRODUCT_CARD_MAX_ITEMS = 8;

export type ProductOffer = {
	name: string;
	merchant: string;
	url: string;
	price: number | null;
	/** Preço antes do desconto, só quando a página traz e é maior que o preço. */
	oldPrice?: number;
	currency: string | null;
	shipping: ProductShipping;
	/** Preço + frete. `null` quando o preço ou o frete não são conhecidos (nunca soma zero em silêncio). */
	total: number | null;
	availability: ProductAvailability;
	/** Só http(s). A primeira é a principal. */
	images: string[];
	description?: string;
	rating?: ProductRating;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Preço + frete. `null` se faltar o preço ou se o frete for desconhecido. */
export function offerTotal(price: number | null, shipping: ProductShipping): number | null {
	if (price === null) return null;
	if (shipping.kind === "free") return round2(price);
	if (shipping.kind === "paid") return round2(price + shipping.amount);
	return null;
}

/** Desconto inteiro em % quando há preço antigo maior que o atual. */
export function discountPercent(offer: Pick<ProductOffer, "price" | "oldPrice">): number | null {
	if (offer.price === null || offer.oldPrice === undefined || offer.oldPrice <= offer.price) return null;
	return Math.round((1 - offer.price / offer.oldPrice) * 100);
}

// ---------------------------------------------------------------- leitura de marcação

type Json = unknown;
const isRecord = (v: Json): v is Record<string, Json> => typeof v === "object" && v !== null && !Array.isArray(v);

function attrs(tag: string): Record<string, string> {
	const out: Record<string, string> = {};
	const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
	for (const m of tag.matchAll(re)) out[m[1]!.toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? "");
	return out;
}

function jsonLdBlocks(html: string): Json[] {
	const blocks: Json[] = [];
	const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
	for (const m of html.matchAll(re)) {
		if (!(attrs(m[1] ?? "").type ?? "").toLowerCase().includes("ld+json")) continue;
		try {
			blocks.push(JSON.parse((m[2] ?? "").trim()));
		} catch {
			// JSON-LD quebrado é comum; o bloco é ignorado e a página segue com o resto.
		}
	}
	return blocks;
}

function metaMap(html: string): Map<string, string> {
	const map = new Map<string, string>();
	for (const m of html.matchAll(/<meta\b([^>]*)>/gi)) {
		const a = attrs(m[1] ?? "");
		const key = (a.property ?? a.name ?? a.itemprop ?? "").toLowerCase();
		const content = a.content?.trim();
		if (key && content && !map.has(key)) map.set(key, content);
	}
	return map;
}

function titleTag(html: string): string | undefined {
	const m = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
	const t = m ? decodeEntities(m[1] ?? "").replace(/\s+/g, " ").trim() : "";
	return t || undefined;
}

/** Percorre `@graph`, listas e `mainEntity` atrás de nós com o `@type` pedido. */
function findNodes(root: Json, type: string, out: Record<string, Json>[] = []): Record<string, Json>[] {
	if (Array.isArray(root)) {
		for (const item of root) findNodes(item, type, out);
		return out;
	}
	if (!isRecord(root)) return out;
	const t = root["@type"];
	const types = Array.isArray(t) ? t : [t];
	if (types.includes(type)) out.push(root);
	for (const key of ["@graph", "mainEntity", "itemListElement", "item"]) if (key in root) findNodes(root[key], type, out);
	return out;
}

function str(v: Json): string | undefined {
	if (typeof v === "string") return v.trim() || undefined;
	if (typeof v === "number" && Number.isFinite(v)) return String(v);
	return undefined;
}

/** Moedas em que o ponto separa milhar e a vírgula é decimal ("1.299,90"). */
const DOT_THOUSANDS_CURRENCIES = new Set(["BRL", "EUR", "ARS", "CLP", "COP", "PYG", "UYU", "DKK", "TRY", "VND", "IDR"]);
/** Moedas em que a vírgula separa milhar e o ponto é decimal ("1,299.90"). */
const COMMA_THOUSANDS_CURRENCIES = new Set(["USD", "GBP", "CAD", "AUD", "NZD", "MXN", "JPY", "CNY", "HKD", "SGD", "INR", "ZAR"]);

/**
 * "199.90", 199.9, "1.299,90" e "1,299.90": com os dois separadores o último é o decimal. Com UM separador seguido de
 * exatamente 3 dígitos ("1.299", "1,299") o texto é ambíguo (milhar ou decimal?): só a moeda resolve (BRL/EUR: ponto é milhar;
 * USD/GBP: vírgula é milhar); sem moeda que resolva, devolve `null` (preço desconhecido), nunca um palpite. Negativo vira
 * `null`, e zero também, salvo `allowZero` (frete grátis é 0 de verdade).
 */
export function parseMoneyNumber(v: Json, options: { currency?: string | null; allowZero?: boolean } = {}): number | null {
	const accept = (n: number): number | null => (Number.isFinite(n) && n >= 0 && (n > 0 || options.allowZero === true) ? round2(n) : null);
	if (typeof v === "number") return accept(v);
	if (typeof v !== "string") return null;
	// Sinal negativo antes do primeiro dígito ("-10", "R$ -10"): não é preço.
	const firstDigit = v.search(/\d/);
	if (firstDigit < 0 || /[-\u2212]/.test(v.slice(0, firstDigit))) return null;
	let s = v.replace(/[^\d.,]/g, "");
	const lastDot = s.lastIndexOf(".");
	const lastComma = s.lastIndexOf(",");
	if (lastDot >= 0 && lastComma >= 0) {
		const dec = Math.max(lastDot, lastComma);
		s = `${s.slice(0, dec).replace(/[.,]/g, "")}.${s.slice(dec + 1)}`;
	} else if (lastDot >= 0 || lastComma >= 0) {
		const sep = lastDot >= 0 ? "." : ",";
		const parts = s.split(sep);
		const tail = parts[parts.length - 1] ?? "";
		const repeated = parts.length > 2;
		if (repeated) {
			// "1.299.000": o separador repetido só pode ser milhar.
			s = parts.join("");
		} else if (tail.length === 3 && parts[0] !== "0") {
			const currency = options.currency?.toUpperCase() ?? "";
			const thousands = sep === "." ? DOT_THOUSANDS_CURRENCIES.has(currency) : COMMA_THOUSANDS_CURRENCIES.has(currency);
			if (!thousands) return null;
			s = parts.join("");
		} else s = parts.join(".");
	}
	return accept(Number(s));
}

/** Quantidade ("1.234 avaliações", 1234): só dígitos; separadores são de milhar. */
function parseCount(v: Json): number | null {
	if (typeof v === "number") return Number.isFinite(v) && v >= 0 ? v : null;
	if (typeof v !== "string") return null;
	const digits = v.replace(/\D/g, "");
	return digits ? Number(digits) : null;
}

function currencyOf(v: Json): string | null {
	const s = str(v)?.toUpperCase();
	return s && /^[A-Z]{3}$/.test(s) ? s : null;
}

function httpUrl(raw: Json, base: string): string | undefined {
	const s = str(raw);
	if (!s) return undefined;
	try {
		const u = new URL(s, base);
		return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : undefined;
	} catch {
		return undefined;
	}
}

function imageList(v: Json, base: string, out: string[] = []): string[] {
	if (Array.isArray(v)) for (const item of v) imageList(item, base, out);
	else if (isRecord(v)) imageList(v.url ?? v.contentUrl, base, out);
	else {
		const u = httpUrl(v, base);
		if (u && !out.includes(u)) out.push(u);
	}
	return out;
}

function availabilityOf(v: Json): ProductAvailability {
	const s = str(v);
	if (!s) return "unknown";
	const tail = (s.split("/").pop() ?? s).toLowerCase().replace(/[^a-z]/g, "");
	switch (tail) {
		case "instock":
		case "onlineonly":
		case "instoreonly":
			return "in_stock";
		case "outofstock":
		case "soldout":
		case "discontinued":
			return "out_of_stock";
		case "preorder":
		case "presale":
		case "backorder":
			return "preorder";
		case "limitedavailability":
			return "limited";
		default:
			return "unknown";
	}
}

function shippingOf(offer: Record<string, Json>, currency: string | null): ProductShipping {
	const details = offer.shippingDetails;
	const list = Array.isArray(details) ? details : details ? [details] : [];
	for (const d of list) {
		if (!isRecord(d)) continue;
		const rate = d.shippingRate;
		if (!isRecord(rate)) continue;
		const rateCurrency = currencyOf(rate.currency);
		const amount = parseMoneyNumber(rate.value, { currency: rateCurrency ?? currency, allowZero: true });
		if (amount === null) continue;
		// Frete em outra moeda não soma com o preço: tratado como não informado.
		if (rateCurrency && currency && rateCurrency !== currency) continue;
		return amount === 0 ? { kind: "free" } : { kind: "paid", amount };
	}
	return { kind: "unknown" };
}

type Picked = { price: number | null; oldPrice?: number; currency: string | null; availability: ProductAvailability; shipping: ProductShipping };

function offerCandidates(raw: Json): Record<string, Json>[] {
	const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
	const out: Record<string, Json>[] = [];
	for (const o of list) {
		if (!isRecord(o)) continue;
		if (Array.isArray(o.offers)) out.push(...offerCandidates(o.offers));
		else out.push(o);
	}
	return out;
}

function pickOffer(raw: Json): Picked | null {
	const cands = offerCandidates(raw).map((o): Picked & { raw: Record<string, Json> } => {
		const spec = Array.isArray(o.priceSpecification) ? o.priceSpecification.find(isRecord) : isRecord(o.priceSpecification) ? o.priceSpecification : undefined;
		const currency = currencyOf(o.priceCurrency ?? spec?.priceCurrency);
		const price = parseMoneyNumber(o.price ?? o.lowPrice ?? spec?.price, { currency });
		const listPrice = isRecord(o.priceSpecification) && str(o.priceSpecification.priceType)?.toLowerCase().includes("listprice") ? parseMoneyNumber(o.priceSpecification.price, { currency }) : null;
		const highPrice = parseMoneyNumber(o.highPrice, { currency });
		const old = listPrice ?? (o["@type"] === "AggregateOffer" ? null : highPrice);
		return { raw: o, price, currency, availability: availabilityOf(o.availability), shipping: shippingOf(o, currency), ...(price !== null && old !== null && old > price && { oldPrice: old }) };
	});
	if (cands.length === 0) return null;
	// Prefere oferta com preço e em estoque; dentro disso, a mais barata.
	const rank = (c: Picked) => (c.price === null ? 2 : c.availability === "out_of_stock" ? 1 : 0);
	cands.sort((a, b) => rank(a) - rank(b) || (a.price ?? 0) - (b.price ?? 0));
	const { raw: _raw, ...best } = cands[0]!;
	void _raw;
	return best;
}

function ratingOf(v: Json): ProductRating | undefined {
	if (!isRecord(v)) return undefined;
	const value = parseMoneyNumber(v.ratingValue);
	if (value === null) return undefined;
	const best = parseMoneyNumber(v.bestRating) ?? 5;
	if (best <= 0 || value > best) return undefined;
	const count = parseCount(v.ratingCount ?? v.reviewCount);
	return { value, best, ...(count !== null && count > 0 && { count: Math.round(count) }) };
}

function cleanDescription(s: string | undefined): string | undefined {
	if (!s) return undefined;
	const t = decodeEntities(s.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
	if (!t) return undefined;
	return t.length > PRODUCT_DESCRIPTION_MAX_CHARS ? `${t.slice(0, PRODUCT_DESCRIPTION_MAX_CHARS - 1).trimEnd()}…` : t;
}

function hostLabel(url: string): string {
	try {
		return new URL(url).hostname.replace(/^www\./i, "");
	} catch {
		return url;
	}
}

/**
 * Lê UMA página de produto. `null` quando não há dado estruturado de produto (nem `Product` em JSON-LD, nem preço em
 * OpenGraph): a tool então diz isso ao modelo em vez de chutar. Campos ausentes na página ficam ausentes.
 */
export function parseProductPage(html: string, pageUrl: string): ProductOffer | null {
	const meta = metaMap(html);
	const products = jsonLdBlocks(html).flatMap((b) => findNodes(b, "Product"));
	const product = products.find((p) => p.offers !== undefined) ?? products[0];
	const offer = product ? pickOffer(product.offers) : null;

	const ogCurrency = currencyOf(meta.get("product:price:currency") ?? meta.get("og:price:currency"));
	const ogPrice = parseMoneyNumber(meta.get("product:price:amount") ?? meta.get("og:price:amount"), { currency: ogCurrency });
	if (!product && ogPrice === null) return null;

	const name = str(product?.name) ?? meta.get("og:title") ?? titleTag(html);
	if (!name) return null;
	const price = offer?.price ?? ogPrice;
	const currency = offer?.currency ?? ogCurrency;
	const shipping = offer?.shipping ?? { kind: "unknown" as const };
	const availability = offer && offer.availability !== "unknown" ? offer.availability : availabilityOf(meta.get("product:availability") ?? meta.get("og:availability"));
	const seller = isRecord(product?.offers) && isRecord(product.offers.seller) ? str(product.offers.seller.name) : Array.isArray(product?.offers) && isRecord(product.offers[0]) && isRecord(product.offers[0].seller) ? str(product.offers[0].seller.name) : undefined;
	const merchant = seller ?? meta.get("og:site_name") ?? hostLabel(pageUrl);

	const images = imageList(product?.image, pageUrl);
	for (const key of ["og:image", "og:image:url", "twitter:image"]) imageList(meta.get(key), pageUrl, images);
	const description = cleanDescription(str(product?.description) ?? meta.get("og:description") ?? meta.get("description"));
	const rating = ratingOf(product?.aggregateRating);

	return {
		name: decodeEntities(name).replace(/\s+/g, " ").trim().slice(0, 300),
		merchant: merchant.slice(0, 120),
		url: httpUrl(meta.get("og:url"), pageUrl) && hostLabel(httpUrl(meta.get("og:url"), pageUrl)!) === hostLabel(pageUrl) ? httpUrl(meta.get("og:url"), pageUrl)! : pageUrl,
		price,
		...(offer?.oldPrice !== undefined && { oldPrice: offer.oldPrice }),
		currency,
		shipping,
		total: offerTotal(price, shipping),
		availability,
		images: images.slice(0, PRODUCT_MAX_IMAGES),
		...(description && { description }),
		...(rating && { rating }),
	};
}

// ---------------------------------------------------------------- comparação

export type OfferComparison = {
	/** Mais barata pelo TOTAL, só entre as comparáveis (mesma moeda, frete conhecido, fora de estoque não conta). */
	cheapestUrl?: string;
	/** Alguma loja sem total (preço ou frete desconhecido): o "mais barata" pode estar errado. */
	incomplete: boolean;
	mixedCurrency: boolean;
};

export function compareOffers(offers: readonly ProductOffer[]): OfferComparison {
	const known = offers.filter((o) => o.total !== null && o.currency !== null);
	const mixedCurrency = new Set(known.map((o) => o.currency)).size > 1;
	const incomplete = offers.some((o) => o.total === null);
	if (mixedCurrency) return { incomplete, mixedCurrency };
	const buyable = known.filter((o) => o.availability !== "out_of_stock");
	const cheapest = buyable.reduce<ProductOffer | undefined>((best, o) => (best === undefined || o.total! < best.total! ? o : best), undefined);
	return { ...(cheapest && { cheapestUrl: cheapest.url }), incomplete, mixedCurrency };
}

export function formatMoney(amount: number, currency: string | null): string {
	return `${amount.toFixed(2)}${currency ? ` ${currency}` : ""}`;
}

/** Linha para o MODELO (inglês): o total é explícito e o frete desconhecido é dito, nunca zero. */
export function describeOffer(o: ProductOffer): string {
	const price = o.price === null ? "price not found" : `price ${formatMoney(o.price, o.currency)}${o.oldPrice !== undefined ? ` (was ${formatMoney(o.oldPrice, o.currency)})` : ""}`;
	const ship = o.shipping.kind === "free" ? "shipping free" : o.shipping.kind === "paid" ? `shipping ${formatMoney(o.shipping.amount, o.currency)}` : "shipping not informed";
	const total = o.total === null ? (o.price === null ? "total unknown" : "total unknown (shipping not informed, do not assume zero)") : `TOTAL ${formatMoney(o.total, o.currency)}`;
	const extra = [o.availability !== "unknown" && o.availability.replace("_", " "), o.rating && `rating ${o.rating.value}/${o.rating.best}${o.rating.count ? ` (${o.rating.count})` : ""}`].filter(Boolean).join(", ");
	return `${o.name} @ ${o.merchant}: ${price}; ${ship}; ${total}${extra ? `; ${extra}` : ""}\n${o.url}`;
}

// ---------------------------------------------------------------- card

/** Cartão `product`: um produto ou vários (comparar). Persistido como mensagem da conversa. */
export type PersistedProductCard = {
	v: 1;
	kind: "product";
	/** Estável entre ao vivo e gravado (`<run>:product:<hash das URLs>`). */
	cardId: string;
	runId?: string;
	items: ProductOffer[];
	cheapestUrl?: string;
	incomplete?: boolean;
};

/** Hash FNV-1a curto e determinístico (puro; sem `crypto`). */
function fnv(s: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h.toString(16).padStart(8, "0");
}

export function productCardId(runId: string, urls: readonly string[]): string {
	return `${runId}:product:${fnv([...urls].sort().join("|"))}`;
}

function parseShipping(v: Json): ProductShipping | null {
	if (!isRecord(v)) return null;
	if (v.kind === "free" || v.kind === "unknown") return { kind: v.kind };
	if (v.kind === "paid" && typeof v.amount === "number" && Number.isFinite(v.amount) && v.amount > 0) return { kind: "paid", amount: round2(v.amount) };
	return null;
}

const finite = (v: Json): v is number => typeof v === "number" && Number.isFinite(v);

/** Revalida um item gravado: sempre recomputa o total (o gravado nunca é confiado) e descarta imagem que não seja http(s). */
export function parseProductOffer(v: Json): ProductOffer | null {
	if (!isRecord(v)) return null;
	const name = str(v.name);
	const merchant = str(v.merchant);
	const url = httpUrl(v.url, "https://invalid.local");
	const shipping = parseShipping(v.shipping);
	if (!name || !merchant || !url || !shipping) return null;
	const price = v.price === null ? null : finite(v.price) && v.price >= 0 ? round2(v.price) : undefined;
	if (price === undefined) return null;
	const availability = (PRODUCT_AVAILABILITIES as readonly string[]).includes(v.availability as string) ? (v.availability as ProductAvailability) : "unknown";
	const images = (Array.isArray(v.images) ? v.images : []).map((i) => httpUrl(i, "https://invalid.local")).filter((i): i is string => !!i).slice(0, PRODUCT_MAX_IMAGES);
	const rating = isRecord(v.rating) && finite(v.rating.value) && finite(v.rating.best) && v.rating.best > 0 && v.rating.value <= v.rating.best ? { value: v.rating.value, best: v.rating.best, ...(finite(v.rating.count) && v.rating.count > 0 && { count: Math.round(v.rating.count) }) } : undefined;
	const description = cleanDescription(str(v.description));
	return {
		name: name.slice(0, 300),
		merchant: merchant.slice(0, 120),
		url,
		price,
		...(finite(v.oldPrice) && price !== null && v.oldPrice > price && { oldPrice: round2(v.oldPrice) }),
		currency: currencyOf(v.currency),
		shipping,
		total: offerTotal(price, shipping),
		availability,
		images,
		...(description && { description }),
		...(rating && { rating }),
	};
}

export function parseProductCard(row: Record<string, Json>): PersistedProductCard | null {
	const cardId = str(row.cardId);
	if (!cardId || !Array.isArray(row.items)) return null;
	const items = row.items.map(parseProductOffer).filter((i): i is ProductOffer => i !== null).slice(0, PRODUCT_CARD_MAX_ITEMS);
	if (items.length === 0) return null;
	const comparison = compareOffers(items);
	return {
		v: 1,
		kind: "product",
		cardId: cardId.slice(0, 160),
		...(str(row.runId) && { runId: str(row.runId)! }),
		items,
		// Recalculado: o card nunca afirma "mais barata" que o dado não sustenta.
		...(items.length > 1 && comparison.cheapestUrl && { cheapestUrl: comparison.cheapestUrl }),
		...(items.length > 1 && comparison.incomplete && { incomplete: true }),
	};
}
