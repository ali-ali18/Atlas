/**
 * Modo guiado do alerta de página: acha onde um valor que a IA (ou o usuário) viu aparece no HTML e propõe um
 * seletor CSS estável para a regra lê-lo depois, sem modelo. O HTML é dado não confiável: nada aqui executa script,
 * e o que sai (leitura, contexto) é texto saneado e curto, nunca HTML cru.
 *
 * Como funciona:
 * 1. dados estruturados primeiro (`meta[itemprop=price]`, `meta[property=product:price:amount]`, `[itemprop=price]`,
 *    JSON-LD `offers.price`), depois todo elemento visível cujo texto contém o número (o menor elemento que o contém);
 * 2. cada ocorrência só vira candidata se a regra leria o MESMO valor (o primeiro número do elemento, como o avaliador);
 * 3. o seletor prefere id, atributos `data-*`/`itemprop` e classes com significado, ancorando em ancestrais quando
 *    preciso; recusa classe gerada e índice (`nth-child`), e só vale se casar exatamente 1 elemento no documento.
 */
import { parseHTML } from "linkedom";
import {
	isNumericPageValue,
	isStableClass,
	isStableId,
	normalizePageText,
	pageTextHasValue,
	pageValuesMatch,
	sanitizeAlertExternalText,
} from "@workspace/shared";
import { fetchAlertPage, type AlertSourceDeps, type AlertSourceFailure } from "./alert-source.js";

export const PAGE_VALUE_MAX_CANDIDATES = 10;
const MAX_HITS = 200;
const MAX_DEPTH = 300;
const TEXT_CAP = 400;
const DIRECT_TEXT_MAX = 2000;
const SPAN_TEXT_MAX = 160;
const SELECTOR_ATTEMPTS = 80;
const CONTEXT_CHARS = 160;

export type PageValueExtract = { kind: "css"; selector: string; attribute?: string };

export type PageValueCandidate = {
	/** structured = campo de dados estruturados (meta/itemprop/JSON-LD); css = elemento visível. */
	type: "structured" | "css";
	/** Pronto para `rule.source.extract`; null = achei o valor, mas não há jeito estável de a regra lê-lo. */
	extract: PageValueExtract | null;
	/** O que a regra leria agora (texto do elemento ou do atributo), saneado. */
	reading: string;
	/** ~120 caracteres de texto visível em volta, saneado. */
	context: string;
	/** O texto de contexto (`near`) aparece no elemento ou num ancestral próximo. */
	nearMatch: boolean;
	note?: string;
};

export type LocatePageValueResult = {
	candidates: PageValueCandidate[];
	/** Quantas ocorrências leríveis a página tem (pode passar de 10). */
	total: number;
	/** Ocorrências em que o valor não é o primeiro número do elemento: a regra leria outro número. */
	skipped: number;
};

const SKIP_TAGS = new Set(["script", "style", "noscript", "template", "svg", "head", "iframe", "object", "canvas", "title"]);
const STRUCTURED_META = [
	'meta[itemprop="price"]',
	'meta[itemprop="lowPrice"]',
	'meta[property="product:price:amount"]',
	'meta[property="og:price:amount"]',
	'meta[property="product:sale_price:amount"]',
].join(", ");
/** Atributos que distinguem um elemento de forma estável quando o valor não tem número. */
const ATTR_STEP = ["itemprop", "property", "data-testid", "data-test", "data-test-id", "data-qa", "data-cy", "data-automation-id", "data-role", "name"] as const;
const PRICE_ATTR = /^data-[a-z-]*(?:price|preco|valor|value|amount|cost)[a-z-]*$/i;

type Hit = { el: Element; order: number; attribute?: string; structured: boolean };

function squeeze(text: string | null | undefined): string {
	return (text ?? "").replace(/\s+/g, " ").trim();
}

function tagOf(el: Element): string {
	return (el.localName || el.tagName).toLowerCase();
}

function isSkipped(el: Element): boolean {
	if (SKIP_TAGS.has(tagOf(el))) return true;
	if (el.hasAttribute("hidden")) return true;
	return /display\s*:\s*none/i.test(el.getAttribute("style") ?? "");
}

/**
 * Texto visível de um elemento para contexto e proximidade: sem script/estilo/escondido, com espaço entre elementos
 * (para ler "Galaxy X 256 GB R$ 3.299,00") e parando em `cap` caracteres, então nunca lê o documento inteiro.
 * Com `mark`, devolve também onde o elemento marcado começa e termina no texto.
 */
function visibleText(el: Element, cap: number, mark?: Element): { text: string; start: number; end: number } {
	const state = { text: "", start: -1, end: -1 };
	const collect = (node: Node, depth: number): void => {
		if (state.text.length >= cap || depth > 80) return;
		if (node === mark) state.start = state.text.length;
		if (node.nodeType === 3) {
			state.text += node.nodeValue ?? "";
			return;
		}
		if (node.nodeType !== 1 || isSkipped(node as Element)) return;
		state.text += " ";
		for (let child = node.firstChild; child; child = child.nextSibling) collect(child, depth + 1);
		state.text += " ";
		if (node === mark) state.end = state.text.length;
	};
	collect(el, 0);
	return state;
}

/** Percorre o DOM uma vez e junta as ocorrências visíveis do valor (o menor elemento que o contém). */
function collectVisibleHits(root: Element, value: string): { hits: Hit[]; capped: boolean } {
	const hits: Hit[] = [];
	const numeric = isNumericPageValue(value);
	let order = 0;
	let capped = false;
	const walk = (el: Element, depth: number): { text: string; hit: boolean } => {
		if (isSkipped(el) || depth > MAX_DEPTH) return { text: "", hit: false };
		const myOrder = order++;
		let text = "";
		let childHit = false;
		let directHit = false;
		let attributeHit = false;
		if (numeric && el.hasAttribute("itemprop")) {
			const content = el.getAttribute("content");
			if (content && pageValuesMatch(content, value)) {
				if (hits.length < MAX_HITS) hits.push({ el, order: myOrder, attribute: "content", structured: true });
				attributeHit = true;
			}
		}
		if (numeric) {
			for (const attr of Array.from(el.attributes)) {
				if (!PRICE_ATTR.test(attr.name) || !attr.value || !pageValuesMatch(attr.value, value)) continue;
				if (hits.length < MAX_HITS) hits.push({ el, order: myOrder, attribute: attr.name, structured: false });
				attributeHit = true;
			}
		}
		for (let child = el.firstChild; child; child = child.nextSibling) {
			if (child.nodeType === 3) {
				const part = child.nodeValue ?? "";
				if (text.length < TEXT_CAP) text += part;
				if (part.length <= DIRECT_TEXT_MAX && pageTextHasValue(part, value)) directHit = true;
			} else if (child.nodeType === 1) {
				const result = walk(child as Element, depth + 1);
				if (text.length < TEXT_CAP) text += result.text;
				if (result.hit) childHit = true;
			}
		}
		// O valor pode estar partido em vários elementos (`<span>R$</span><span>16</span><span>,47</span>`): o pai curto que o junta é o menor.
		const spanHit = !directHit && !childHit && text.length <= SPAN_TEXT_MAX && pageTextHasValue(text, value);
		if ((directHit || spanHit) && !attributeHit) {
			if (hits.length < MAX_HITS) hits.push({ el, order: myOrder, structured: el.getAttribute("itemprop") === "price" });
			else capped = true;
		}
		return { text: text.slice(0, TEXT_CAP), hit: directHit || spanHit || childHit || attributeHit };
	};
	walk(root, 0);
	return { hits, capped };
}

// ---------------------------------------------------------------- seletor

/** Valor de atributo que identifica o elemento (sku, papel, variante), sem ser o preço procurado nem um id numérico comprido. */
function identityAttrValue(value: string, searched: string): boolean {
	return /^[A-Za-z][\w .:-]{0,39}$/.test(value) && !/\d{6,}/.test(value) && !pageTextHasValue(value, searched);
}
/** Atributos de runtime/framework que mudam a cada render: nunca entram no seletor. */
const VOLATILE_ATTR = /react|key|index|idx|uid|guid|session|token|nonce|csrf|time|hash|rand/i;

/** Jeitos estáveis de apontar para o elemento, do mais específico ao menos. Nunca índice nem classe gerada. */
function ownVariants(el: Element, searched: string): string[] {
	const tag = tagOf(el);
	const out: string[] = [];
	const id = el.getAttribute("id");
	if (id && isStableId(id)) out.push(`#${id}`);
	for (const name of ATTR_STEP) {
		const attr = el.getAttribute(name);
		if (attr !== null && identityAttrValue(attr, searched)) out.push(`${tag}[${name}="${attr}"]`);
	}
	for (const attr of Array.from(el.attributes)) {
		if (!/^data-[a-z][a-z-]{2,38}$/.test(attr.name) || (ATTR_STEP as readonly string[]).includes(attr.name) || VOLATILE_ATTR.test(attr.name)) continue;
		if (attr.value === "") out.push(`${tag}[${attr.name}]`);
		else if (identityAttrValue(attr.value, searched)) out.push(`${tag}[${attr.name}="${attr.value}"]`);
		else if (PRICE_ATTR.test(attr.name)) out.push(`${tag}[${attr.name}]`);
	}
	const classes = (el.getAttribute("class") ?? "").split(/\s+/).filter((name) => name && isStableClass(name)).slice(0, 3);
	if (classes.length > 0) {
		out.push(`${tag}.${classes.join(".")}`);
		if (classes.length > 1) for (const name of classes) out.push(`${tag}.${name}`);
	}
	return out;
}

function proposeSelector(document: Document, el: Element, searched: string): string | null {
	const isOnly = (selector: string): boolean => {
		try {
			const found = document.querySelectorAll(selector);
			return found.length === 1 && found[0] === el;
		} catch {
			return false;
		}
	};
	const own = ownVariants(el, searched);
	for (const variant of own) if (isOnly(variant)) return variant;
	const anchors: string[][] = [];
	for (let parent = el.parentElement; parent && anchors.length < 6; parent = parent.parentElement) {
		const name = tagOf(parent);
		if (name === "html" || name === "body") break;
		const variants = ownVariants(parent, searched).slice(0, 2);
		if (variants.length > 0) anchors.push(variants);
	}
	const targets = [...own.slice(0, 3), tagOf(el)];
	let attempts = 0;
	const tryIt = (selector: string): boolean => attempts++ < SELECTOR_ATTEMPTS && isOnly(selector);
	for (const target of targets) {
		for (const anchor of anchors) for (const variant of anchor) if (tryIt(`${variant} ${target}`)) return `${variant} ${target}`;
	}
	for (const target of targets) {
		for (let near = 0; near < anchors.length; near += 1) {
			for (let far = near + 1; far < anchors.length; far += 1) {
				const selector = `${anchors[far]![0]} ${anchors[near]![0]} ${target}`;
				if (tryIt(selector)) return selector;
			}
		}
	}
	return null;
}

/** O que a regra leria com esse extract (mesmo caminho do leitor de alertas: 1º elemento, texto ou atributo). */
function readExtract(document: Document, extract: PageValueExtract): string {
	let first: Element | undefined;
	try {
		first = document.querySelectorAll(extract.selector)[0] as Element | undefined;
	} catch {
		return "";
	}
	if (!first) return "";
	return squeeze(extract.attribute ? first.getAttribute(extract.attribute) : first.textContent);
}

// ---------------------------------------------------------------- contexto e proximidade

const isPageRoot = (el: Element | null): boolean => !el || tagOf(el) === "body" || tagOf(el) === "html";

/** ~120 caracteres de texto visível em volta: o que vem antes do elemento, o valor e o que vem depois. */
function contextAround(el: Element, reading: string): string {
	let anchor: Element = el;
	for (let level = 0; level < 3 && !isPageRoot(anchor.parentElement); level += 1) {
		if (squeeze(visibleText(anchor, 600).text).length >= reading.length + 15) break;
		anchor = anchor.parentElement as Element;
	}
	const { text, start, end } = visibleText(anchor, 1500, el);
	if (start < 0 || end < start) return sanitizeAlertExternalText(squeeze(text), CONTEXT_CHARS);
	const before = squeeze(text.slice(0, start)).slice(-60);
	const after = squeeze(text.slice(end)).slice(0, 50);
	return sanitizeAlertExternalText(`${before} ${squeeze(text.slice(start, end))} ${after}`, CONTEXT_CHARS);
}

/** O texto de contexto (`near`) está no elemento ou num ancestral estreito (até 6 níveis e 800 caracteres, sem chegar ao body). */
function containsNear(el: Element, near: string): boolean {
	if (tagOf(el) === "meta") return false;
	let node: Element | null = el;
	for (let level = 0; node && !isPageRoot(node) && level < 7; level += 1, node = node.parentElement) {
		const text = visibleText(node, 800).text;
		if (normalizePageText(text).includes(near)) return true;
		if (text.length >= 800) return false;
	}
	return false;
}

// ---------------------------------------------------------------- JSON-LD

type JsonLdPrice = { key: string; price: string; label: string; nearText: string };

function collectJsonLdPrices(document: Document, value: string): JsonLdPrice[] {
	const found: JsonLdPrice[] = [];
	let visited = 0;
	const walk = (node: unknown, product: Record<string, unknown> | null, depth: number): void => {
		if (!node || typeof node !== "object" || depth > 8 || visited++ > 2000) return;
		if (Array.isArray(node)) {
			for (const item of node) walk(item, product, depth + 1);
			return;
		}
		const row = node as Record<string, unknown>;
		const here = typeof row.name === "string" || typeof row.sku === "string" ? row : product;
		for (const key of ["price", "lowPrice", "highPrice"]) {
			const raw = row[key];
			if ((typeof raw === "string" || typeof raw === "number") && pageValuesMatch(String(raw), value)) {
				const name = typeof here?.name === "string" ? here.name : "";
				const sku = typeof here?.sku === "string" ? here.sku : "";
				const description = typeof here?.description === "string" ? here.description.slice(0, 200) : "";
				found.push({ key, price: String(raw), label: name || sku, nearText: [name, sku, description].join(" ") });
			}
		}
		for (const [key, child] of Object.entries(row)) if (child && typeof child === "object" && key !== "@context") walk(child, here, depth + 1);
	};
	for (const script of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
		try {
			walk(JSON.parse(script.textContent ?? ""), null, 0);
		} catch {
			// JSON-LD quebrado é comum; segue com o resto.
		}
	}
	return found;
}

// ---------------------------------------------------------------- localizador

/**
 * Procura `value` no HTML e devolve até 10 ocorrências: dados estruturados primeiro, depois as que têm `near` por
 * perto, depois o resto na ordem da página. Não lança.
 */
export function locatePageValue(html: string, value: string, near?: string): LocatePageValueResult {
	if (!html.trim()) return { candidates: [], total: 0, skipped: 0 };
	const { document } = parseHTML(html);
	const wantedNear = near ? normalizePageText(near) : "";
	const numeric = isNumericPageValue(value);
	const hits: Hit[] = [];

	if (numeric) {
		for (const el of Array.from(document.querySelectorAll(STRUCTURED_META)) as Element[]) {
			const content = el.getAttribute("content");
			if (content && pageValuesMatch(content, value)) hits.push({ el, order: -1, attribute: "content", structured: true });
		}
	}
	const body = (document.body ?? document.documentElement) as Element | null;
	if (body) hits.push(...collectVisibleHits(body, value).hits);

	type Ranked = { hit: Hit; reading: string; near: boolean };
	const ranked: Ranked[] = [];
	let skipped = 0;
	for (const hit of hits) {
		const reading = squeeze(hit.attribute ? hit.el.getAttribute(hit.attribute) : hit.el.textContent);
		// A regra lê o primeiro número do elemento: se não é o valor, essa ocorrência levaria ao número errado.
		if (!pageValuesMatch(reading, value)) {
			skipped += 1;
			continue;
		}
		ranked.push({ hit, reading, near: wantedNear ? containsNear(hit.el, wantedNear) : false });
	}
	ranked.sort((a, b) => Number(b.hit.structured) - Number(a.hit.structured) || Number(b.near) - Number(a.near) || a.hit.order - b.hit.order);

	const candidates: PageValueCandidate[] = [];
	const seen = new Set<string>();
	let total = 0;
	for (const item of ranked) {
		const { hit, reading } = item;
		const selector = candidates.length < PAGE_VALUE_MAX_CANDIDATES ? proposeSelector(document, hit.el, value) : null;
		const extract: PageValueExtract | null = selector ? { kind: "css", selector, ...(hit.attribute ? { attribute: hit.attribute } : {}) } : null;
		const verified = extract && pageValuesMatch(readExtract(document, extract), value) ? extract : null;
		const key = verified ? `${verified.selector}|${verified.attribute ?? ""}` : "";
		if (key && seen.has(key)) continue;
		total += 1;
		if (candidates.length >= PAGE_VALUE_MAX_CANDIDATES) continue;
		if (key) seen.add(key);
		const isMeta = tagOf(hit.el) === "meta";
		candidates.push({
			type: hit.structured ? "structured" : "css",
			extract: verified,
			reading: sanitizeAlertExternalText(reading, 80),
			context: isMeta ? sanitizeAlertExternalText(`structured data ${hit.el.getAttribute("property") ?? hit.el.getAttribute("itemprop") ?? "price"}`, CONTEXT_CHARS) : contextAround(hit.el, reading),
			nearMatch: item.near,
			...(!verified
				? { note: "no stable selector for this element (only generated classes or positions); prefer another occurrence" }
				: hit.structured && !item.near
					? { note: wantedNear ? "the text around it does not mention what you asked for (it may be the default option): check the context" : "page-level price (usually the default option): check it is the item the user asked for" }
					: {}),
		});
	}

	if (numeric) {
		for (const price of collectJsonLdPrices(document, value)) {
			total += 1;
			if (candidates.length >= PAGE_VALUE_MAX_CANDIDATES) continue;
			candidates.push({
				type: "structured",
				extract: null,
				reading: sanitizeAlertExternalText(price.price, 80),
				context: sanitizeAlertExternalText(`JSON-LD ${price.key} of ${price.label || "an item"}`, CONTEXT_CHARS),
				nearMatch: wantedNear ? normalizePageText(price.nearText).includes(wantedNear) : false,
				note: "found in the structured data (JSON-LD), which a rule cannot read; use a visible element or meta tag that shows the same value",
			});
		}
	}

	// Quem tem seletor vem antes de quem não tem; dentro de cada grupo a ordem de relevância se mantém.
	candidates.sort((a, b) => Number(b.extract !== null) - Number(a.extract !== null));
	return { candidates, total, skipped };
}

export type FindPageValueResult =
	| ({ ok: true; host: string; ms: number } & LocatePageValueResult)
	| { ok: false; code: AlertSourceFailure | "not_found"; reason: string; host: string; ms: number };

/**
 * Busca a página com o leitor seguro dos alertas (SSRF, 5 MB, timeout, robots.txt) e localiza o valor.
 * Nunca lança: falha vira `{ ok: false, code, reason }`.
 */
export async function findPageValue(url: string, input: { value: string; near?: string }, deps: AlertSourceDeps = {}): Promise<FindPageValueResult> {
	const started = (deps.now ?? Date.now)();
	let host = "?";
	try {
		host = new URL(url).hostname;
	} catch {
		// URL inválida: o leitor devolve "blocked".
	}
	const fetched = await fetchAlertPage(url, deps);
	const ms = () => (deps.now ?? Date.now)() - started;
	if (!fetched.ok) return { ok: false, code: fetched.code, reason: fetched.reason, host, ms: ms() };
	if (/json/.test(fetched.contentType) && !/html/.test(fetched.contentType)) {
		return { ok: false, code: "parse", reason: "o endereço devolve JSON, não uma página: leia com extract jsonpath (ex.: $.data.price)", host, ms: ms() };
	}
	let located: LocatePageValueResult;
	try {
		located = locatePageValue(fetched.body, input.value, input.near);
	} catch {
		return { ok: false, code: "parse", reason: "não consegui interpretar a página", host, ms: ms() };
	}
	if (located.candidates.length === 0) {
		const reason = located.skipped > 0 ? "o valor aparece na página, mas nunca como primeiro número do elemento (a regra leria outro número)" : "valor não encontrado na página";
		return { ok: false, code: "not_found", reason, host, ms: ms() };
	}
	return { ok: true, host, ms: ms(), ...located };
}
