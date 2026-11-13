import { CHART_MAX_JSON_CHARS, CHART_TYPES, parseChartSpec, summarizeChartSpec } from "@workspace/shared";
import { z } from "zod";
import type { ChartStore } from "../../ports/deliverables.js";
import { defineTool } from "../../tools/define-tool.js";

export function createChartTool(charts: ChartStore) {
	return defineTool({
		name: "chart",
		description: `Draw one chart in the chat from data you already have and return its receipt. Spec is { type, title?, x, series: [{ key, label }], data: [rows], unit?, format?, palette? }; types: ${CHART_TYPES.join(", ")}. Use for a single quick visual of numbers. Do not use for a full dashboard (create_page) or a chart inside a document. Unknown fields are rejected with the accepted list.`,
		inputSchema: z.object({ spec: z.record(z.string(), z.unknown()).describe("The chart spec.") }),
		effect: "write_internal",
		riskFacts: ({ spec }) => ({ target: typeof spec.title === "string" ? spec.title : "chart" }),
		async execute({ spec }, ctx) {
			if (JSON.stringify(spec).length > CHART_MAX_JSON_CHARS) throw new Error(`Chart spec is too large (max ${CHART_MAX_JSON_CHARS} characters). Aggregate the data first.`);
			const parsed = parseChartSpec(spec);
			if (!parsed.ok) throw new Error(`Invalid chart spec: ${parsed.error}`);
			const stored = await charts.save(ctx.ownerId, ctx.runId, parsed.spec);
			return {
				ok: true,
				summary: `Drew ${summarizeChartSpec(parsed.spec)}.`,
				receipt: { what: `Drew chart${parsed.spec.title ? ` ${parsed.spec.title}` : ""}`, where: parsed.spec.title ?? parsed.spec.type, externalId: stored.id },
			};
		},
	});
}
