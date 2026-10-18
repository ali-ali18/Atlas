/**
 * Flag da camada de disciplina de execução (`ATLAS_EXECUTION_DISCIPLINE`).
 * Padrão: ligada. `off`/`0`/`false` restaura o comportamento anterior.
 */
export function executionDisciplineEnabled(
	env: Record<string, string | undefined> = process.env,
): boolean {
	const raw = env.ATLAS_EXECUTION_DISCIPLINE?.trim().toLowerCase();
	return !(raw === "off" || raw === "0" || raw === "false");
}

/**
 * Flag do subagente de navegador por item (V8, `ATLAS_BROWSER_SUBAGENTS`).
 * Padrão: desligada (a leitura item a item pelo pai basta quando o harness não mostra ganho).
 * `on`/`1`/`true` expõe `delegate_task` com `mode: "browser_item"`.
 */
export function browserSubagentsEnabled(
	env: Record<string, string | undefined> = process.env,
): boolean {
	const raw = env.ATLAS_BROWSER_SUBAGENTS?.trim().toLowerCase();
	return raw === "on" || raw === "1" || raw === "true";
}
