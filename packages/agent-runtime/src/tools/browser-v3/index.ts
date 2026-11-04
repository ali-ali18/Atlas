import type { ChatTool } from "@workspace/llm";
import type { DefinedTool } from "../define-tool.js";
import { browserActTool } from "./act.js";
import { browserNavigateTool } from "./navigate.js";
import { browserSnapshotTool } from "./snapshot.js";
import { browserTabsTool } from "./tabs.js";

export { browserActTool, browserNavigateTool, browserSnapshotTool, browserTabsTool };
export { derivePageState, formatPageState, type PageStateInfo, type PageStateName } from "./page-state.js";

/** As 4 tools do navegador do motor v3, na ordem do array (desenho 5). */
export const V3_BROWSER_TOOLS: readonly DefinedTool[] = [browserNavigateTool, browserSnapshotTool, browserActTool, browserTabsTool];

/**
 * Tools do navegador de hoje (v1/v2) que as 4 substituem no v3: `navigate`, ler, achar, esperar, tela, coordenadas e o
 * `computer` nativo. `sandbox_download` e `login_fill` ficam (outro assunto).
 */
export const V3_REPLACED_BROWSER_TOOLS: ReadonlySet<string> = new Set([
	"navigate",
	"screenshot",
	"click",
	"type",
	"key",
	"scroll",
	"browser_click",
	"browser_type",
	"browser_text",
	"browser_links",
	"browser_snapshot",
	"browser_act",
	"browser_wait",
	"browser_tabs",
	"browser_read",
	"browser_find",
	"computer",
]);

/** O handler do v3 para uma das 4 tools (o mesmo nome do v1/v2 no registro global não é usado no v3). */
export const V3_BROWSER_HANDLERS: ReadonlyMap<string, DefinedTool["handler"]> = new Map(V3_BROWSER_TOOLS.map((tool) => [tool.name, tool.handler]));

/**
 * O que o run precisa ter hoje para a tool nova entrar: respeita o filtro do run (ajudante, brief) e a ausência de VM.
 * Ex.: um run que só pode ler (`browser_read`) ganha `browser_snapshot` e não ganha `browser_act`.
 */
const REPLACES: Record<string, readonly string[]> = {
	browser_navigate: ["navigate"],
	browser_snapshot: ["browser_snapshot", "browser_read", "browser_find", "screenshot"],
	browser_act: ["browser_act", "browser_click", "browser_type"],
	browser_tabs: ["browser_tabs"],
};

/** Catálogo do v3 com VM: tira as tools de navegador de hoje e põe as 4 (cada uma só se o run tinha o equivalente). */
export function swapBrowserTools(natives: readonly ChatTool[]): ChatTool[] {
	const names = new Set(natives.map((tool) => tool.function.name));
	const kept = natives.filter((tool) => !V3_REPLACED_BROWSER_TOOLS.has(tool.function.name));
	const added = V3_BROWSER_TOOLS.filter((tool) => (REPLACES[tool.name] ?? []).some((old) => names.has(old))).map((tool) => tool.definition);
	return [...kept, ...added];
}
