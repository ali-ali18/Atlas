import type { ToolEffect, ToolMetaFields } from "./types.js";

/**
 * Metadado por tool (desenho do harness v3, seção 3/7): `effect`, `poll`, `endsTurn`. Tabela única em vez de
 * campo espalhado por 16 arquivos de handlers: o registro a aplica em cada tool de nome fixo e o teste
 * `tool-meta.test.ts` falha se uma tool do registro, do catálogo ou da sessão de código ficar sem efeito.
 * Só descreve; nenhum laço lê isto ainda (a política v3 e a rede de repetição vão ler).
 *
 * Decisões que não são óbvias:
 * - Navegador e VM são do próprio bot (`write_internal`): clique, digitação e shell não saem da VM por si.
 *   O que toca segredo é `login_fill`/`secret_request` (`credential`).
 * - `propose_*` só gera cartão de aprovação: `write_internal` (a escrita real acontece depois, na decisão).
 * - `api_call` é `write_external` porque o método só se sabe pelos args; leitura via conector MCP é decidida
 *   por `mcpToolEffect`.
 */
export const TOOL_META: Readonly<Record<string, ToolMetaFields>> = {
	// Navegador (VM)
	screenshot: { effect: "read" },
	navigate: { effect: "read" },
	click: { effect: "write_internal" },
	type: { effect: "write_internal" },
	key: { effect: "write_internal" },
	scroll: { effect: "write_internal" },
	browser_click: { effect: "write_internal" },
	browser_type: { effect: "write_internal" },
	browser_text: { effect: "read" },
	browser_links: { effect: "read" },
	browser_snapshot: { effect: "read" },
	browser_act: { effect: "write_internal" },
	browser_wait: { effect: "read", poll: true },
	browser_tabs: { effect: "write_internal" },
	browser_read: { effect: "read" },
	browser_find: { effect: "read" },
	computer: { effect: "write_internal" },

	// VM (shell e arquivos do computador do bot)
	sandbox_shell: { effect: "write_internal" },
	sandbox_shell_wait: { effect: "read", poll: true },
	sandbox_read: { effect: "read" },
	sandbox_list: { effect: "read" },
	sandbox_download: { effect: "read" },
	sandbox_release: { effect: "write_internal" },
	video_transcript: { effect: "read" },

	// Web
	web_search: { effect: "read" },
	web_extract: { effect: "read" },

	// Arquivos e imagens
	attachment_read: { effect: "read" },
	attachment_list: { effect: "read" },
	attachment_to_computer: { effect: "write_internal" },
	generate_image: { effect: "write_internal" },
	show_image: { effect: "read" },
	create_file: { effect: "write_internal" },
	inspect_presentation: { effect: "read" },
	run_code: { effect: "write_internal" },

	// Memória e leitura de contexto
	memory: { effect: "write_internal" },
	session_search: { effect: "read" },
	memory_search: { effect: "read" },
	checkpoint_read: { effect: "read" },
	artifact_read: { effect: "read" },
	lesson_feedback: { effect: "write_internal" },

	// Misc
	app_info: { effect: "read" },
	current_time: { effect: "read" },
	preview_setup: { effect: "write_internal" },

	// Cofre
	secret_list: { effect: "read" },
	routine_webhook_info: { effect: "read" },
	secret_request: { effect: "credential" },
	login_fill: { effect: "credential" },

	// Skills
	skill_read: { effect: "read" },
	list_skills: { effect: "read" },
	show_skill: { effect: "read" },
	propose_skill: { effect: "write_internal" },
	delete_skill: { effect: "write_internal" },
	propose_skill_change: { effect: "write_internal" },
	propose_skill_delete: { effect: "write_internal" },

	// E-mail do bot
	email_list: { effect: "read" },
	email_read: { effect: "read" },
	email_reply: { effect: "send" },
	email_send: { effect: "send" },
	email_create_mailbox: { effect: "write_external" },

	// Proativo
	schedule_followup: { effect: "write_internal" },
	list_followups: { effect: "read" },
	cancel_followup: { effect: "write_internal" },
	reschedule_followup: { effect: "write_internal" },
	suggest_routine: { effect: "write_internal" },
	notify_user: { effect: "send" },

	// Conectores
	propose_connector: { effect: "write_internal" },
	propose_api_connection: { effect: "write_internal" },
	propose_custom_mcp: { effect: "write_internal" },
	api_search: { effect: "read" },
	api_call: { effect: "write_external" },
	mcp_tool_search: { effect: "read" },
	set_connector_tool_marks: { effect: "write_internal" },
	github_list_repos: { effect: "read" },
	github_compare: { effect: "read" },

	// Rotinas
	list_routines: { effect: "read" },
	routine_group: { effect: "write_internal" },
	routine_control: { effect: "write_internal" },
	propose_routine: { effect: "write_internal" },
	report_alert: { effect: "write_internal", endsTurn: true },
	find_page_value: { effect: "read" },

	// Bots e configuração
	propose_bot: { effect: "write_internal" },
	propose_profile_update: { effect: "write_internal" },
	send_to_bot: { effect: "write_external" },
	decide_bot_pending: { effect: "write_internal" },
	set_primary_bot: { effect: "write_internal" },
	set_autonomy: { effect: "write_internal" },
	set_engine: { effect: "write_internal" },
	set_reasoning_effort: { effect: "write_internal" },
	delegate_task: { effect: "write_internal" },
	propose_questionnaire: { effect: "write_internal", endsTurn: true },

	// Planejamento
	research_note: { effect: "write_internal" },
	propose_plan: { effect: "write_internal", endsTurn: true },
	update_task_list: { effect: "write_internal" },
	track_items: { effect: "write_internal" },

	// Painéis
	page_create: { effect: "write_internal" },
	page_update: { effect: "write_internal" },
	page_read: { effect: "read" },
	page_list: { effect: "read" },
	page_share: { effect: "public_link" },

	// Trabalho longo (motor v2)
	notebook_write: { effect: "write_internal" },
	notebook_read: { effect: "read" },
	delegate: { effect: "write_internal" },

	// Sessão de código (resolvedor `devSessionResolver`)
	dev_session_start: { effect: "write_internal" },
	shell: { effect: "write_internal" },
	shell_output: { effect: "read", poll: true },
	shell_stdin: { effect: "write_internal" },
	shell_kill: { effect: "write_internal" },
	read_file: { effect: "read" },
	write_file: { effect: "write_internal" },
	edit_file: { effect: "write_internal" },
	list_files: { effect: "read" },
	grep: { effect: "read" },
	todo_write: { effect: "write_internal" },
	dev_environment_get: { effect: "read" },
	dev_environment_update: { effect: "write_internal" },
	request_secrets: { effect: "credential" },
	dev_pr_create: { effect: "write_external" },
	dev_pr_checkout: { effect: "write_internal" },
	dev_ci_status: { effect: "read", poll: true },
	dev_ci_logs: { effect: "read" },
	preview_start: { effect: "write_internal" },
	preview_stop: { effect: "write_internal" },
};

/** Metadado da tool de nome fixo; `undefined` para MCP e nome desconhecido (ver `mcpToolEffect`). */
export function getToolMeta(name: string): ToolMetaFields | undefined {
	return Object.hasOwn(TOOL_META, name) ? TOOL_META[name] : undefined;
}

/**
 * Efeito de uma tool de conector MCP. Deriva da classificação que já existe
 * (`isReadOnlyMcpTool` em `@workspace/shared`, anotações do servidor + marcas do usuário) em vez de criar outra: leitura = `read`; o resto = `write_external` (escrita em terceiro).
 */
export function mcpToolEffect(isReadOnly: boolean): ToolEffect {
	return isReadOnly ? "read" : "write_external";
}
