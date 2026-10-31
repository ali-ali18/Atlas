/**
 * Valor visto numa página (modo guiado do alerta): comparação e heurísticas puras, sem DOM e sem rede.
 * O localizador que roda no HTML mora em `packages/search/src/page-value.ts`; aqui ficam as peças que a tool e
 * a criação da regra (`expect`) também usam, para o "16,47" da IA e o "R$ 16,47" da página serem o mesmo valor.
 */
import { parseLocalizedNumber } from "./alert-rule-extract.js";

export const PAGE_VALUE_MAX = 80;
export const ALERT_ANCHOR_MAX = 40;

const NUMERIC_VALUE = /^\s*(?:(?:R\$|US\$|U\$S|\$|€|£)\s*)?[-\u2212\u2013\u2012]?\s*\d[\d.,\s  ]*\s*(?:%|reais)?\s*$/i;

/** O texto é um número (com ou sem moeda/%): "16,47", "R$ 3.299,00", "1,234.56". */
export function isNumericPageValue(text: string): boolean {
	return NUMERIC_VALUE.test(text);
}

/** Minúsculas, sem acento, espaços colapsados: base da comparação de texto. */
export function normalizePageText(text: string): string {
	return text
		.normalize("NFD")
		.replace(/\p{M}/gu, "")
		.toLowerCase()
		.replace(/[\s  ]+/g, " ")
		.trim();
}

function tokensOf(text: string): number[] {
	const out: number[] = [];
	for (const match of text.matchAll(/\d[\d.,]*/g)) {
		const value = parseLocalizedNumber(match[0].replace(/[.,]+$/, ""));
		if (value !== null) out.push(value);
	}
	return out;
}

/** Todos os números do texto, cada um já normalizado (BR/US). Milhar com espaço ("1 299,00") vale como um número só, além de cada parte. */
export function pageNumbers(text: string): number[] {
	const joined = text.replace(/(\d)[\s  ](?=\d{3}(?!\d))/g, "$1");
	return joined === text ? tokensOf(text) : [...tokensOf(text), ...tokensOf(joined)];
}

/** O texto contém o valor: número igual a qualquer número do texto (não "116,47" para "16,47"), ou trecho de texto igual. */
export function pageTextHasValue(text: string, value: string): boolean {
	if (isNumericPageValue(value)) {
		const wanted = parseLocalizedNumber(value);
		return wanted !== null && pageNumbers(text).includes(wanted);
	}
	const wanted = normalizePageText(value);
	return wanted.length > 0 && normalizePageText(text).includes(wanted);
}

/**
 * A leitura da regra bate com o que a IA viu. Número: o PRIMEIRO número da leitura (como o avaliador lê) é igual ao
 * esperado, tolerância zero. Texto: a leitura contém o esperado, sem diferenciar maiúsculas nem acento.
 */
export function pageValuesMatch(read: string, expected: string): boolean {
	if (isNumericPageValue(expected)) {
		const wanted = parseLocalizedNumber(expected);
		const got = parseLocalizedNumber(read);
		return wanted !== null && got !== null && wanted === got;
	}
	const wanted = normalizePageText(expected);
	return wanted.length > 0 && normalizePageText(read).includes(wanted);
}

/**
 * Rótulo que acompanha o valor na página, para saber depois se o seletor ainda aponta para o mesmo lugar: as
 * primeiras palavras de texto do contexto ("Cotação R$ 16,47 0,06%" -> "cotacao"; "Preço atual R$ 16,47" -> "preco atual"),
 * sem o valor, números, moeda e %. undefined = o contexto não tem rótulo (só números): a guarda de salto cobre.
 */
export function deriveAlertAnchor(context: string, reading: string): string | undefined {
	const withoutValue = normalizePageText(context).replace(normalizePageText(reading), " ");
	const words = (withoutValue.match(/[a-z]{3,}/g) ?? []).filter((word) => !["real", "reais", "usd", "brl"].includes(word));
	let anchor = "";
	for (const word of words.slice(0, 2)) {
		if (`${anchor} ${word}`.trim().length > ALERT_ANCHOR_MAX) break;
		anchor = `${anchor} ${word}`.trim();
	}
	return anchor || undefined;
}

/** O rótulo guardado na criação continua no contexto do valor lido agora. */
export function anchorStillNear(context: string, anchor: string): boolean {
	return normalizePageText(context).includes(normalizePageText(anchor));
}

const GENERATED_CLASS_PREFIX = /^(?:css|sc|jsx|svelte|emotion|styled|ng-tns|ng-star|ember)-/i;
const UTILITY_CLASS =
	/^(?:-?(?:m|p|mx|my|mt|mb|ml|mr|px|py|pt|pb|pl|pr|w|h|min-w|max-w|min-h|max-h|text|bg|font|border|rounded|shadow|flex|grid|gap|space|items|justify|self|col|row|order|z|top|left|right|bottom|inline|block|hidden|absolute|relative|fixed|sticky|overflow|opacity|cursor|transition|duration|leading|tracking|truncate|uppercase|lowercase|capitalize|underline|float|clearfix|container|clear|d|align|visible|invisible|sr-only)(?:-[\w.-]+)?)$/;
const STATE_CLASS = /^(?:active|selected|current|open|opened|show|shown|hide|hidden|disabled|loading|loaded|visible|focus|hover|first|last|odd|even|(?:is|has)-[\w-]+)$/i;

/**
 * Classe boa para seletor de alerta: nome com significado (`price`, `_card-body`, `js-product-price`) que sobrevive a
 * um novo deploy da loja. Recusa classe gerada (hash do CSS-in-JS/CSS modules), utilitária (Tailwind), de estado e
 * qualquer uma com caractere que exigiria escape.
 */
export function isStableClass(name: string): boolean {
	if (!/^[A-Za-z_][\w-]{0,39}$/.test(name)) return false;
	if (GENERATED_CLASS_PREFIX.test(name) || UTILITY_CLASS.test(name) || STATE_CLASS.test(name)) return false;
	if (/\d{4,}/.test(name)) return false;
	// Cauda aleatória de CSS modules / styled-components: `Price_price__a1B2c`, `title__3xKdP`.
	const tail = name.split(/[-_]+/).pop() ?? "";
	if (tail.length >= 5 && /\d/.test(tail) && /[A-Za-z]/.test(tail)) return false;
	if (tail.length >= 5 && /[a-z]/.test(tail) && /[A-Z]/.test(tail) && /\d/.test(tail)) return false;
	return true;
}

/** `id` bom para seletor: palavra com significado, sem número comprido nem aparência de hash. */
export function isStableId(id: string): boolean {
	if (!/^[A-Za-z][\w-]{0,39}$/.test(id)) return false;
	if (/\d{3,}/.test(id) || GENERATED_CLASS_PREFIX.test(id)) return false;
	const tail = id.split(/[-_]+/).pop() ?? "";
	return !(tail.length >= 5 && /\d/.test(tail) && /[A-Za-z]/.test(tail));
}

// ------------------------------------------------------------- sites de cotação da B3

type QuoteSite = { host: string; path?: RegExp };

/** Sites que mostram cotação de ação/FII/ETF/BDR: para o PREÇO de ticker da B3 a fonte é sempre `quote` (brapi), nunca a página. */
export const B3_QUOTE_SITES: ReadonlyArray<QuoteSite> = [
	{ host: "investidor10.com.br" },
	{ host: "statusinvest.com.br" },
	{ host: "fundamentus.com.br" },
	{ host: "tradingview.com" },
	{ host: "investing.com" },
	{ host: "advfn.com" },
	{ host: "maisretorno.com" },
	{ host: "finance.yahoo.com" },
	{ host: "infomoney.com.br", path: /^\/cotacoes(?:\/|$)/i },
];

/** Google em qualquer domínio (google.com, google.com.br, google.de...) com o caminho /finance. */
const GOOGLE_HOST = /^(?:[a-z0-9-]+\.)*google\.(?:com?\.)?[a-z]{2,3}$/;

/**
 * Ticker de ação/FII/ETF/BDR da B3 em texto livre ou URL: 4 caracteres (3 letras no mínimo, ex.: BBAS, B3SA) + sufixo
 * 3..6, 11..13 ou 31..39 + "F" opcional (fracionário: BBAS3F). Não casa palavra comum ("Fire7").
 */
const B3_TICKER = /(?<![A-Za-z0-9])([A-Za-z0-9]{4})(?:3|4|5|6|11|12|13|3[1-9])F?(?![A-Za-z0-9])/gi;

export function mentionsB3Ticker(text: string): boolean {
	for (const match of text.matchAll(B3_TICKER)) {
		if ((match[1]!.match(/[A-Za-z]/g) ?? []).length >= 3) return true;
	}
	return false;
}

function isQuoteSiteUrl(rawUrl: string): boolean {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		return false;
	}
	const host = url.hostname.toLowerCase().replace(/^www\./, "");
	if (GOOGLE_HOST.test(host)) return /^\/finance(?:\/|$)/i.test(url.pathname);
	return B3_QUOTE_SITES.some((site) => (host === site.host || host.endsWith(`.${site.host}`)) && (!site.path || site.path.test(url.pathname)));
}

/** Pedido sobre o preço da ação (a fonte `quote` cobre só isso). */
const PRICE_WORDS = /pre[cç]o|cota[cç][aã]o|cotad|price|quote|fechamento|\b(?:cair|cai|caia|subir|sobe|suba|baixar|baixa|drop|fall|rise|reach|atingir|chegar)\b/i;
/** Indicador que a fonte `quote` NÃO cobre: DY, P/VP, dividendos, data com... */
const OTHER_METRIC = /\b(?:dy|dividend\w*|yield|p\/?vp|p\/?l|ev\/?ebitda|roe|roic|payout|provento\w*|jcp|data[ -]com|lucro|receita|margem|liquidez|vpa|lpa)\b/i;

export const B3_QUOTE_PAGE_HINT =
	"Use source quote (brapi) for B3 tickers, never a quote site page. If the brapi key is missing or refused, call propose_connector with app \"brapi\" (the connect card appears) and do not insist on pages; meanwhile offer a plain condition checked by the model.";

/**
 * Página de site de cotação para o PREÇO de ativo da B3 (a URL ou o pedido citam o ticker): o motivo da recusa, ou null.
 * Pedido de outro indicador (DY, P/VP, dividendos, data com) passa: a fonte `quote` não o cobre.
 * `texts` = título, condição, rótulo, detalhe e dica do que o usuário pediu.
 */
export function b3QuotePageReason(url: string, texts: readonly (string | undefined)[]): string | null {
	if (!isQuoteSiteUrl(url)) return null;
	let path = "";
	try {
		const parsed = new URL(url);
		path = decodeURIComponent(parsed.pathname + parsed.search);
	} catch {
		path = url;
	}
	const joined = texts.filter(Boolean).join(" \n ");
	if (!mentionsB3Ticker(path) && !mentionsB3Ticker(joined)) return null;
	if (OTHER_METRIC.test(`${joined} ${path}`) && !PRICE_WORDS.test(joined)) return null;
	return `This is a B3 stock/FII/ETF/BDR quote site page. ${B3_QUOTE_PAGE_HINT}`;
}
