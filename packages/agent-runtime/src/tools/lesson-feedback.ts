import type { ChatTool } from "@workspace/llm";
import { parseLessonFeedback, type LessonFeedbackEntry } from "@workspace/shared";
import { recordLessonFeedback } from "@workspace/db";

export const LESSON_FEEDBACK_TOOL_NAME = "lesson_feedback";

export const LESSON_FEEDBACK_TOOL: ChatTool = {
	type: "function",
	function: {
		name: LESSON_FEEDBACK_TOOL_NAME,
		description:
			"Report which lessons from the LESSONS LEARNED block you actually applied, so the playbook improves. Call it at most once, near the end of the task and before your final reply, with the ids you used (like L1a2b) and, for each, whether it helped (the outcome was good because of it), hurt (following it caused a problem) or was merely applied. Do not call it when you used none. Never put anything else in it.",
		parameters: {
			type: "object",
			properties: {
				lessons: {
					type: "array",
					items: {
						type: "object",
						properties: {
							id: { type: "string", description: "Lesson id as shown, e.g. L1a2b." },
							outcome: { type: "string", enum: ["helped", "hurt", "applied"] },
						},
						required: ["id"],
					},
				},
			},
			required: ["lessons"],
		},
	},
};

export type LessonFeedbackContext = {
	userId?: string;
	botId?: string | null;
	record?: (entries: LessonFeedbackEntry[]) => Promise<{ applied: string[]; unknown: string[]; retired: string[] }>;
};

/** Grava o feedback; erro honesto se nada casou. O dono e o bot vêm do run, nunca do modelo. */
export async function executeLessonFeedback(args: Record<string, unknown>, ctx: LessonFeedbackContext): Promise<string> {
	const entries = parseLessonFeedback(args);
	if (entries.length === 0) throw new Error("pass at least one lesson id from the LESSONS LEARNED block, e.g. {\"lessons\":[{\"id\":\"L1a2b\",\"outcome\":\"helped\"}]}.");
	const userId = ctx.userId?.trim();
	const botId = ctx.botId?.trim();
	if (!ctx.record && (!userId || userId === "default" || !botId)) throw new Error("lesson feedback is unavailable: this run has no signed-in owner or bot.");
	const result = await (ctx.record ?? ((list) => recordLessonFeedback(userId!, botId!, list)))(entries);
	if (result.applied.length === 0) throw new Error(`no active lesson matched ${entries.map((entry) => entry.ref).join(", ")}. Use the ids shown in the LESSONS LEARNED block.`);
	const extra = result.unknown.length > 0 ? ` Unknown ids ignored: ${result.unknown.join(", ")}.` : "";
	return `Recorded feedback for ${result.applied.length} lesson(s).${extra} Do not call lesson_feedback again in this run.`;
}
