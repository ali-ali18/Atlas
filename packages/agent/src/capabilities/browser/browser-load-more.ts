// `browser_load_more` (F8.1): carregar mais é uma AÇÃO EXPLÍCITA que o modelo decide repetir. O resultado diz quantos já estão carregados.
import { z } from "zod";
import { defineTool } from "../../tools/define-tool.js";
import { BROWSER_KINDS, LOAD_MORE_MAX_TIMES, loadMoreDataSchema, sectionId } from "./protocol.js";
import { sizeOf } from "./render.js";
import { callBrowser } from "./run-browser.js";

export function createBrowserLoadMoreTool() {
	return defineTool({
		name: "browser_load_more",
		description:
			"Load more items of a section (clicks its \"show more\" control or scrolls an endless feed). It says how many items are loaded before and after, and whether the page has no more. " +
			"Use it when the list you need is longer than what is loaded; repeat it until you have enough or it reports the end. For \"all of it\", prefer browser_digest, which loads and reads in the background.",
		inputSchema: z.object({
			section: sectionId.describe("Section id from browser_map."),
			times: z.number().int().min(1).max(LOAD_MORE_MAX_TIMES).optional().describe(`How many times in a row (default 1, at most ${LOAD_MORE_MAX_TIMES}).`),
		}),
		effect: "read",
		trust: "untrusted",
		source: "web",
		async execute({ section, times }, ctx) {
			const r = await callBrowser(ctx, BROWSER_KINDS.loadMore, { section, times: times ?? 1 }, loadMoreDataSchema);
			const gained = r.after - r.before;
			const state = sizeOf({ items: r.after, declaredTotal: r.declaredTotal, canLoadMore: !r.reachedEnd });
			const end = r.reachedEnd ? " Nothing new appeared: the page has no more (or did not answer)." : "";
			return { ok: true, summary: `Section ${r.section}: ${r.before} -> ${r.after} items loaded (+${gained}, via ${r.method}). Now ${state}.${end}` };
		},
	});
}
