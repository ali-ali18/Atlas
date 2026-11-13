// Parser puro da página HTML do DuckDuckGo (fallback quando não há SearXNG). Sem rede, sem relógio.
import { decodeEntities, stripTags } from "./html-text.js";

export const WEB_SEARCH_DEFAULT_NUM = 8;

export type DuckDuckGoResult = { url: string; title: string; snippet: string; source: "duckduckgo" };

const RECENCY_TO_DF: Readonly<Record<string, string>> = { day: "d", week: "w", month: "m", year: "y" };

/** `pt-BR` vira `br-pt`, o formato de região (`kl`) do DuckDuckGo; sem país, `wt-wt`. */
export function localeToDuckRegion(locale: string | undefined): string {
	const [lang, country] = (locale ?? "pt-BR").toLowerCase().split(/[-_]/);
	return country ? `${country}-${lang}` : "wt-wt";
}

/** Query string da busca HTML do DuckDuckGo. */
export function duckDuckGoParams(query: string, options: { locale?: string; recency?: string } = {}): URLSearchParams {
	const params = new URLSearchParams({ q: query, kl: localeToDuckRegion(options.locale) });
	const df = options.recency ? RECENCY_TO_DF[options.recency.toLowerCase()] : undefined;
	if (df) params.set("df", df);
	return params;
}

function unwrapDuckUrl(href: string, depth = 0): string | null {
	const absolute = href.startsWith("//") ? `https:${href}` : href;
	try {
		const url = new URL(absolute, "https://duckduckgo.com");
		if (url.hostname.endsWith("duckduckgo.com")) {
			if (url.pathname.startsWith("/y.js")) return null; // anúncio
			const target = url.searchParams.get("uddg");
			// Anúncio real vem embrulhado 2x: uddg → duckduckgo.com/y.js?ad_domain=…
			return target && depth < 2 && /^https?:/.test(target) ? unwrapDuckUrl(target, depth + 1) : null;
		}
		return /^https?:/.test(url.toString()) ? url.toString() : null;
	} catch {
		return null;
	}
}

/** Resultados da página HTML do DuckDuckGo. */
export function parseDuckDuckGoHtml(html: string, num = WEB_SEARCH_DEFAULT_NUM): DuckDuckGoResult[] {
	const results: DuckDuckGoResult[] = [];
	const seen = new Set<string>();
	const blocks = html.split(/<div[^>]+class="[^"]*\bresult\b/i).slice(1);
	for (const block of blocks) {
		if (/result--ad\b/i.test(block.slice(0, 200))) continue;
		const link =
			block.match(/<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i) ??
			block.match(/<a[^>]+href="([^"]+)"[^>]+class="[^"]*result__a[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
		if (!link?.[1]) continue;
		const url = unwrapDuckUrl(decodeEntities(link[1]));
		if (!url || seen.has(url)) continue;
		const snippet = block.match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|td)>/i);
		seen.add(url);
		results.push({ url, title: stripTags(link[2] ?? "") || url, snippet: snippet?.[1] ? stripTags(snippet[1]) : "", source: "duckduckgo" });
		if (results.length >= num) break;
	}
	return results;
}
