/**
 * Valor visto numa página (modo guiado do alerta): comparação e heurísticas puras, sem DOM e sem rede.
 * O localizador que roda no HTML mora em `packages/search/src/page-value.ts`; aqui ficam as peças que a tool e
 * a criação da regra (`expect`) também usam, para o "16,47" da IA e o "R$ 16,47" da página serem o mesmo valor.
 */
import { parseLocalizedNumber } from "./alert-rule-extract.js";

export const PAGE_VALUE_MAX = 80;

const NUMERIC_VALUE = /^\s*(?:(?:R\$|US\$|U\$S|\$|€|£)\s*)?-?\s*\d[\d.,\s  ]*\s*(?:%|reais)?\s*$/i;

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

/** Sites que mostram cotação de ação/FII/ETF/BDR: para ticker da B3 a fonte é sempre `quote` (brapi), nunca a página. */
export const B3_QUOTE_SITES: ReadonlyArray<{ host: string; path?: RegExp }> = [
	{ host: "investidor10.com.br" },
	{ host: "statusinvest.com.br" },
	{ host: "br.investing.com" },
	{ host: "br.advfn.com" },
	{ host: "maisretorno.com" },
	{ host: "infomoney.com.br", path: /^\/cotacoes(?:\/|$)/i },
	{ host: "google.com", path: /^\/finance(?:\/|$)/i },
	{ host: "google.com.br", path: /^\/finance(?:\/|$)/i },
];

/** Ticker de ação/FII/ETF/BDR da B3 em texto livre ou URL: BBAS3, PETR4, HGLG11, AAPL34 (4 letras + 3..8, 11..13, 31..39). */
const B3_TICKER = /(?<![A-Za-z0-9])[A-Za-z]{4}(?:3|4|5|6|7|8|11|12|13|3[1-9])(?![A-Za-z0-9])/;

export function mentionsB3Ticker(text: string): boolean {
	return B3_TICKER.test(text);
}

function isQuoteSiteUrl(rawUrl: string): boolean {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		return false;
	}
	const host = url.hostname.toLowerCase().replace(/^www\./, "");
	return B3_QUOTE_SITES.some((site) => (host === site.host || host.endsWith(`.${site.host}`)) && (!site.path || site.path.test(url.pathname)));
}

export const B3_QUOTE_PAGE_HINT =
	"Use source quote (brapi) for B3 tickers, never a quote site page. If the brapi key is missing or refused, call propose_connector with app \"brapi\" (the connect card appears) and do not insist on pages; meanwhile offer a plain condition checked by the model.";

/**
 * Página de site de cotação para ativo da B3 (a URL ou o pedido citam o ticker): o motivo da recusa, ou null.
 * `texts` = título, condição, rótulo, detalhe e dica do que o usuário pediu.
 */
export function b3QuotePageReason(url: string, texts: readonly (string | undefined)[]): string | null {
	if (!isQuoteSiteUrl(url)) return null;
	let path = "";
	try {
		path = decodeURIComponent(new URL(url).pathname + new URL(url).search);
	} catch {
		path = url;
	}
	if (!mentionsB3Ticker(path) && !texts.some((text) => text && mentionsB3Ticker(text))) return null;
	return `This is a B3 stock/FII/ETF/BDR quote site page. ${B3_QUOTE_PAGE_HINT}`;
}
