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
 * avatar (`avatar-activity.ts`). `act`, `web`, `read`, `code`, `run`, `think` e `delegate` não têm
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
	/** Ferramenta de raciocínio, sem efeito fora (plano, hora, resumo de contexto): o avatar segue "pensando". */
	| "think"
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
		case "memory_search":
			return "memory";
		case "todo_write":
		case "current_time":
		case "context_summary":
			return "think";
		case "browser_snapshot":
		case "browser_read":
		case "browser_find":
		case "browser_extract":
		case "browser_tabs":
		case "browser_wait":
		case "checkpoint_read":
		case "sandbox_download":
		case "attachment_list":
		case "find":
			return "read";
		case "api_search":
			return "web";
		case "api_call":
		case "lint":
		case "preview_start":
		case "preview_stop":
		case "dev_session_start":
		case "dev_pr_checkout":
			return "run";
		case "dev_ci_logs":
		case "dev_ci_status":
		case "dev_environment_get":
			return "read";
		case "dev_environment_update":
		case "dev_pr_create":
		case "generate_image":
		case "create_event":
		case "create_draft":
		case "create_issue":
		case "create_repository":
		case "create_order":
		case "email_send":
		case "email_reply":
		case "email_create_mailbox":
		case "send_message":
		case "send_whatsapp":
			return "code";
		case "email_list":
		case "email_read":
		case "github_compare":
		case "github_list_repos":
			return "read";
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
	const mcp = /^mcp__(.+?)__(.+)$/.exec(tool);
	if (mcp) {
		// Pelo verbo da operação do conector, no começo ou no fim do nome (search_files, issue_read, actions_list):
		// ler/listar → read, buscar → web, o resto (escrever…) → other.
		const [server = "", op = ""] = [mcp[1], mcp[2]];
		if (server === "firecrawl" && /^(firecrawl_)?(scrape|crawl|extract|map|search)/.test(op)) return "web";
		const words = op.split("_");
		const has = (re: RegExp) => re.test(words[0] ?? "") || re.test(words[words.length - 1] ?? "");
		if (has(/^(search|query)$/)) return "web";
		if (has(/^(read|get|list|fetch|view|show|find|lookup|describe|validate)$/)) return "read";
		return "other";
	}
	if (/^(web_|firecrawl_|fetch_page|search|session_search|mcp_tool_search)/.test(tool)) return "web";
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

/**
 * Status do run depois de chegar o primeiro sinal de vida (evento `run`, texto ou ferramenta): "queued" vira
 * "running". O app grava "queued" ao criar o run e o servidor não manda "running" num run normal, então sem isto o
 * indicador ficava em "está começando" o run inteiro. Qualquer outro status (retrying, waiting_*, paused, pausing…)
 * continua como está.
 */
export function runStatusOnProgress(status: string | null): string | null {
	return status === "queued" ? "running" : status;
}
