import type { SubagentTaskView } from "@workspace/shared";
import { subagentLabel } from "@workspace/shared";
import type { DevTone } from "@/lib/dev-session/reducer";
import { defaultTranslator, type MessageKey, type Translator } from "@/lib/i18n/translator";

export const SUBAGENT_STATUS_KEYS = {
	running: "aiElements.subagents.status.running",
	ok: "aiElements.subagents.status.ok",
	partial: "aiElements.subagents.status.partial",
	failed: "aiElements.subagents.status.failed",
} as const satisfies Record<SubagentTaskView["status"], MessageKey>;

export function subagentStatusLabel(status: SubagentTaskView["status"], { t }: Translator = defaultTranslator): string {
	return t(SUBAGENT_STATUS_KEYS[status]);
}

/** Nome do subagente na tela: o `subagentLabel` do shared, com o "Tarefa N" (sem título nem objetivo) no idioma da tela. */
export function subagentTitle(task: { title?: string; goal: string; taskIndex: number }, { t }: Translator = defaultTranslator): string {
	if (!task.title?.trim() && !task.goal.replace(/\s+/g, " ").trim()) return t("aiElements.subagents.taskN", { number: task.taskIndex + 1 });
	return subagentLabel(task);
}

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

const REASON_MAX_CHARS = 90;

/**
 * Motivo curto de uma tarefa que falhou ou parou no meio (primeira linha do relatório, sem o
 * prefixo técnico), para a linha compacta: o usuário vê por que falhou sem abrir o detalhe.
 */
export function subagentFailureReason(task: Pick<SubagentTaskView, "status" | "summary">): string | null {
	if (task.status !== "failed" && task.status !== "partial") return null;
	const first = (task.summary ?? "")
		.split("\n")
		.map((line) => line.trim())
		.find((line) => line.length > 0 && !line.startsWith("["));
	if (!first) return null;
	const text = first.replace(/^Sub-agent failed:\s*/i, "").replace(/\s+/g, " ");
	return text.length > REASON_MAX_CHARS ? `${text.slice(0, REASON_MAX_CHARS - 1)}…` : text;
}
