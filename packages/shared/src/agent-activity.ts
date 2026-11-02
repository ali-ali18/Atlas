// O que o bot está fazendo (fase + ferramenta) e a família da ferramenta. Puro: o web (texto do indicador, avatar) e o app
// mobile compartilham esta classificação.

export type AgentActivity =
	| { phase: "idle" }
	/** `toolFailed`: a ferramenta que acabou de rodar falhou (o avatar reage; o texto não muda). */
	| { phase: "thinking"; toolFailed?: boolean }
	| { phase: "writing" }
	/** O rascunho foi retirado e a resposta está sendo refeita. */
	| { phase: "revising" }
	| {
			phase: "tool";
			tool: string;
			step?: number;
			maxSteps?: number;
			/** Alvo da chamada (arquivo, comando), curto. */
			detail?: string;
			/** Só o nome chegou: o modelo ainda gera os argumentos (o `tool_call` com passo vem depois). */
			arriving?: true;
	  };

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

/**
 * `mcp__<servidor>__<operação>` → partes. Sem regex de propósito: o nome vem do conector (entrada externa) e um
 * `/^mcp__(.+?)__(.+)$/` retrocede em tempo quadrático com nomes longos (alerta do CodeQL). Mesmas regras da regex:
 * servidor com pelo menos 1 caractere até o primeiro `__`, operação não vazia, sem quebra de linha.
 */
export function splitMcpTool(tool: string): { server: string; op: string } | null {
	if (!tool.startsWith("mcp__") || /[\r\n]/.test(tool)) return null;
	const rest = tool.slice(5);
	const at = rest.indexOf("__", 1);
	if (at < 1) return null;
	const op = rest.slice(at + 2);
	return op ? { server: rest.slice(0, at), op } : null;
}

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
	const mcp = splitMcpTool(tool);
	if (mcp) {
		// Pelo verbo da operação do conector, no começo ou no fim do nome (search_files, issue_read, actions_list):
		// ler/listar → read, buscar → web, o resto (escrever…) → other.
		const { server, op } = mcp;
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
