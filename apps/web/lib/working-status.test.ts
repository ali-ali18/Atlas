import assert from "node:assert/strict";
import test from "node:test";

import { activityForAssistantEvent, toolKind, workingStatusLabel, type AgentActivity } from "./working-status";

// Mesma sequência do onDelta/onDiscard do use-atlas-chat: o indicador acompanha o evento.
test("assistant_discard expõe a fase 'revising' enquanto a resposta é refeita", () => {
	let activity: AgentActivity = activityForAssistantEvent("assistant_delta");
	assert.equal(activity.phase, "writing");

	activity = activityForAssistantEvent("assistant_discard");
	assert.equal(activity.phase, "revising");
	assert.equal(workingStatusLabel("Atlas", activity), "Revisando a resposta…");
});

test("novos deltas depois do descarte trocam 'revising' por 'writing'", () => {
	let activity = activityForAssistantEvent("assistant_discard");
	assert.equal(activity.phase, "revising");

	activity = activityForAssistantEvent("assistant_delta");
	assert.equal(activity.phase, "writing");
	assert.equal(workingStatusLabel("Atlas", activity), "Atlas está escrevendo");
});

test("o indicador de trabalho fala o idioma do tradutor", async () => {
	const { createTranslator } = await import("./i18n/translator");
	const { loadMessages } = await import("./i18n/messages");
	const en = createTranslator("en-US", await loadMessages("en-US"));
	const es = createTranslator("es-ES", await loadMessages("es-ES"));
	assert.equal(workingStatusLabel("Atlas", { phase: "writing" }, undefined, en), "Atlas is writing");
	assert.equal(workingStatusLabel("Atlas", { phase: "tool", tool: "navigate", step: 1, maxSteps: 8 }, undefined, en), "Atlas is searching (step 2 of 8)");
	assert.equal(workingStatusLabel("Atlas", { phase: "tool", tool: "screenshot" }, undefined, es), "Atlas está mirando la pantalla");
	assert.equal(workingStatusLabel("Atlas", { phase: "thinking" }, { status: "waiting_user" }, en), "Atlas is waiting for you");
	assert.equal(workingStatusLabel("Atlas", { phase: "revising" }, undefined, en), "Revising the answer…");
	assert.equal(workingStatusLabel("Atlas", { phase: "tool", tool: "memory", step: 0, maxSteps: 3 }), "Atlas está consultando a memória (passo 1 de 3)");
});

// O avatar passou a usar a mesma classificação; o texto do indicador não pode mudar por causa disso.
test("toolKind: ferramentas novas no avatar não mudam a frase do indicador", () => {
	assert.equal(workingStatusLabel("Atlas", { phase: "tool", tool: "web_search" }), "Atlas está trabalhando");
	assert.equal(workingStatusLabel("Atlas", { phase: "tool", tool: "browser_act" }), "Atlas está trabalhando");
	assert.equal(workingStatusLabel("Atlas", { phase: "tool", tool: "edit_file" }), "Atlas está trabalhando");
	assert.equal(workingStatusLabel("Atlas", { phase: "tool", tool: "navigate" }), "Atlas está pesquisando");
	assert.equal(toolKind("web_search"), "web");
	assert.equal(toolKind("edit_file"), "code");
	assert.equal(toolKind("shell"), "run");
});

// Tabela com os nomes reais de ferramenta do runtime: nenhuma pode cair em "other" por esquecimento.
// "other" é só para o que não tem gesto próprio (propor, agendar, configurar, apagar).
test("toolKind: tabela com as ferramentas reais do runtime", () => {
	const table: Record<string, ReturnType<typeof toolKind>> = {
		// navegador
		navigate: "navigate", browser_text: "navigate", browser_links: "navigate",
		screenshot: "screenshot", browser_snapshot: "read", browser_read: "read", browser_find: "read", browser_extract: "read", browser_tabs: "read", browser_wait: "read",
		browser_act: "act", browser_click: "click", browser_type: "type", click: "click", type: "type", key: "type", scroll: "scroll",
		// pesquisa
		web_search: "web", web_extract: "web", fetch_page: "web", firecrawl_search: "web", firecrawl_scrape: "web", firecrawl_crawl: "web",
		session_search: "web", mcp_tool_search: "web", api_search: "web", search_files: "web", search_messages: "web",
		// leitura
		read_file: "read", read_range: "read", read_message: "read", read_cached_result: "read", artifact_read: "read", attachment_read: "read",
		attachment_list: "read", skill_read: "read", sandbox_read: "read", sandbox_list: "read", sandbox_download: "read", show_image: "read",
		grep: "read", find: "read", get_event: "read", get_spreadsheet: "read", get_file_contents: "read", list_files: "read", list_events: "read",
		list_issues: "read", list_prs: "read", list_routines: "read", list_recent_files: "read", list_calendars: "read",
		checkpoint_read: "read", email_list: "read", email_read: "read", github_compare: "read", github_list_repos: "read",
		dev_ci_logs: "read", dev_ci_status: "read", dev_environment_get: "read",
		// memória e raciocínio
		memory: "memory", memory_search: "memory",
		todo_write: "think", current_time: "think", context_summary: "think",
		// escrita
		write_file: "code", edit_file: "code", create_file: "code", create_spreadsheet: "code", create_note: "code", append_rows: "code",
		update_range: "code", add_sheet: "code", generate_image: "code", create_event: "code", create_draft: "code", create_issue: "code",
		create_repository: "code", create_order: "code", email_send: "code", email_reply: "code", email_create_mailbox: "code",
		send_message: "code", send_whatsapp: "code", dev_environment_update: "code", dev_pr_create: "code",
		// execução
		shell: "run", shell_stdin: "run", shell_output: "run", shell_kill: "run", sandbox_shell: "run", sandbox_shell_wait: "run", run_code: "run",
		api_call: "run", lint: "run", preview_start: "run", preview_stop: "run", dev_session_start: "run", dev_pr_checkout: "run",
		// delegação
		delegate_task: "delegate", send_to_bot: "delegate",
		// conectores (MCP) pelo verbo
		mcp__github__read_things: "read", mcp__timing__read: "read", mcp__google_calendar__list_events: "read",
		mcp__google_drive__list_recent_files: "read", mcp__n8n__get_workflow_sdk_reference: "read", mcp__n8n__validate_workflow: "read",
		mcp__drive__search_files: "web", mcp__gmail__search_messages: "web", mcp__gmail__search_threads: "web", mcp__notion__search: "web", mcp__data__search: "web",
		mcp__notion__create_page: "other", mcp__gmail__send_email: "other", mcp__data__update: "other", mcp__github__issue_write: "other",
		mcp__github__issue_read: "read", mcp__github__pull_request_read: "read", mcp__github__actions_get: "read", mcp__github__actions_list: "read",
		mcp__github__search_code: "web", mcp__x__issues_query: "web",
		mcp__firecrawl__firecrawl_scrape: "web", mcp__firecrawl__scrape: "web", mcp__firecrawl__crawl: "web", mcp__firecrawl__map: "web", mcp__firecrawl__extract: "web", mcp__firecrawl__search: "web",
		// sem gesto próprio
		propose_routine: "other", schedule_followup: "other", set_autonomy: "other", delete_event: "other", sandbox_release: "other",
	};
	const wrong = Object.entries(table).filter(([name, kind]) => toolKind(name) !== kind).map(([name, kind]) => `${name}: esperado ${kind}, veio ${toolKind(name)}`);
	assert.deepEqual(wrong, []);
	assert.ok(Object.keys(table).length >= 90, `tabela com ${Object.keys(table).length} nomes`);
});

test("toolKind: a frase do indicador só muda para memória (memory_search) e fica igual no resto", () => {
	assert.equal(workingStatusLabel("Atlas", { phase: "tool", tool: "memory_search" }), "Atlas está consultando a memória");
	assert.equal(workingStatusLabel("Atlas", { phase: "tool", tool: "browser_snapshot" }), "Atlas está trabalhando");
});
