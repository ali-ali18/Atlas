/**
 * V6 — vocabulário do navegador: o que o modelo recebe e o que ainda executa.
 *
 * Oferecidas (grupo `browser`, <= 8): navigate, browser_read, browser_find,
 * browser_snapshot, browser_act, browser_wait, screenshot (+ `computer` no modo
 * nativo, que substitui o screenshot). Coordenadas de tela (click, type, key,
 * scroll) ficam no grupo `desktop`, sob demanda.
 *
 * Os nomes antigos continuam executando (checkpoints, replays e skills salvas
 * os citam), mas não vão na lista de tools. Um alias só roda se a tool
 * canônica dele está disponível no run.
 */

/** Nome antigo -> tool oferecida que o substitui. */
export const LEGACY_BROWSER_TOOLS: Readonly<Record<string, string>> = {
	browser_click: "browser_act",
	browser_type: "browser_act",
	browser_text: "browser_read",
	browser_links: "browser_read",
};

export const LEGACY_BROWSER_TOOL_NAMES: readonly string[] = Object.keys(LEGACY_BROWSER_TOOLS);

export function isLegacyBrowserTool(name: string): boolean {
	return Object.hasOwn(LEGACY_BROWSER_TOOLS, name);
}

export function canonicalBrowserTool(name: string): string {
	return isLegacyBrowserTool(name) ? LEGACY_BROWSER_TOOLS[name]! : name;
}

const warned = new Set<string>();

/** Log de depreciação, uma vez por nome e processo (sem texto de página nem args). */
export function warnLegacyBrowserTool(name: string, log: (line: string) => void = console.warn): void {
	if (!isLegacyBrowserTool(name) || warned.has(name)) return;
	warned.add(name);
	log(`[browser-vocabulary] deprecated tool name "${name}": use "${LEGACY_BROWSER_TOOLS[name]}"`);
}

/** Só para teste: zera o "já avisei". */
export function resetLegacyBrowserWarnings(): void {
	warned.clear();
}
