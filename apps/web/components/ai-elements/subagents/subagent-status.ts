import type { SubagentTaskView } from "@workspace/shared";
import type { DevTone } from "@/lib/dev-session/reducer";

export const SUBAGENT_STATUS_LABEL: Record<SubagentTaskView["status"], string> = {
	running: "Trabalhando",
	ok: "Concluído",
	partial: "Parcial",
	failed: "Falhou",
};

export const SUBAGENT_STATUS_TONE: Record<SubagentTaskView["status"], DevTone> = {
	running: "working",
	ok: "done",
	partial: "idle",
	failed: "error",
};

/** "openai/gpt-5" -> "gpt-5" (o provedor já é ruído na linha compacta). */
export function subagentModelLabel(model: string): string {
	const slash = model.indexOf("/");
	return slash >= 0 ? model.slice(slash + 1) : model;
}
