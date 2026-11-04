import type { ChatTool } from "@workspace/llm";
import { attachToolDefinitions } from "./registry/index.js";
import { ALL_DEFINED_TOOLS } from "./registry/handlers/index.js";
import { APP_INFO_TOOL } from "./app-info.js";
import { CURRENT_TIME_TOOL } from "./current-time.js";
import { PREVIEW_SETUP_TOOL } from "./preview-setup/tool.js";
import { LOGIN_FILL_TOOL, ROUTINE_WEBHOOK_INFO_TOOL, SECRET_LIST_TOOL, SECRET_REQUEST_TOOL } from "./vault-tools.js";

export { MCP_TOOL_SEARCH_TOOL, TOOL_SEARCH_WITH_BUILTINS } from "./mcp-tool-search.js";

/** Definições das tools já declaradas com `defineTool`/`defineRawTool`, na ordem pedida. */
function defined(...names: string[]): ChatTool[] {
	return names.map((name) => {
		const definition = ALL_DEFINED_TOOLS.find((tool) => tool.name === name)?.definition;
		if (!definition) throw new Error(`Catálogo: a tool "${name}" não está declarada com defineTool.`);
		return definition;
	});
}

export const COMPUTER_USE_TOOLS: ChatTool[] = [
	...defined("propose_connector"),
	...defined("propose_custom_mcp"),
	...defined("screenshot"),
	...defined("navigate"),
	...defined("click"),
	...defined("type"),
	...defined("key"),
	...defined("scroll"),
	...defined("browser_snapshot", "browser_act", "browser_wait"),
	...defined("browser_read", "browser_find"),
	...defined("browser_tabs"),
	...defined("sandbox_shell", "sandbox_shell_wait", "sandbox_read", "sandbox_list", "sandbox_download"),
	...defined("sandbox_release"),
	...defined("video_transcript"),
	...defined("web_search"),
	...defined("web_extract"),
	...defined("memory"),
	...defined("session_search"),
	...defined("memory_search"),
	...defined("checkpoint_read"),
	...defined("artifact_read"),
	// Skills em Markdown (K1): `skill_read` é núcleo; propose/delete ficam no grupo adiado.
	...defined("skill_read"),
	...defined("propose_skill", "delete_skill"),
	// Lições do bot: só entra no pedido quando o run tem lições (ver `lessonFeedbackEnabled`).
	...defined("lesson_feedback"),
	APP_INFO_TOOL,
	CURRENT_TIME_TOOL,
	PREVIEW_SETUP_TOOL,
	SECRET_LIST_TOOL,
	ROUTINE_WEBHOOK_INFO_TOOL,
	SECRET_REQUEST_TOOL,
	LOGIN_FILL_TOOL,
	...defined("list_routines"),
	...defined("routine_control"),
	...defined("find_page_value"),
	...defined("routine_group"),
	...defined("github_list_repos"),
	...defined("github_compare"),
	...defined("propose_routine"),
	...defined("propose_questionnaire"),
	...defined("propose_profile_update"),
];
attachToolDefinitions(COMPUTER_USE_TOOLS);
