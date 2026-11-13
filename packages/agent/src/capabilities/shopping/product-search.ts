// `product_search` (F6.1): acha produtos na web e LÊ a página de cada um de forma estruturada (JSON-LD, OpenGraph), sem
// pedir ao modelo para "ler o preço no texto". O total é preço + frete, em campo explícito; frete desconhecido é dito,
// nunca somado como zero. Emite o cartão `product` (foto, preço, loja, frete, total, link; vários = comparar).
// O resultado vem da web: dado, nunca instrução (trust untrusted). Página inteira, sem corte por economia.
import { PRODUCT_CARD_MAX_ITEMS, compareOffers, describeOffer, parseProductPage, productCardId, type ProductOffer } from "@workspace/shared";
import { z } from "zod";
import type { ProductCards, ProductPages } from "../../ports/shopping.js";
import type { SearchPort } from "../../ports/search.js";
import { checkPublicHttpUrl } from "../../presets/web-url.js";
import { defineTool } from "../../tools/define-tool.js";

const MAX_PAGES = 6;

const productUrl = z
	.string()
	.max(2000)
	.superRefine((value, ctx) => {
		const check = checkPublicHttpUrl(value);
		if (!check.ok) ctx.addIssue({ code: "custom", message: `${check.reason}; give a public http(s) product page URL` });
	});

export function createProductSearchTool(deps: { search: SearchPort; pages: ProductPages; cards: ProductCards; /** País do dono (ISO alfa-2) para escolher o frete certo; sem ele, frete por destino fica desconhecido. */ country?: string }) {
	return defineTool({
		name: "product_search",
		description:
			"Find a product in online stores and read each store page for its structured data: name, price, currency, store, shipping, availability, photos, rating and link. Shows a product card in the chat (several products = a comparison). " +
			"Give query to search the web, or urls to read specific product pages (or both). Use it when the owner wants to see, price or compare a product. Do not use it to buy (checkout) or for general facts (web_search). " +
			"Compare stores by the TOTAL (price + shipping). If shipping is not informed the total is unknown: say so and offer to look at the store, never assume zero.",
		inputSchema: z.object({
			query: z.string().trim().min(1).max(200).optional().describe("What to look for, in the owner's words plus the store country/language if relevant."),
			urls: z.array(productUrl).min(1).max(MAX_PAGES).optional().describe("Product page URLs to read directly."),
			maxStores: z.number().int().min(1).max(MAX_PAGES).optional().describe(`With query: how many result pages to read (default 4, at most ${MAX_PAGES}).`),
		}),
		effect: "read",
		// A consulta e as URLs são escolhidas pelo modelo e saem para um terceiro: com taint no run pedem aprovação (S2).
		egress: true,
		trust: "untrusted",
		source: "web",
		async execute({ query, urls, maxStores }, ctx) {
			if (query === undefined && urls === undefined) throw new Error("Give query or urls. Hint: use query to search stores, or urls for specific product pages.");
			const targets = [...(urls ?? [])];
			if (query !== undefined) {
				const hits = await deps.search.search(ctx.ownerId, query, { limit: Math.min(MAX_PAGES + 4, (maxStores ?? 4) + 4) }, ctx.signal);
				for (const hit of hits) if (!targets.includes(hit.url) && checkPublicHttpUrl(hit.url).ok) targets.push(hit.url);
			}
			const wanted = targets.slice(0, Math.min(MAX_PAGES, (urls?.length ?? 0) + (query !== undefined ? (maxStores ?? 4) : 0)));
			// Lê em paralelo; cada página falha sozinha (loja fora do ar não derruba a comparação).
			const read = await Promise.all(
				wanted.map(async (url) => {
					try {
						const page = await deps.pages.fetchHtml(ctx.ownerId, url, ctx.signal);
						const offer = parseProductPage(page.html, page.url, deps.country ? { country: deps.country } : {});
						return offer ? { ok: true as const, offer } : { ok: false as const, url, reason: "no structured product data on the page" };
					} catch (error) {
						if (ctx.signal?.aborted) throw error;
						return { ok: false as const, url, reason: error instanceof Error ? error.message : "could not be read" };
					}
				}),
			);
			const seen = new Set<string>();
			const offers: ProductOffer[] = [];
			for (const r of read) if (r.ok && !seen.has(r.offer.url)) (seen.add(r.offer.url), offers.push(r.offer));
			const skipped = read.filter((r) => !r.ok);
			const skippedNote = skipped.length > 0 ? `\n\nNot read (${skipped.length}): ${skipped.map((s) => `${s.url} (${s.reason})`).join("; ")}` : "";
			if (offers.length === 0) {
				throw new Error(`No product with structured data was found.${skippedNote} Hint: try other words, name the store, or give product page URLs; the owner can also be offered a look in the store.`);
			}
			const shown = offers.slice(0, PRODUCT_CARD_MAX_ITEMS);
			const comparison = compareOffers(shown);
			await deps.cards.show(ctx.ownerId, ctx.runId, {
				cardId: productCardId(ctx.runId, shown.map((o) => o.url)),
				items: shown,
				...(shown.length > 1 && comparison.cheapestUrl && { cheapestUrl: comparison.cheapestUrl }),
				...(shown.length > 1 && comparison.incomplete && { incomplete: true }),
			});
			const lines = shown.map((o, i) => `${i + 1}. ${describeOffer(o)}`).join("\n\n");
			let verdict = "";
			if (shown.length > 1) {
				if (comparison.mixedCurrency) verdict = "\n\nThe stores use different currencies, so totals are not comparable; do not rank them.";
				else if (comparison.cheapestUrl) verdict = `\n\nLowest TOTAL among stores with a known total: ${comparison.cheapestUrl}${comparison.incomplete ? ". Some stores did not inform shipping, so one of them may be cheaper; say that." : "."}`;
				else if (comparison.incomplete) verdict = "\n\nNo store has a known total (shipping or price missing); do not name the cheapest.";
			}
			return { ok: true, summary: `A product card was shown to the owner (do not repeat every field). Read ${shown.length} product page${shown.length === 1 ? "" : "s"}:\n\n${lines}${verdict}${skippedNote}` };
		},
	});
}
