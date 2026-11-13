// `browser_open`: navega a aba atual para uma página pública. Só abre; ler é com `browser_map` e `browser_read`.
import { z } from "zod";
import { checkPublicHttpUrl } from "../../presets/web-url.js";
import { defineTool } from "../../tools/define-tool.js";
import { BROWSER_KINDS, openDataSchema } from "./protocol.js";
import { callBrowser } from "./run-browser.js";

export function createBrowserOpenTool() {
	return defineTool({
		name: "browser_open",
		description:
			"Open a web page in the browser (the owner's VM) and wait for it to settle. Use it for pages that need a real browser: scripts, logins the owner already did, feeds, forms. Do not use it for a plain fact (web_search) or to read an article (web_extract is cheaper). " +
			"After opening, call browser_map to see the page structure before reading.",
		inputSchema: z.object({
			url: z
				.string()
				.max(2000)
				.superRefine((value, ctx) => {
					const check = checkPublicHttpUrl(value);
					if (!check.ok) ctx.addIssue({ code: "custom", message: `${check.reason}; give a public http(s) page URL` });
				})
				.describe("Public http(s) URL."),
		}),
		effect: "read",
		// A URL é escolhida pelo modelo e sai para um terceiro (com a trifeta no run pede aprovação).
		egress: true,
		trust: "untrusted",
		source: "web",
		async execute({ url }, ctx) {
			const page = await callBrowser(ctx, BROWSER_KINDS.open, { url }, openDataSchema);
			const wall = page.wall ? ` This is a ${page.wall === "captcha" ? "captcha" : "block"} wall, not the real content: do not retry the same URL; use another source or ask the owner to solve it in the browser view.` : "";
			return { ok: true, summary: `Opened ${page.url} (title: ${page.title || "none"}).${wall} Next: browser_map.` };
		},
	});
}
