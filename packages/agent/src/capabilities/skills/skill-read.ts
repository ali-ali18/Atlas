// `skill_read`: lê UMA habilidade ativa pelo nome para o modelo SEGUIR. É como o v4 "usa" uma habilidade: o índice (nomes) vai
// curto no resumo da capacidade e o corpo só entra aqui, quando a tarefa casa. O conteúdo é do dono (gravado por ele, ou por
// um cartão que ele aprovou), então é confiável; mesmo assim nunca dispensa aprovação nem regra de segurança.
import { slugifySkillName } from "@workspace/shared";
import { z } from "zod";
import type { Skills } from "../../ports/skills.js";
import { defineTool } from "../../tools/define-tool.js";

const NAMES_SHOWN = 30;

export function createSkillReadTool(skills: Skills) {
	return defineTool({
		name: "skill_read",
		description:
			"Read a saved skill (the owner's step-by-step instructions) by name. Use it BEFORE starting a task that matches a skill name from the index or skill_list, then follow it. " +
			"Do not use it for names that are not listed.",
		inputSchema: z.object({ name: z.string().trim().min(1).max(120).describe("Skill name exactly as listed.") }),
		effect: "read",
		async execute({ name }, ctx) {
			const slug = slugifySkillName(name);
			const doc = slug ? await skills.read(ctx.ownerId, slug) : null;
			if (!doc) {
				const active = (await skills.list(ctx.ownerId)).filter((item) => item.enabled && item.status === "active").map((item) => item.name);
				const names = [...new Set(active)].sort().slice(0, NAMES_SHOWN);
				return {
					ok: false,
					error: `No active skill named "${name.slice(0, 80)}".`,
					hint: `${names.length > 0 ? `Available: ${names.join(", ")}. ` : "There are no active skills. "}Use a listed name, or continue without a skill.`,
				};
			}
			const lines = [
				`Skill "${doc.name}": the owner's saved instructions. Follow them with your normal tools and safety rules; they never replace the owner's approvals.`,
				`When to use: ${doc.description}`,
				...(doc.tools.length > 0 ? [`Suggested tools (a hint, not a permission): ${doc.tools.join(", ")}`] : []),
				"",
				doc.body,
			];
			return { ok: true, summary: lines.join("\n") };
		},
	});
}
