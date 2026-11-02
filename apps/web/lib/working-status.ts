import { type AgentActivity, toolKind } from "@workspace/shared";

import { defaultTranslator, type Translator } from "./i18n/translator";

export { type AgentActivity, type ToolKind, toolKind } from "@workspace/shared";

/** Fase do indicador quando chega texto (`writing`) ou quando o rascunho é retirado (`revising`). */
// Objetos fixos: o stream chama isto a cada token e o mesmo valor não dispara outro render do estado.
const WRITING: AgentActivity = { phase: "writing" };
const REVISING: AgentActivity = { phase: "revising" };

export function activityForAssistantEvent(type: "assistant_delta" | "assistant_discard"): AgentActivity {
	return type === "assistant_discard" ? REVISING : WRITING;
}

/**
 * Atividade do aviso `tool_intent`: a ferramenta já foi escolhida, mas ainda não começou. `null` quando o aviso
 * não muda nada (ferramenta de raciocínio: o avatar segue "pensando").
 */
export function activityForToolIntent(tool: string): AgentActivity | null {
	if (!tool || toolKind(tool) === "think") return null;
	return { phase: "tool", tool, arriving: true };
}

/** Frase do que o bot faz com a ferramenta, no idioma do tradutor ("{name} está pesquisando"). */
function toolStatus(name: string, tool: string, { t }: Translator): string {
	switch (toolKind(tool)) {
		case "screenshot":
			return t("chat.working.tool.screenshot", { name });
		case "navigate":
			return t("chat.working.tool.search", { name });
		case "type":
			return t("chat.working.tool.typing", { name });
		case "click":
			return t("chat.working.tool.click", { name });
		case "scroll":
			return t("chat.working.tool.scroll", { name });
		case "memory":
			return t("chat.working.tool.memory", { name });
		default:
			return t("chat.working.default", { name });
	}
}

export function workingStatusLabel(
	agentName: string,
	activity: AgentActivity,
	options?: { paused?: boolean; tick?: number; status?: string | null },
	translator: Translator = defaultTranslator,
): string {
	const { t } = translator;
	const name = agentName;
	if (options?.paused || options?.status === "paused") {
		return t("chat.working.paused", { name });
	}

	switch (options?.status) {
		case "queued":
			return t("chat.working.queued", { name });
		case "waiting_user":
			return t("chat.working.waitingUser", { name });
		case "waiting_external":
			return t("chat.working.waitingExternal", { name });
		case "retrying":
			return t("chat.working.retrying", { name });
		default:
			break;
	}

	switch (activity.phase) {
		case "writing":
			return t("chat.working.writing", { name });
		case "tool": {
			const base = toolStatus(name, activity.tool, translator);
			if (typeof activity.step === "number" && typeof activity.maxSteps === "number") {
				return t("chat.working.step", { base, step: activity.step + 1, max: activity.maxSteps });
			}
			return base;
		}
		case "revising":
			return t("chat.working.revising");
		default:
			return t("chat.working.default", { name });
	}
}

/**
 * Status do run depois de chegar o primeiro sinal de vida (evento `run`, texto ou ferramenta): "queued" vira
 * "running". O app grava "queued" ao criar o run e o servidor não manda "running" num run normal, então sem isto o
 * indicador ficava em "está começando" o run inteiro. Qualquer outro status (retrying, waiting_*, paused, pausing…)
 * continua como está.
 */
export function runStatusOnProgress(status: string | null): string | null {
	return status === "queued" ? "running" : status;
}
