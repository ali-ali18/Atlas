// `skill_delete`: apaga uma habilidade. `destructive`: o dono confirma no cartão de aprovação em qualquer autonomia e, sem
// dono presente, a tool nem existe. O adaptador mostra o cartão "apagada" no chat.
import { slugifySkillName } from "@workspace/shared";
import { z } from "zod";
import type { SkillDoc, Skills } from "../../ports/skills.js";
import { defineTool } from "../../tools/define-tool.js";

async function resolve(skills: Skills, ownerId: string, rawName: string, scope: "account" | "bot" | undefined): Promise<SkillDoc | undefined> {
	const name = slugifySkillName(rawName);
	const named = (await skills.list(ownerId)).filter((doc) => doc.name === name);
	if (scope) return named.find((doc) => doc.scope === scope);
	return named.find((doc) => doc.scope === "bot") ?? named.find((doc) => doc.scope === "account");
}

export function createSkillDeleteTool(skills: Skills) {
	return defineTool({
		name: "skill_delete",
		description:
			"Delete a skill by name. Use it ONLY when the owner explicitly asks to delete or remove that skill (to just stop using it, leave it). It cannot be undone, so the owner always confirms first; nothing is deleted before that. Not for editing a skill (skill_save).",
		inputSchema: z.object({
			name: z.string().trim().min(1).max(120).describe("Skill name from skill_list."),
			scope: z.enum(["account", "bot"]).optional().describe("Only when the same name exists in both scopes."),
		}),
		effect: "destructive",
		riskFacts: ({ name }) => ({ irreversible: true, target: `Habilidade: ${name}` }),
		async enrichRiskFacts({ name, scope }, base, { ownerId }) {
			const found = await resolve(skills, ownerId, name, scope);
			return found ? { ...base, target: `Habilidade: ${found.name}${found.scope === "bot" ? " (só deste bot)" : ""}` } : base;
		},
		async execute({ name, scope }, ctx) {
			const found = await resolve(skills, ctx.ownerId, name, scope);
			if (!found) return { ok: false, error: `No skill named "${name.slice(0, 80)}" to delete.`, hint: "Check the name with skill_list." };
			const removed = await skills.remove(ctx.ownerId, ctx.runId, found.id);
			if (!removed) return { ok: false, error: `No skill named "${found.name}" to delete.`, hint: "It may have been deleted already. Call skill_list." };
			return { ok: true, summary: `Skill "${found.name}" deleted for good.`, receipt: { what: `Habilidade apagada: ${found.name}`, where: "Habilidades", externalId: found.id } };
		},
	});
}
