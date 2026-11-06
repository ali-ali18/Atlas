import { PAGE_MAX_JSON_CHARS, parsePageSpec } from "@workspace/shared";
import { z } from "zod";
import type { PageStore } from "../../ports/deliverables.js";
import { defineTool } from "../../tools/define-tool.js";

export function createCreatePageTool(pages: PageStore) {
	return defineTool({
		name: "create_page",
		description:
			"Create a panel (a living dashboard page) for the owner and return its receipt. Use for dashboards, trackers and overviews that mix stats, charts, tables and callouts. Spec is { v: 2, title, summary?, palette?, root } where root is a node tree (section, grid, stack, card, tabs, stat, chart, bar_list, table, progress, badge, callout, timeline, kanban, list, text, heading). Do not use for a document to download (create_file) or one chart in the chat (chart). Unknown fields are rejected with the accepted list.",
		inputSchema: z.object({ spec: z.record(z.string(), z.unknown()).describe("The v2 panel spec.") }),
		effect: "write_internal",
		riskFacts: ({ spec }) => ({ target: typeof spec.title === "string" ? spec.title : "panel" }),
		async execute({ spec }, ctx) {
			if (JSON.stringify(spec).length > PAGE_MAX_JSON_CHARS) throw new Error(`Panel spec is too large (max ${PAGE_MAX_JSON_CHARS} characters). Split it into several panels.`);
			const parsed = parsePageSpec(spec);
			if (!parsed.ok) throw new Error(`Invalid panel spec: ${parsed.error}`);
			const stored = await pages.save(ctx.ownerId, ctx.runId, parsed.spec);
			return {
				ok: true,
				summary: `Created panel "${stored.title}".`,
				receipt: { what: `Created panel ${stored.title}`, where: stored.title, externalId: stored.id, ...(stored.url && { url: stored.url }) },
			};
		},
	});
}
