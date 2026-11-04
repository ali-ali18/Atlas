import { getToolRegistration } from "./index.js";
import type { ToolEffect, ToolMetaFields, ToolRegistration } from "./types.js";

const READ_HTTP_METHODS = new Set(["GET", "HEAD"]);

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
 * - `effect` é o pior caso; `effectForArgs` o refina por chamada (`resolveToolEffect`): `api_call` só lê, `sandbox_download`
 *   só é `credential` com a sessão do navegador. Tool de conector MCP é decidida por `mcpToolEffect`.
 * - `propose_routine`/`routine_group` criam webhook no GitHub do dono (`ensureGithubRepoHook`): `write_external`.
 *   `decide_bot_pending` aprova ação de outro bot: `write_external` (igual a `NATIVE_WRITE_TOOLS` do pre-tool).
 * - `endsTurn` = encerra o turno quando devolve cartão pendente (computer-use.ts, `stopFor*`).
 * - `ownCard` = a tool já mostra o cartão de aprovação dela (e-mail, propostas, imagem, PR, segredo, login, sessão de
 *   código): o motor v3 não põe o cartão genérico em cima (substitui a lista fixa `OWN_CARD_TOOLS` do approval.ts).
 * - `needsHuman` = muda as próprias permissões (hoje com o portão `humanTurn`) ou só existe com humano hoje: questionário, `sandbox_release`,
 *   skills, `delegate*` e `propose_bot` (espelha os filtros por origem do catálogo v1/v2).
 */
export const TOOL_META: Readonly<Record<string, ToolMetaFields>> = {
	// Navegador (VM)

	// VM (shell e arquivos do computador do bot)
	sandbox_shell: { effect: "write_internal" },
	sandbox_shell_wait: { effect: "read", poll: true },
	sandbox_read: { effect: "read" },
	sandbox_list: { effect: "read" },
	// Pior caso: baixa URL arbitrária enviando por padrão os cookies do Chrome da VM; sem a sessão é só escrita na VM.
	sandbox_download: { effect: "credential", catalogEffect: "write_internal", effectForArgs: (args) => (args.use_browser_session === false ? "write_internal" : "credential") },
	sandbox_release: { effect: "write_internal", needsHuman: true },
	video_transcript: { effect: "read" },

	// Web
	web_search: { effect: "read" },
	web_extract: { effect: "read" },

	// Arquivos e imagens
	attachment_read: { effect: "read" },
	attachment_list: { effect: "read" },
	attachment_to_computer: { effect: "write_internal" },
	generate_image: { effect: "write_internal", ownCard: true, endsTurn: true },
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

	// Misc (`app_info` e `current_time` migraram para `defineTool`)
	preview_setup: { effect: "write_internal", ownCard: true },

	// Cofre
	secret_list: { effect: "read" },
	routine_webhook_info: { effect: "read" },
	secret_request: { effect: "credential", ownCard: true, endsTurn: true },
	login_fill: { effect: "credential", ownCard: true, endsTurn: true },

	// Skills
	skill_read: { effect: "read" },
	list_skills: { effect: "read", endsTurn: true },
	show_skill: { effect: "read", endsTurn: true },
	propose_skill: { effect: "write_internal", ownCard: true, needsHuman: true, endsTurn: true },
	delete_skill: { effect: "write_internal", needsHuman: true, endsTurn: true },
	propose_skill_change: { effect: "write_internal", ownCard: true, needsHuman: true, endsTurn: true },
	propose_skill_delete: { effect: "write_internal", ownCard: true, needsHuman: true, endsTurn: true },

	// E-mail do bot

	// Proativo
	schedule_followup: { effect: "write_internal" },
	list_followups: { effect: "read" },
	cancel_followup: { effect: "write_internal" },
	reschedule_followup: { effect: "write_internal" },
	suggest_routine: { effect: "write_internal" },
	// O destino é o próprio dono (push/aviso no app dele), não um terceiro: `write_internal` deixa a rotina avisar o dono.
	notify_user: { effect: "write_internal" },

	// Conectores
	propose_connector: { effect: "write_internal", ownCard: true, endsTurn: true },
	propose_api_connection: { effect: "write_internal", ownCard: true, endsTurn: true },
	propose_custom_mcp: { effect: "write_internal", ownCard: true, endsTurn: true },
	api_search: { effect: "read" },
	// Hoje o runtime só aceita operação GET/HEAD (api-connector/runtime.ts) e os args não trazem método: sem
	// `method`, é leitura. Se um dia houver escrita, ela traz o método e cai em write_external.
	api_call: {
		effect: "write_external",
		catalogEffect: "read",
		effectForArgs: (args) => (typeof args.method === "string" && !READ_HTTP_METHODS.has(args.method.trim().toUpperCase()) ? "write_external" : "read"),
	},
	mcp_tool_search: { effect: "read" },
	set_connector_tool_marks: { effect: "write_internal", needsHuman: true },
	github_list_repos: { effect: "read" },
	github_compare: { effect: "read" },

	// Rotinas

	// Bots e configuração
	propose_bot: { effect: "write_internal", ownCard: true, needsHuman: true, endsTurn: true },
	propose_profile_update: { effect: "write_internal", ownCard: true, endsTurn: true },
	send_to_bot: { effect: "write_external" },
	decide_bot_pending: { effect: "write_external" },
	set_primary_bot: { effect: "write_internal", ownCard: true },
	set_autonomy: { effect: "write_internal", needsHuman: true },
	set_engine: { effect: "write_internal", needsHuman: true },
	set_reasoning_effort: { effect: "write_internal" },
	delegate_task: { effect: "write_internal", needsHuman: true },
	propose_questionnaire: { effect: "write_internal", ownCard: true, needsHuman: true, endsTurn: true },

	// Planejamento
	research_note: { effect: "write_internal" },
	propose_plan: { effect: "write_internal", ownCard: true, endsTurn: true },
	update_task_list: { effect: "write_internal" },
	track_items: { effect: "write_internal" },

	// Painéis

	// Trabalho longo (motor v2)
	notebook_write: { effect: "write_internal" },
	notebook_read: { effect: "read" },
	delegate: { effect: "write_internal", needsHuman: true },

	// Sessão de código (resolvedor `devSessionResolver`)
	dev_session_start: { effect: "write_internal" },
	shell: { effect: "write_internal", ownCard: true },
	shell_output: { effect: "read", poll: true },
	shell_stdin: { effect: "write_internal" },
	shell_kill: { effect: "write_internal" },
	read_file: { effect: "read", ownCard: true },
	write_file: { effect: "write_internal", ownCard: true },
	edit_file: { effect: "write_internal", ownCard: true },
	list_files: { effect: "read" },
	grep: { effect: "read" },
	todo_write: { effect: "write_internal" },
	dev_environment_get: { effect: "read" },
	dev_environment_update: { effect: "write_internal" },
	request_secrets: { effect: "credential", ownCard: true },
	dev_pr_create: { effect: "write_external", ownCard: true },
	dev_pr_checkout: { effect: "write_internal" },
	dev_ci_status: { effect: "read", poll: true },
	dev_ci_logs: { effect: "read" },
	preview_start: { effect: "write_internal" },
	preview_stop: { effect: "write_internal" },
};

/** Efeito desta chamada: `effectForArgs` quando existe, senão o `effect` estático (pior caso). MCP/desconhecido: `undefined`. */
export function resolveToolEffect(name: string, args: Record<string, unknown>): ToolEffect | undefined {
	const meta = getToolMeta(name);
	return meta ? (meta.effectForArgs?.(args) ?? meta.effect) : undefined;
}

/** Só o metadado do registro (sem handler, grupo nem definição). */
function metaOf(registration: ToolRegistration): ToolMetaFields | undefined {
	if (!registration.effect) return undefined;
	const { effect, poll, endsTurn, needsHuman, ownCard, effectForArgs, catalogEffect } = registration;
	return {
		effect,
		...(poll ? { poll } : {}),
		...(endsTurn ? { endsTurn } : {}),
		...(needsHuman ? { needsHuman } : {}),
		...(ownCard ? { ownCard } : {}),
		...(catalogEffect ? { catalogEffect } : {}),
		...(effectForArgs ? { effectForArgs } : {}),
	};
}

/** Tool declarada com `defineTool`/`defineRawTool` (o metadado vem dela, não da tabela). */
export function isDefinedTool(name: string): boolean {
	return getToolRegistration(name)?.defined === true;
}

/** Metadado da tabela solta (fallback das tools que ainda não migraram para `defineTool`). */
export function tableToolMeta(name: string): ToolMetaFields | undefined {
	return Object.hasOwn(TOOL_META, name) ? TOOL_META[name] : undefined;
}

/**
 * Metadado da tool de nome fixo: vem do registro (`defineTool`); a tabela cobre o que ainda não migrou.
 * `undefined` para MCP e nome desconhecido (ver `mcpToolEffect`).
 */
export function getToolMeta(name: string): ToolMetaFields | undefined {
	const registered = getToolRegistration(name);
	return (registered && metaOf(registered)) ?? tableToolMeta(name);
}
/**
 * Efeito de uma tool de conector MCP. Deriva da classificação que já existe
 * (`isReadOnlyMcpTool` em `@workspace/shared`, anotações do servidor + marcas do usuário) em vez de criar outra: leitura = `read`; o resto = `write_external` (escrita em terceiro).
 */
export function mcpToolEffect(isReadOnly: boolean): ToolEffect {
	return isReadOnly ? "read" : "write_external";
}
