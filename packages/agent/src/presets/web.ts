// Capacidade núcleo `web` (F1.14, real na F2.1): pesquisar e ler uma página. Só fala com a porta `Search`; o adaptador
// real (SearXNG/DuckDuckGo, extração, SSRF, limites técnicos) é `adapters/web.ts`. O que volta da web é dado, nunca instrução.
import { z } from "zod";
import { defineCapability } from "../capabilities/define-capability.js";
import type { Search } from "../ports/search.js";
import { defineTool } from "../tools/define-tool.js";
import { checkPublicHttpUrl } from "./web-url.js";

const MAX_RESULTS = 10;

export function createWebCapability(search: Search) {
	const webSearch = defineTool({
		name: "web_search",
		description: "Search the web for fresh or unknown facts. Returns titles, URLs and snippets; cite the URLs you rely on. Do not use for content the owner already shared.",
		inputSchema: z.object({ query: z.string().min(1).max(300), limit: z.number().int().min(1).max(MAX_RESULTS).optional() }),
		effect: "read",
		// A consulta e a URL são escolhidas pelo modelo e saem para um terceiro: com taint no run pedem aprovação (S2).
		egress: true,
		trust: "untrusted",
		source: "web",
		async execute({ query, limit }, ctx) {
			const hits = await search.search(ctx.ownerId, query, { limit: limit ?? 5 }, ctx.signal);
			if (hits.length === 0) return { ok: true, summary: `No results for "${query}". Try other words.` };
			return { ok: true, summary: hits.map((hit, index) => `${index + 1}. ${hit.title}\n${hit.url}\n${hit.snippet}`).join("\n\n") };
		},
	});
	const webExtract = defineTool({
		name: "web_extract",
		description: "Read the text of one web page by URL (http or https). Use after web_search when a snippet is not enough. Do not use for files in the workspace.",
		inputSchema: z.object({
			url: z
				.string()
				.max(2000)
				.superRefine((value, ctx) => {
					const check = checkPublicHttpUrl(value);
					if (!check.ok) ctx.addIssue({ code: "custom", message: `${check.reason}; give a public http(s) page URL` });
				}),
		}),
		effect: "read",
		egress: true,
		trust: "untrusted",
		source: "web",
		async execute({ url }, ctx) {
			const page = await search.extract(ctx.ownerId, url, ctx.signal);
			// Página inteira, sem corte (decisão do dono: nada de cortar por economia). Se passar do tamanho de uma
			// página do kernel, o kernel guarda tudo no caderno e entrega em partes com o ponteiro `note_read`.
			return { ok: true, summary: `${page.title ? `${page.title}\n` : ""}${page.url}\n\n${page.text}` };
		},
	});
	return defineCapability({ id: "web", title: "Web", summary: "Search the web and read pages.", core: true, tools: [webSearch, webExtract] });
}
