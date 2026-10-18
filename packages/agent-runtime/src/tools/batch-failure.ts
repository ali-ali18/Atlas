/**
 * V5 — num lote de chamadas do mesmo passo, depois da primeira ação de
 * navegador/desktop que FALHOU, as ações seguintes não rodam: elas foram
 * planejadas sobre um estado de página que não existe mais (ex.: o clique
 * falhou e o próximo atua num ref que nunca abriu a seção).
 */
export const BATCH_SKIPPED_MESSAGE = "Not executed: an earlier action in this turn failed.";

/** Ações que mudam a página. Leituras e esperas seguem rodando. */
const PAGE_ACTION_TOOLS = new Set([
	"click",
	"type",
	"key",
	"scroll",
	"computer",
	"browser_click",
	"browser_type",
	"browser_act",
	"navigate",
]);

export function isPageActionTool(name: string): boolean {
	return PAGE_ACTION_TOOLS.has(name);
}

/** Estado do lote: `failed()` ao terminar uma tool; `shouldSkip()` antes de rodar a próxima. */
export function createBatchFailureGate() {
	let failed = false;
	return {
		shouldSkip: (name: string): boolean => failed && isPageActionTool(name),
		recordResult: (name: string, ok: boolean): void => {
			if (!ok && isPageActionTool(name)) failed = true;
		},
	};
}
