// `browser_read` (F8.1): UMA PARTE de uma seção (ou de um export), numerada, dizendo onde está e quanto falta.
// Item longo demais para `itemChars` mostra quantos caracteres ficaram de fora e como ler tudo. Nada some em silêncio.
import { z } from "zod";
import { defineTool } from "../../tools/define-tool.js";
import { BROWSER_KINDS, ITEM_DEFAULT_CHARS, ITEM_MAX_CHARS, READ_DEFAULT_COUNT, READ_MAX_COUNT, readDataSchema, sectionId } from "./protocol.js";
import { renderRead } from "./render.js";
import { callBrowser } from "./run-browser.js";

export function createBrowserReadTool() {
	return defineTool({
		name: "browser_read",
		description:
			"Read one part of a page section from browser_map: items from..from+count-1, numbered, with refs to act on them. Each part says which items it shows, how many are loaded and how many remain; continue with the from it gives. " +
			"Use it for the item range you need (\"the next 50\", \"items 200 to 250\"). Do not use it to hunt for a word in a long list (browser_find) or to read everything of a huge list (browser_digest).",
		inputSchema: z.object({
			section: sectionId.describe("Section id from browser_map."),
			from: z.number().int().min(1).optional().describe("First item number (default 1)."),
			count: z.number().int().min(1).max(READ_MAX_COUNT).optional().describe(`How many items (default ${READ_DEFAULT_COUNT}, at most ${READ_MAX_COUNT}). A part also ends early when it fills the reading window; it then says where to continue.`),
			itemChars: z.number().int().min(100).max(ITEM_MAX_CHARS).optional().describe(`Characters shown per item (default ${ITEM_DEFAULT_CHARS}). A longer item says how much was left out.`),
		}),
		effect: "read",
		trust: "untrusted",
		source: "web",
		async execute({ section, from, count, itemChars }, ctx) {
			const data = await callBrowser(ctx, BROWSER_KINDS.read, { section, from: from ?? 1, count: count ?? READ_DEFAULT_COUNT, itemChars: itemChars ?? ITEM_DEFAULT_CHARS }, readDataSchema);
			return { ok: true, summary: renderRead(data) };
		},
	});
}
