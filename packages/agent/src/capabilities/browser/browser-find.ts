// `browser_find` (F8.1): a busca roda NA VM, sobre tudo o que a página tem carregado, e devolve só os trechos que batem, com ref.
import { z } from "zod";
import { defineTool } from "../../tools/define-tool.js";
import { BROWSER_KINDS, FIND_DEFAULT_LIMIT, FIND_MAX_LIMIT, findDataSchema, sectionId } from "./protocol.js";
import { renderFind } from "./render.js";
import { callBrowser } from "./run-browser.js";

export function createBrowserFindTool() {
	return defineTool({
		name: "browser_find",
		description:
			"Search inside the page (done in the browser VM, over everything loaded): returns only the matching snippets, with the section, the item number and a ref to act on it. All words must match; accents and case are ignored. " +
			"Use it to find a word or topic in a long list (\"comments about price\"). It only sees what is loaded: if the list has more, load more first. Do not use it to read a range (browser_read).",
		inputSchema: z.object({
			query: z.string().trim().min(1).max(200).describe("Words to look for."),
			section: sectionId.optional().describe("Limit the search to one section; default the whole page."),
			limit: z.number().int().min(1).max(FIND_MAX_LIMIT).optional().describe(`How many matches to show (default ${FIND_DEFAULT_LIMIT}). The result always says the total.`),
		}),
		effect: "read",
		trust: "untrusted",
		source: "web",
		async execute({ query, section, limit }, ctx) {
			const data = await callBrowser(ctx, BROWSER_KINDS.find, { query, ...(section && { section }), limit: limit ?? FIND_DEFAULT_LIMIT }, findDataSchema);
			return { ok: true, summary: renderFind(data, query) };
		},
	});
}
