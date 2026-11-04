import type { ChatTool } from "@workspace/llm";
import { attachToolDefinitions } from "./registry/index.js";
import { allDefinedTools } from "./registry/handlers/index.js";

export { MCP_TOOL_SEARCH_TOOL, TOOL_SEARCH_WITH_BUILTINS } from "./mcp-tool-search.js";

/** Definições das tools declaradas com `defineTool`/`defineRawTool`, na ordem pedida. */
function defined(...names: string[]): ChatTool[] {
	return names.map((name) => {
		const definition = allDefinedTools().find((tool) => tool.name === name)?.definition;
		if (!definition) throw new Error(`Catálogo: a tool "${name}" não está declarada com defineTool.`);
		return definition;
	});
}

/**
 * Catálogo do v1/v2 (ordem importa: é a ordem do array enviado ao modelo). A definição de cada tool mora na família dela
 * (`registry/handlers/*.ts`, `defineTool`/`defineRawTool`); skills em Markdown: `skill_read` é núcleo e propose/delete ficam
 * no grupo adiado; `lesson_feedback` só entra no pedido quando o run tem lições (`lessonFeedbackEnabled`).
 */
export const COMPUTER_USE_TOOLS: ChatTool[] = defined(
	"propose_connector",
	"propose_custom_mcp",
	"screenshot",
	"navigate",
	"click",
	"type",
	"key",
	"scroll",
	"browser_snapshot",
	"browser_act",
	"browser_wait",
	"browser_read",
	"browser_find",
	"browser_tabs",
	"sandbox_shell",
	"sandbox_shell_wait",
	"sandbox_read",
	"sandbox_list",
	"sandbox_download",
	"sandbox_release",
	"video_transcript",
	"web_search",
	"web_extract",
	"memory",
	"session_search",
	"memory_search",
	"checkpoint_read",
	"artifact_read",
	"skill_read",
	"propose_skill",
	"delete_skill",
	"lesson_feedback",
	"app_info",
	"current_time",
	"preview_setup",
	"secret_list",
	"routine_webhook_info",
	"secret_request",
	"login_fill",
	"list_routines",
	"routine_control",
	"find_page_value",
	"routine_group",
	"github_list_repos",
	"github_compare",
	"propose_routine",
	"propose_questionnaire",
	"propose_profile_update",
);
attachToolDefinitions(COMPUTER_USE_TOOLS);
