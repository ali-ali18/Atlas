import { defaultTranslator, type Translator } from "./i18n/translator";

export type AgentActivity =
	| { phase: "idle" }
	/** `toolFailed`: a ferramenta que acabou de rodar falhou (o avatar reage; o texto não muda). */
	| { phase: "thinking"; toolFailed?: boolean }
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

/**
 * Família da ferramenta: uma só classificação para o texto do indicador e para o
 * avatar (`avatar-activity.ts`). `act`, `web`, `read`, `code`, `run` e `delegate` não têm
 * frase própria (usam a padrão); só o avatar os distingue.
 */
export type ToolKind =
	| "screenshot"
	| "navigate"
	| "type"
	| "click"
	| "act"
	| "scroll"
	| "memory"
	| "web"
	| "read"
	| "code"
	| "run"
	| "delegate"
	| "other";

export function toolKind(tool: string): ToolKind {
	switch (tool) {
		case "screenshot":
			return "screenshot";
		case "navigate":
		case "browser_text":
		case "browser_links":
			return "navigate";
		case "type":
		case "browser_type":
		case "key":
			return "type";
		case "click":
		case "browser_click":
			return "click";
		case "browser_act":
			return "act";
		case "scroll":
			return "scroll";
		case "memory":
			return "memory";
		case "delegate_task":
		case "send_to_bot":
			return "delegate";
		case "shell":
		case "shell_stdin":
		case "shell_output":
		case "shell_kill":
		case "sandbox_shell":
		case "sandbox_shell_wait":
		case "run_code":
			return "run";
		case "write_file":
		case "edit_file":
		case "create_file":
		case "create_spreadsheet":
		case "create_note":
		case "append_rows":
		case "update_range":
		case "add_sheet":
			return "code";
		default:
			break;
	}
	if (/^(web_|firecrawl_|fetch_page|search|session_search|mcp_tool_search)/.test(tool) || tool.includes("__search")) return "web";
	if (/^(read|get_|list_|attachment_read|artifact_read|skill_read|sandbox_read|sandbox_list|show_image|grep)/.test(tool)) return "read";
	return "other";
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
