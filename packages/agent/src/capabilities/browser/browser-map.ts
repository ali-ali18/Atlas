// `browser_map` (F8.1): a estrutura da página e o TAMANHO de cada lista, nunca a lista inteira. É a primeira leitura depois de abrir.
import { z } from "zod";
import { defineTool } from "../../tools/define-tool.js";
import { BROWSER_KINDS, mapDataSchema } from "./protocol.js";
import { renderMap } from "./render.js";
import { callBrowser } from "./run-browser.js";

export function createBrowserMapTool() {
	return defineTool({
		name: "browser_map",
		description:
			"Map the current page: its sections (lists, tables, text, forms) with how many items each has loaded and how many the page says it has (like \"comments: ~1,000, 40 loaded\"). It never prints a whole list. " +
			"Use it right after browser_open and again after the page changes a lot. Then read what you need with browser_read or browser_find. Do not use it to read content.",
		inputSchema: z.object({}),
		effect: "read",
		trust: "untrusted",
		source: "web",
		async execute(_args, ctx) {
			const map = await callBrowser(ctx, BROWSER_KINDS.map, {}, mapDataSchema);
			return { ok: true, summary: renderMap(map) };
		},
	});
}
