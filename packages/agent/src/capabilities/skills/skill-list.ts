// `skill_list`: as habilidades do dono neste run (conta + este bot). Só nome, quando usar e situação; o corpo vem com `skill_read`.
import { z } from "zod";
import type { SkillDoc, Skills } from "../../ports/skills.js";
import { defineTool } from "../../tools/define-tool.js";

export const SKILL_LIST_MAX = 60;

function line(doc: SkillDoc): string {
	const state = doc.status === "draft" ? " [draft]" : doc.enabled ? "" : " [off]";
	return `- ${doc.name}${doc.scope === "bot" ? " (this bot only)" : ""}${state}: ${doc.description}`;
}

export function createSkillListTool(skills: Skills) {
	return defineTool({
		name: "skill_list",
		description:
			"List the owner's saved skills (step-by-step procedures): name, when to use it and whether it is active, a draft or off. Use it when the owner asks what skills exist, or before creating one to avoid a duplicate. " +
			"Do not use it to follow a skill (skill_read) and do not repeat the whole list to the owner unless they asked for it.",
		inputSchema: z.object({}),
		effect: "read",
		async execute(_args, ctx) {
			const docs = await skills.list(ctx.ownerId);
			if (docs.length === 0) return { ok: true, summary: "No skills saved yet." };
			const shown = docs.slice(0, SKILL_LIST_MAX);
			const more = docs.length > shown.length ? `\n(+${docs.length - shown.length} more not shown)` : "";
			return { ok: true, summary: `${docs.length} skill${docs.length === 1 ? "" : "s"}:\n${shown.map(line).join("\n")}${more}` };
		},
	});
}
