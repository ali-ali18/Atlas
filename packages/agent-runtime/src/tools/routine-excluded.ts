import { FIND_PAGE_VALUE_TOOL_NAME } from "./find-page-value.js";
import { ROUTINE_CONTROL_TOOL_NAME } from "./routine-control.js";

/**
 * Tools que um run de rotina NÃO recebe (v1 e v2 usam a mesma lista: uma rotina só executa a instrução).
 * Gerir rotinas e achar valor em página são do chat; `memory` não escreve em rotina (a revisão pós-run decide);
 * `secret_request` pede uma pessoa (cartão de senha), e não há ninguém na conversa.
 */
export const ROUTINE_MANAGE_TOOLS: ReadonlySet<string> = new Set([
	"list_routines",
	"propose_routine",
	"routine_group",
	ROUTINE_CONTROL_TOOL_NAME,
	FIND_PAGE_VALUE_TOOL_NAME,
	"github_list_repos",
]);

export const ROUTINE_EXCLUDED_TOOLS: ReadonlySet<string> = new Set([...ROUTINE_MANAGE_TOOLS, "web_search", "web_extract", "memory", "secret_request"]);
