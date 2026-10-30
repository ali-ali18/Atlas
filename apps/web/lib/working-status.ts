import { defaultTranslator, type Translator } from "./i18n/translator";

export type AgentActivity =
	| { phase: "idle" }
	| { phase: "thinking" }
	| { phase: "writing" }
	/** O rascunho foi retirado e a resposta está sendo refeita. */
	| { phase: "revising" }
	| { phase: "tool"; tool: string; step?: number; maxSteps?: number; /** Alvo da chamada (arquivo, comando), curto. */ detail?: string };

/** Fase do indicador quando chega texto (`writing`) ou quando o rascunho é retirado (`revising`). */
// Objetos fixos: o stream chama isto a cada token e o mesmo valor não dispara outro render do estado.
const WRITING: AgentActivity = { phase: "writing" };
const REVISING: AgentActivity = { phase: "revising" };

export function activityForAssistantEvent(type: "assistant_delta" | "assistant_discard"): AgentActivity {
	return type === "assistant_discard" ? REVISING : WRITING;
}

/** Frase do que o bot faz com a ferramenta, no idioma do tradutor ("{name} está pesquisando"). */
function toolStatus(name: string, tool: string, { t }: Translator): string {
	switch (tool) {
		case "screenshot":
			return t("chat.working.tool.screenshot", { name });
		case "navigate":
		case "browser_text":
		case "browser_links":
			return t("chat.working.tool.search", { name });
		case "type":
		case "browser_type":
		case "key":
			return t("chat.working.tool.typing", { name });
		case "click":
		case "browser_click":
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
