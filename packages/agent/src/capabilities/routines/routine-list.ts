// `routine_list`: as rotinas e alertas do dono neste bot (a tabela `routines`, a mesma da Biblioteca). Leitura privada.
// Não confundir com `agenda_list` (lembretes e vigias do próprio motor).
import { z } from "zod";
import type { Routines } from "../../ports/routines.js";
import { defineTool } from "../../tools/define-tool.js";

const MAX_LISTED = 25;

export function createRoutineListTool(routines: Routines) {
	return defineTool({
		name: "routine_list",
		description:
			"List the owner's routines and alerts in this bot (what the Library shows): name, when it runs (a plain phrase), active or paused, group, what it does, last run, and next run when known. " +
			"Use it when the owner asks what routines or alerts exist or what one does, and before routine_control or routine_group to get the exact name or id. " +
			"Not for reminders or watches you scheduled yourself (agenda_list). The owner never sees ids: say names.",
		inputSchema: z.object({
			onlyActive: z.boolean().optional().describe("Leave out paused routines."),
			onlyAlerts: z.boolean().optional().describe("Only alerts (routines that notify when a condition becomes true)."),
		}),
		effect: "read",
		// A instrução da rotina pode ter dado do dono.
		privateData: true,
		async execute({ onlyActive, onlyAlerts }, ctx) {
			const all = await routines.list(ctx.ownerId);
			const rows = all.filter((r) => (!onlyActive || r.enabled) && (!onlyAlerts || r.alert !== undefined));
			if (rows.length === 0) return { ok: true, summary: onlyAlerts ? "No alerts in this bot." : onlyActive && all.length > 0 ? `No active routines (${all.length} paused).` : "No routines in this bot." };
			const shown = rows.slice(0, MAX_LISTED);
			const lines = shown.map((r, i) => {
				const parts = [`${i + 1}. "${r.name}" [id ${r.id}] · ${r.trigger} · ${r.enabled ? "active" : "paused"}`];
				if (r.group) parts.push(`group "${r.group}"`);
				if (r.alert) parts.push(r.alert);
				if (r.nextRunAt) parts.push(`next run ${r.nextRunAt}`);
				if (r.lastRunAt) parts.push(`last run ${r.lastRunAt}${r.lastStatus ? ` (${r.lastStatus})` : ""}`);
				return `${parts.join(" · ")}\n   does: ${r.task}`;
			});
			const more = rows.length > shown.length ? `\n(${rows.length - shown.length} more not shown.)` : "";
			return { ok: true, summary: `Routines (${shown.length}${rows.length > shown.length ? ` of ${rows.length}` : ""}):\n${lines.join("\n")}${more}` };
		},
	});
}
