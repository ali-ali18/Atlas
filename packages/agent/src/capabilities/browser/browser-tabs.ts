// `browser_tabs` (F8.1): listar, trocar, abrir e fechar abas.
import { z } from "zod";
import { checkPublicHttpUrl } from "../../presets/web-url.js";
import { defineTool } from "../../tools/define-tool.js";
import { BROWSER_KINDS, tabsDataSchema } from "./protocol.js";
import { callBrowser } from "./run-browser.js";

export function createBrowserTabsTool() {
	return defineTool({
		name: "browser_tabs",
		description: "List, switch, open or close browser tabs. Use it when an action opened a new tab or you need to compare two pages. Do not use it to navigate the current tab (browser_open).",
		inputSchema: z.object({
			action: z.enum(["list", "switch", "open", "close"]),
			tabId: z.string().trim().min(1).max(40).optional().describe("Tab id from the list, for switch and close."),
			url: z.string().max(2000).optional().describe("Public http(s) URL, for open."),
		}),
		effect: "read",
		egress: true,
		trust: "untrusted",
		source: "web",
		async execute({ action, tabId, url }, ctx) {
			if ((action === "switch" || action === "close") && !tabId) throw new Error(`${action} needs tabId. Hint: list the tabs first.`);
			if (action === "open" && url) {
				const check = checkPublicHttpUrl(url);
				if (!check.ok) throw new Error(`${check.reason}. Hint: give a public http(s) URL.`);
			}
			const r = await callBrowser(ctx, BROWSER_KINDS.tabs, { action, ...(tabId && { tabId }), ...(url && { url }) }, tabsDataSchema);
			const lines = r.tabs.map((t) => `${t.active ? "* " : "- "}${t.id}: ${t.title || "(no title)"} (${t.url})`);
			return { ok: true, summary: `${r.tabs.length} tab(s) (* = active):\n${lines.join("\n")}` };
		},
	});
}
