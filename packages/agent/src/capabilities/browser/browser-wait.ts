// `browser_wait` (F8.1): espera uma condição da página (texto, rede quieta, URL) com teto. Dizer que não veio é resposta honesta.
import { z } from "zod";
import { defineTool } from "../../tools/define-tool.js";
import { BROWSER_KINDS, waitDataSchema } from "./protocol.js";
import { callBrowser } from "./run-browser.js";

export function createBrowserWaitTool() {
	return defineTool({
		name: "browser_wait",
		description: "Wait for something on the page: some text to appear, the page to go quiet (stable, network) or the URL to contain a value. Use it after an action that loads slowly. Do not use it as a delay.",
		inputSchema: z.object({
			for: z.enum(["text", "url", "network", "stable"]).describe("What to wait for."),
			value: z.string().trim().min(1).max(200).optional().describe("The text or URL part, for text and url."),
			timeoutMs: z.number().int().min(500).max(20_000).optional().describe("How long to wait at most (default 8000)."),
		}),
		effect: "read",
		trust: "untrusted",
		source: "web",
		async execute({ for: kind, value, timeoutMs }, ctx) {
			if ((kind === "text" || kind === "url") && !value) throw new Error(`Waiting for ${kind} needs value. Hint: the text or URL part to wait for.`);
			const r = await callBrowser(ctx, BROWSER_KINDS.wait, { for: kind, ...(value && { value }), timeoutMs: timeoutMs ?? 8000 }, waitDataSchema);
			return { ok: true, summary: r.met ? `Done after ${r.waitedMs} ms. Page: ${r.url}.` : `The wait ended after ${r.waitedMs} ms WITHOUT the condition (${kind}${value ? `: ${value}` : ""}). Page: ${r.url}. Map the page again to see what is there.` };
		},
	});
}
