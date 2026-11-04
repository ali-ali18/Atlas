import { persistConversationCardFromEvent } from "@workspace/db";
import type { ToolContext, ToolResult } from "../types.js";
import { dbSkillsStore, executeSkillTool, type SkillToolContext } from "../../skills.js";
export { executeDevSessionTool } from "../../registry/handlers/dev.js";


import type { ToolFamily } from "../registry.js";
import { defineRawTool, definedFamily, type DefinedTool } from "../../define-tool.js";
import { SKILL_READ_TOOL, PROPOSE_SKILL_TOOL, DELETE_SKILL_TOOL } from "../../skills.js";

async function handleSkillReadGroup(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
	return executeSkillTool(name, args, skillToolContext(ctx));
}

/** Família `skills`: definição, metadado e handler de cada tool num lugar só (`defineRawTool`, harness v3 PR5b). */
export const SKILLS_DEFINED: readonly DefinedTool[] = [
	defineRawTool({
		name: "skill_read",
		definition: SKILL_READ_TOOL,
		effect: "read",
		group: "skills",
		run: (args, ctx) => handleSkillReadGroup("skill_read", args, ctx),
	}),
	defineRawTool({
		name: "propose_skill",
		definition: PROPOSE_SKILL_TOOL,
		effect: "write_internal",
		endsTurn: true,
		needsHuman: true,
		ownCard: true,
		group: "skills",
		run: (args, ctx) => handleSkillReadGroup("propose_skill", args, ctx),
	}),
	defineRawTool({
		name: "delete_skill",
		definition: DELETE_SKILL_TOOL,
		effect: "write_internal",
		endsTurn: true,
		needsHuman: true,
		group: "skills",
		run: (args, ctx) => handleSkillReadGroup("delete_skill", args, ctx),
	}),
	defineRawTool({
		name: "list_skills",
		effect: "read",
		endsTurn: true,
		group: "skills",
		run: (args, ctx) => handleSkillReadGroup("list_skills", args, ctx),
	}),
	defineRawTool({
		name: "show_skill",
		effect: "read",
		endsTurn: true,
		group: "skills",
		run: (args, ctx) => handleSkillReadGroup("show_skill", args, ctx),
	}),
	defineRawTool({
		name: "propose_skill_change",
		effect: "write_internal",
		endsTurn: true,
		needsHuman: true,
		ownCard: true,
		group: "skills",
		run: (args, ctx) => handleSkillReadGroup("propose_skill_change", args, ctx),
	}),
	defineRawTool({
		name: "propose_skill_delete",
		effect: "write_internal",
		endsTurn: true,
		needsHuman: true,
		ownCard: true,
		group: "skills",
		run: (args, ctx) => handleSkillReadGroup("propose_skill_delete", args, ctx),
	}),
];

export const SKILLS_TOOLS: ToolFamily = definedFamily(SKILLS_DEFINED);

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
