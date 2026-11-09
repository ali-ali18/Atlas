// `browser_tabs` (F8.1): listar, trocar, abrir e fechar abas.
import { z } from "zod";
import { defineTool } from "../../tools/define-tool.js";
import { BROWSER_KINDS, tabsDataSchema } from "./protocol.js";
import { callBrowser } from "./run-browser.js";

export function createBrowserTabsTool() {
	return defineTool({
		name: "browser_tabs",
		description: "List, switch to or close browser tabs. Use it when an action opened a new tab or you need to compare two pages. Do not use it to open a page (browser_open does that in the current tab).",
		inputSchema: z.object({
			action: z.enum(["list", "switch", "close"]),
			tabId: z.string().regex(/^\d{1,2}$/, "the tab number from the list, like 2").optional().describe("Tab number from the list, for switch and close."),
		}),
		effect: "read",
		trust: "untrusted",
		source: "web",
		async execute({ action, tabId }, ctx) {
			if ((action === "switch" || action === "close") && !tabId) throw new Error(`${action} needs tabId. Hint: list the tabs first.`);
			const r = await callBrowser(ctx, BROWSER_KINDS.tabs, { action, ...(tabId && { tabId }) }, tabsDataSchema);
			const lines = r.tabs.map((t) => `${t.active ? "* " : "- "}${t.id}: ${t.title || "(no title)"} (${t.url})`);
			return { ok: true, summary: `${r.tabs.length} tab(s) (* = active):\n${lines.join("\n")}` };
		},
	});
}
