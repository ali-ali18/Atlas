import { persistConversationCardFromEvent } from "@workspace/db";
import type { ToolContext, ToolResult } from "../types.js";
import { dbSkillsStore, executeSkillTool, type SkillToolContext } from "../../skills.js";
export { executeDevSessionTool } from "../../registry/handlers/dev.js";


import type { ToolFamily } from "../registry.js";

async function handleSkillReadGroup(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
	return executeSkillTool(name, args, skillToolContext(ctx));
}

/** Família `skills`. */
export const SKILLS_TOOLS: ToolFamily = {
	"skill_read": { group: "skills", handler: (args, ctx) => handleSkillReadGroup("skill_read", args, ctx) },
	"propose_skill": { group: "skills", handler: (args, ctx) => handleSkillReadGroup("propose_skill", args, ctx) },
	"delete_skill": { group: "skills", handler: (args, ctx) => handleSkillReadGroup("delete_skill", args, ctx) },
	"list_skills": { group: "skills", handler: (args, ctx) => handleSkillReadGroup("list_skills", args, ctx) },
	"show_skill": { group: "skills", handler: (args, ctx) => handleSkillReadGroup("show_skill", args, ctx) },
	"propose_skill_change": { group: "skills", handler: (args, ctx) => handleSkillReadGroup("propose_skill_change", args, ctx) },
	"propose_skill_delete": { group: "skills", handler: (args, ctx) => handleSkillReadGroup("propose_skill_delete", args, ctx) },
};

/** Contexto enxuto das tools de skill (o módulo `tools/skills.ts` não conhece o `ToolContext`). */
export function skillToolContext(ctx: ToolContext): SkillToolContext {
	return {
		userId: ctx.userId,
		botId: ctx.botId,
		conversationId: ctx.conversationId,
		runId: ctx.runId,
		origin: ctx.origin,
		autonomy: ctx.autonomy,
		recentUserTexts: ctx.recentUserTexts,
		store: ctx.skillStore ?? dbSkillsStore,
		persistCard: (event) => persistConversationCardFromEvent(ctx.conversationId, event),
	};
}
