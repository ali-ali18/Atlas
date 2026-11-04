import { z } from "zod";
import { redactSecrets } from "../../mcp/sanitize.js";
import { navigateTimingTelemetry } from "../../telemetry/step-telemetry.js";
import { formatReady, formatSettle } from "../computer.js";
import { defineTool } from "../define-tool.js";
import { derivePageState, formatPageState } from "./page-state.js";
import { forgetRefs, noteSecretGuard } from "./ref-memory.js";
import { ensureTab } from "./shared.js";

export const BROWSER_NAVIGATE_TOOL_NAME = "browser_navigate";

/** Abre uma URL na aba ativa da VM. O resultado traz o estado da página (carregando, login, aviso de cookies, desafio, erro). */
export const browserNavigateTool = defineTool({
	name: BROWSER_NAVIGATE_TOOL_NAME,
	description:
		"Open a URL in the VM browser (active tab, or `tab`). USE the exact URL the user gave or one you found; never guess a domain. After it, call browser_snapshot to see the page. The result includes page_state when the page is not simply ready. Do NOT use it to click links (browser_act) or to read a page you can fetch without the browser (web_extract).",
	input: z.object({
		url: z.string().trim().min(1).max(2000).describe("Full http(s) URL"),
		tab: z.number().int().min(1).max(99).describe("Tab number from browser_tabs").optional(),
	}),
	effect: "read",
	group: "browser",
	run: async (args, ctx) => {
		await ensureTab(ctx, args.tab);
		const sessionId = await ctx.getSessionId();
		const result = await ctx.manager.execNavigate(sessionId, args.url);
		forgetRefs(sessionId);
		noteSecretGuard(sessionId, result.secretGuard);
		const state = formatPageState(derivePageState({ url: result.url, title: result.title, ...(result.pageState ? { fromServer: result.pageState } : {}) }));
		return {
			summary: redactSecrets(`Opened ${result.url} (title: ${JSON.stringify(result.title)})${result.ready === false ? formatReady(result) : formatSettle(result)}${state ? `\n${state}` : ""}`),
			toolTelemetry: { nav: navigateTimingTelemetry(result) },
		};
	},
});
